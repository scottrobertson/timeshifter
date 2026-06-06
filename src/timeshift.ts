import { createWriteStream } from "node:fs";
import { mkdir, utimes } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
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
    ext: "ts",
  };

  return config.filenameTemplate.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in tokens ? tokens[key]! : match,
  );
}

export interface DownloadResult {
  outputPath: string;
  bytesDownloaded: number;
  /** From the Content-Length header, or null if the server didn't send one. */
  expectedBytes: number | null;
}

/**
 * Download the timeshift recording straight to a file with a plain GET. The
 * server already trims the .ts to the requested duration, so there's nothing to
 * transcode. We deliberately avoid Range requests: some CDNs serve a normal GET
 * fine but drip-feed Range requests, so any resume-by-byte-offset crawls.
 */
export async function download(
  config: Config,
  url: string,
  filename: string,
): Promise<DownloadResult> {
  const outputPath = path.join(config.downloadDir, filename);
  // dirname (not just downloadDir) so a template with subfolders still works.
  await mkdir(path.dirname(outputPath), { recursive: true });

  const headers: Record<string, string> = {};
  if (config.userAgent) headers["User-Agent"] = config.userAgent;

  const response = await fetch(url, { headers });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  const expectedBytes = Number(response.headers.get("content-length")) || null;

  const startedAt = Date.now();
  let bytesDownloaded = 0;
  let lastRender = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesDownloaded += chunk.length;
      const now = Date.now();
      if (now - lastRender >= 250) {
        renderDownloadProgress(bytesDownloaded, expectedBytes, startedAt);
        lastRender = now;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
      counter,
      createWriteStream(outputPath),
    );
  } catch (err) {
    // The server tends to close a touch before the advertised length. If we got
    // essentially all of it that's fine; only a real shortfall is a failure.
    if (!(expectedBytes && bytesDownloaded >= expectedBytes * 0.99)) {
      throw err;
    }
  }
  renderDownloadProgress(bytesDownloaded, expectedBytes, startedAt);
  process.stdout.write("\n");

  return { outputPath, bytesDownloaded, expectedBytes };
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function renderDownloadProgress(
  downloaded: number,
  total: number | null,
  startedAt: number,
): void {
  const gb = (n: number) => (n / 1e9).toFixed(2);
  const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
  const speed = downloaded / elapsed; // bytes/sec
  const speedText = `${(speed / 1e6).toFixed(0)} MB/s`;

  if (!total) {
    process.stdout.write(`\r  ${gb(downloaded)} GB  ${speedText}   `);
    return;
  }

  const fraction = Math.min(1, downloaded / total);
  const width = 28;
  const filled = Math.round(fraction * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const pct = String(Math.floor(fraction * 100)).padStart(3);
  const eta = speed > 0 ? formatDuration((total - downloaded) / speed) : "—";

  process.stdout.write(
    `\r  ${bar} ${pct}%  ${gb(downloaded)}/${gb(total)} GB  ${speedText}  ETA ${eta}   `,
  );
}

/** Set a file's modified (and access) time, e.g. to when a program aired. */
export async function setFileTime(filePath: string, when: Date): Promise<void> {
  await utimes(filePath, when, when);
}
