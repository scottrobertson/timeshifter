import { spawn } from "node:child_process";
import { mkdir, utimes } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import type { Channel, EpgProgram, RecordingWindow } from "./source.js";

/**
 * Xtream timeshift wants the start time in the server's local timezone,
 * formatted "YYYY-MM-DD:HH-MM". The EPG `start` string is already in server
 * local time ("YYYY-MM-DD HH:MM:SS"), so we reformat it directly and sidestep
 * any timezone guessing.
 */
export function formatStartForUrl(startLocal: string): string {
  const [date, time] = startLocal.split(" ");
  if (!date || !time) {
    throw new Error(`Unexpected EPG start format: "${startLocal}"`);
  }
  const [hour, minute] = time.split(":");
  return `${date}:${hour}-${minute}`;
}

/**
 * Shift a server-local "YYYY-MM-DD HH:MM:SS" string by some minutes. We parse
 * the wall-clock components as if they were UTC, do the arithmetic, then format
 * back with UTC getters. That keeps hour/day rollovers correct without ever
 * touching the real timezone (which we don't need to know).
 */
function shiftLocal(startLocal: string, minutesDelta: number): string {
  const [datePart, timePart] = startLocal.split(" ");
  if (!datePart || !timePart) {
    throw new Error(`Unexpected EPG start format: "${startLocal}"`);
  }
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, mi, s] = timePart.split(":").map(Number);
  const ms = Date.UTC(y!, mo! - 1, d!, h!, mi!, s ?? 0) + minutesDelta * 60_000;
  const dt = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ` +
    `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`
  );
}

/**
 * Recording window for a program, including padding. Caps the end at "now" so a
 * still-airing show doesn't ask for footage that doesn't exist yet.
 */
export function recordingWindow(
  config: Config,
  program: EpgProgram,
): RecordingWindow {
  const startMs = program.start.getTime() - config.paddingBefore * 60_000;
  const endMs = Math.min(
    program.end.getTime() + config.paddingAfter * 60_000,
    Date.now(),
  );
  const minutes = Math.max(1, Math.ceil((endMs - startMs) / 60_000));
  return {
    startLocal: shiftLocal(program.startLocal, -config.paddingBefore),
    minutes,
  };
}

export function buildTimeshiftUrl(
  config: Config,
  streamId: number,
  startLocal: string,
  minutes: number,
): string {
  const start = formatStartForUrl(startLocal);
  const { baseUrl, username, password } = config;

  if (config.timeshiftMode === "php") {
    const url = new URL(`${baseUrl}/streaming/timeshift.php`);
    url.searchParams.set("username", username);
    url.searchParams.set("password", password);
    url.searchParams.set("stream", String(streamId));
    url.searchParams.set("start", start);
    url.searchParams.set("duration", String(minutes));
    return url.toString();
  }

  // Path style: /timeshift/user/pass/duration/start/streamId.ts
  return `${baseUrl}/timeshift/${encodeURIComponent(username)}/${encodeURIComponent(
    password,
  )}/${minutes}/${start}/${streamId}.ts`;
}

function sanitize(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function outputFilename(
  config: Config,
  channel: Channel,
  program: EpgProgram,
): string {
  const date = program.startLocal.slice(0, 10); // YYYY-MM-DD
  const time = program.startLocal.slice(11, 16).replace(":", "-"); // HH-MM

  // Free-text values get sanitised; the date/time/ext tokens are already safe.
  const tokens: Record<string, string> = {
    channel: sanitize(channel.name),
    title: sanitize(program.title),
    date,
    time,
    datetime: `${date}_${time}`,
    ext: config.outputFormat,
  };

  return config.filenameTemplate.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in tokens ? tokens[key]! : match,
  );
}

export interface DownloadResult {
  outputPath: string;
}

/** Records the timeshift stream with ffmpeg for the program's duration. */
export async function download(
  config: Config,
  url: string,
  minutes: number,
  filename: string,
): Promise<DownloadResult> {
  const outputPath = path.join(config.downloadDir, filename);
  // dirname (not just downloadDir) so a template with subfolders still works.
  await mkdir(path.dirname(outputPath), { recursive: true });
  const seconds = minutes * 60;

  // Both modes hand ffmpeg's output straight to the terminal. Verbose shows
  // everything; clean mode stays quiet apart from ffmpeg's own progress line
  // (-stats prints regardless of log level), which hides the harmless TS noise.
  const args = config.verbose
    ? ["-hide_banner", "-loglevel", "info", "-stats"]
    : ["-hide_banner", "-loglevel", "quiet", "-stats"];

  if (config.userAgent) args.push("-user_agent", config.userAgent);
  // Survive brief network hiccups during the recording.
  args.push(
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-i", url,
    "-t", String(seconds),
    "-c", "copy",
  );
  if (config.outputFormat === "mp4") {
    // Needed so AAC from a TS stream is valid inside MP4.
    args.push("-bsf:a", "aac_adts_to_asc");
  }
  args.push("-y", outputPath);

  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: "inherit" });
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("ffmpeg not found. Install it first (e.g. `brew install ffmpeg`)."));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });

  return { outputPath };
}

/**
 * Reads the recorded file's duration with ffprobe. Returns seconds, or null if
 * ffprobe isn't available or the duration can't be read. Note: for raw .ts the
 * reported duration is approximate, since timestamp discontinuities throw it off.
 */
export async function probeDurationSeconds(
  filePath: string,
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const seconds = Number.parseFloat(out.trim());
      resolve(Number.isFinite(seconds) ? seconds : null);
    });
  });
}

/** Set a file's modified (and access) time, e.g. to when a program aired. */
export async function setFileTime(filePath: string, when: Date): Promise<void> {
  await utimes(filePath, when, when);
}
