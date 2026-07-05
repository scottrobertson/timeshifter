import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Config } from "./config.js";
import type { Channel, EpgProgram, RecordingWindow } from "./source.js";

/**
 * Format a server-local "YYYY-MM-DD HH:MM:SS" string as the timeshift URL time
 * "YYYY-MM-DD:HH-MM". The endpoint interprets the URL time in the server's own
 * timezone (verified: a future-as-UTC but past-as-local request returns content,
 * not a 404), and the EPG start string is already server-local, so no conversion.
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
 * Shift a server-local "YYYY-MM-DD HH:MM:SS" string by some minutes. We parse the
 * wall-clock components as if UTC, do the arithmetic, then format back with UTC
 * getters, which keeps hour/day rollovers correct without needing the timezone.
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
 * Recording window for a program, with padding in minutes (negative records less).
 * Caps the end at "now" so a still-airing show doesn't ask for footage that
 * doesn't exist yet.
 */
export function recordingWindow(
  program: EpgProgram,
  paddingBefore: number,
  paddingAfter: number,
): RecordingWindow {
  const startMs = program.start.getTime() - paddingBefore * 60_000;
  const endMs = Math.min(program.end.getTime() + paddingAfter * 60_000, Date.now());
  const minutes = Math.max(1, Math.ceil((endMs - startMs) / 60_000));
  const startLocal = shiftLocal(program.startLocal, -paddingBefore);
  return { startLocal, endLocal: shiftLocal(startLocal, minutes), minutes };
}

export function buildTimeshiftUrl(
  config: Config,
  streamId: number,
  startLocal: string,
  minutes: number,
): string {
  const startTime = formatStartForUrl(startLocal);
  const { baseUrl, username, password } = config;

  if (config.timeshiftMode === "php") {
    const url = new URL(`${baseUrl}/streaming/timeshift.php`);
    url.searchParams.set("username", username);
    url.searchParams.set("password", password);
    url.searchParams.set("stream", String(streamId));
    url.searchParams.set("start", startTime);
    url.searchParams.set("duration", String(minutes));
    return url.toString();
  }

  // Path style: /timeshift/user/pass/duration/start/streamId.ts
  return `${baseUrl}/timeshift/${encodeURIComponent(username)}/${encodeURIComponent(
    password,
  )}/${minutes}/${startTime}/${streamId}.ts`;
}

/** Remove each strip string from the title and tidy up the spaces left behind. */
export function stripTitle(title: string, strip: string[]): string {
  let result = title;
  for (const s of strip) {
    result = result.split(s).join("");
  }
  return result.replace(/\s+/g, " ").trim();
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
  template: string = config.filenameTemplate,
  filenameStrip: string[] = config.filenameStrip,
): string {
  // The EPG start string comes straight from the panel, so check the format
  // instead of slicing blind. A bad format would break the catchup URL too,
  // so failing here beats recording garbage to a garbage filename.
  const parts = program.startLocal.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
  if (!parts) {
    throw new Error(`Unexpected EPG start format: "${program.startLocal}"`);
  }
  const [, year, month, day, hour, minute] = parts;
  const date = `${year}-${month}-${day}`;
  const time = `${hour}-${minute}`;

  // Free-text values get sanitised; the date/time/ext tokens are already safe.
  const tokens: Record<string, string> = {
    channel: sanitize(channel.name),
    title: sanitize(stripTitle(program.title, filenameStrip)),
    date,
    time,
    datetime: `${date}_${time}`,
    year,
    month,
    day,
    ext: "ts",
  };

  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
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
 * Stream a URL straight to a file with a plain GET, showing progress. We avoid
 * Range requests: some CDNs serve a normal GET fine but drip-feed Range
 * requests, so any resume-by-byte-offset crawls. Returns the byte counts.
 */
export async function streamToFile(
  config: Config,
  url: string,
  destPath: string,
): Promise<{ bytesDownloaded: number; expectedBytes: number | null }> {
  await mkdir(path.dirname(destPath), { recursive: true });

  const headers: Record<string, string> = {};
  if (config.userAgent) headers["User-Agent"] = config.userAgent;

  const response = await fetch(url, { headers });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  const expectedBytes = Number(response.headers.get("content-length")) || null;

  // On a TTY we redraw a progress bar in place a few times a second. Without one
  // (e.g. Docker logs), \r-redraws never flush, so we print a plain line less
  // often instead so progress still shows up.
  const tty = Boolean(process.stdout.isTTY);
  const renderEvery = tty ? 250 : 5000;

  const startedAt = Date.now();
  let bytesDownloaded = 0;
  let lastRender = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesDownloaded += chunk.length;
      const now = Date.now();
      if (now - lastRender >= renderEvery) {
        renderDownloadProgress(bytesDownloaded, expectedBytes, startedAt, tty);
        lastRender = now;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
      counter,
      createWriteStream(destPath),
    );
  } catch (err) {
    // The server tends to close a touch before the advertised length. If we got
    // essentially all of it that's fine; only a real shortfall is a failure.
    if (!(expectedBytes && bytesDownloaded >= expectedBytes * 0.99)) {
      clearProgressLine();
      throw err;
    }
  }
  // On a TTY, draw the final frame and close the redraw line. Without one, the
  // "Downloaded" summary that follows is enough, so skip a near-duplicate line.
  if (tty) {
    renderDownloadProgress(bytesDownloaded, expectedBytes, startedAt, tty);
    process.stdout.write("\n");
  }

  return { bytesDownloaded, expectedBytes };
}

/**
 * Remux a .ts in place with ffmpeg, copying the streams but rebuilding the
 * timestamps. The raw timeshift .ts has discontinuous timestamps (the provider
 * stitches archive segments), which leaves the file unseekable and reporting a
 * nonsense duration. This rewrites them so it seeks correctly. No re-encode.
 */
function remux(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-loglevel", "error", "-nostats",
      "-fflags", "+genpts",
      "-i", input,
      "-c", "copy",
      "-avoid_negative_ts", "make_zero",
      "-muxpreload", "0", "-muxdelay", "0",
      "-f", "mpegts", // the temp file has no .ts extension to infer from
      "-y", output,
    ];
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("ffmpeg not found. Install it first (e.g. `brew install ffmpeg`)."));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed${stderr.trim() ? `: ${stderr.trim()}` : ` (code ${code})`}`));
    });
  });
}

/**
 * Wipe the current terminal line, e.g. an in-place progress bar or spinner, so
 * the next message starts clean. A no-op when output isn't a terminal.
 */
function clearProgressLine(): void {
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
}

/**
 * A small spinner for a step of unknown length. Returns a finish function that
 * clears the spinner; the line that follows (e.g. "saved") is the done signal.
 */
function startStep(label: string): () => void {
  if (!process.stdout.isTTY) {
    process.stdout.write(`  ${label}…\n`);
    return () => {};
  }
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".split("");
  let i = 0;
  process.stdout.write(`  ${frames[0]} ${label}…`);
  const timer = setInterval(() => {
    i = (i + 1) % frames.length;
    process.stdout.write(`\r  ${frames[i]} ${label}…`);
  }, 80);
  return () => {
    clearInterval(timer);
    clearProgressLine();
  };
}

/**
 * Download a timeshift recording and clean it up. The raw .ts is downloaded
 * directly (a plain GET, which the CDN serves reliably), then remuxed so the
 * timestamps are sane and it seeks properly.
 *
 * The work files use non-media extensions (.part/.remux), which media servers
 * don't import (the same convention download tools rely on), and the finished
 * file is put in place with an atomic rename, so a library only ever sees the
 * complete .ts appear, never a partial one.
 */
export async function download(
  config: Config,
  url: string,
  filename: string,
): Promise<DownloadResult> {
  const outputPath = path.join(config.downloadDir, filename);
  const dir = path.dirname(outputPath);
  const base = path.basename(outputPath);
  const downloadPath = path.join(dir, `.${base}.part`);
  const remuxPath = path.join(dir, `.${base}.remux`);

  const { bytesDownloaded, expectedBytes } = await streamToFile(config, url, downloadPath);

  if (expectedBytes && bytesDownloaded < expectedBytes * 0.99) {
    console.log(
      `  ⚠️  Expected about ${(expectedBytes / 1e9).toFixed(2)} GB, so this may be incomplete.`,
    );
  }

  const finishRemux = startStep("Processing the recording");
  try {
    await remux(downloadPath, remuxPath);
  } catch (err) {
    clearProgressLine();
    await rm(downloadPath, { force: true });
    await rm(remuxPath, { force: true });
    throw err;
  }
  finishRemux();

  await rm(downloadPath, { force: true });
  await rename(remuxPath, outputPath); // atomic: the library sees it appear complete

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
  tty: boolean,
): void {
  const gb = (n: number) => (n / 1e9).toFixed(2);
  const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
  const speed = downloaded / elapsed; // bytes/sec
  const speedText = `${(speed / 1e6).toFixed(0)} MB/s`;

  let line: string;
  if (!total) {
    line = `${gb(downloaded)} GB  ${speedText}`;
  } else {
    const fraction = Math.min(1, downloaded / total);
    const width = 28;
    const filled = Math.round(fraction * width);
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    const pct = String(Math.floor(fraction * 100)).padStart(3);
    const eta = speed > 0 ? formatDuration((total - downloaded) / speed) : "—";
    line = `${bar} ${pct}%  ${gb(downloaded)}/${gb(total)} GB  ${speedText}  ETA ${eta}`;
  }

  // TTY: redraw in place. Otherwise: a plain line that actually flushes to logs.
  process.stdout.write(tty ? `\r  ${line}   ` : `  ${line}\n`);
}

/** Set a file's modified (and access) time, e.g. to when a program aired. */
export async function setFileTime(filePath: string, when: Date): Promise<void> {
  await utimes(filePath, when, when);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Format a Date as a local "YYYY-MM-DD HH:MM:SS", for the .nfo dateadded. */
function formatNfoDate(when: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`
  );
}

/** The .nfo sidecar path for a recording: same name, .nfo extension. */
export function nfoPathFor(outputPath: string): string {
  const dir = path.dirname(outputPath);
  const base = path.basename(outputPath, path.extname(outputPath));
  return path.join(dir, `${base}.nfo`);
}

// Many EPGs prefix the description with the season and episode, e.g.
// "S21 E8 I Don't Got Any\n...". Pulled out into proper fields below.
const SEASON_EPISODE_RE = /^S(\d+)\s*E(\d+)\b\s*/i;

/**
 * Build the .nfo XML for a recording: an <episodedetails> sidecar that media
 * servers (Emby, Jellyfin, Kodi) read to get the title, plot and air date
 * instead of guessing from the filename. `dateAdded` is a preformatted
 * "YYYY-MM-DD HH:MM:SS" string so it stays stable across refreshes.
 */
export function buildNfo(program: EpgProgram, dateAdded: string): string {
  const date = program.startLocal.slice(0, 10); // YYYY-MM-DD
  const runtime = Math.max(
    0,
    Math.round((program.end.getTime() - program.start.getTime()) / 60_000),
  );

  // If the description starts with a season/episode marker, lift it into proper
  // fields and drop the prefix from the plot so it isn't repeated.
  const se = program.description.match(SEASON_EPISODE_RE);
  const plot = se ? program.description.slice(se[0].length) : program.description;

  const lines = [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<episodedetails>`,
    `  <title>${escapeXml(program.title)}</title>`,
  ];
  if (se) {
    lines.push(`  <season>${Number(se[1])}</season>`);
    lines.push(`  <episode>${Number(se[2])}</episode>`);
  }
  lines.push(
    `  <plot>${escapeXml(plot)}</plot>`,
    `  <aired>${date}</aired>`,
    `  <premiered>${date}</premiered>`,
    `  <runtime>${runtime}</runtime>`,
    `  <dateadded>${dateAdded}</dateadded>`,
    `</episodedetails>`,
  );
  return lines.join("\n") + "\n";
}

export interface NfoSyncResult {
  status: "created" | "updated" | "unchanged";
  path: string;
}

const DATE_ADDED_RE = /<dateadded>(.*?)<\/dateadded>/;

/**
 * Write or refresh a recording's .nfo sidecar. Reuses the existing dateadded so
 * a refresh doesn't churn the timestamp, and only rewrites when the content
 * actually changed, so it's cheap to call on every poll.
 */
export async function syncNfo(
  program: EpgProgram,
  outputPath: string,
  now: Date,
): Promise<NfoSyncResult> {
  const nfoPath = nfoPathFor(outputPath);

  let existing: string | null;
  try {
    existing = await readFile(nfoPath, "utf8");
  } catch {
    existing = null;
  }

  const dateAdded = existing?.match(DATE_ADDED_RE)?.[1] ?? formatNfoDate(now);
  const contents = buildNfo(program, dateAdded);
  if (existing === contents) return { status: "unchanged", path: nfoPath };

  await writeFile(nfoPath, contents, "utf8");
  return { status: existing === null ? "created" : "updated", path: nfoPath };
}

/** The .edl sidecar path for a recording: same name, .edl extension. */
export function edlPathFor(outputPath: string): string {
  const dir = path.dirname(outputPath);
  const base = path.basename(outputPath, path.extname(outputPath));
  return path.join(dir, `${base}.edl`);
}

// comskip only writes the .edl when output_edl is on, and its default also
// litters .txt/.log files next to the recording, so we turn those off. Detection
// tuning stays at comskip's defaults; point COMSKIP_INI at your own file to change it.
const DEFAULT_COMSKIP_INI = `[Main Settings]
output_edl=1
output_txt=0
output_default=0
`;

/** The comskip.ini to run with: the user's COMSKIP_INI, or a temp default. */
async function comskipIni(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const custom = process.env.COMSKIP_INI;
  if (custom) return { path: custom, cleanup: async () => {} };
  const dir = await mkdtemp(path.join(tmpdir(), "comskip-"));
  const iniPath = path.join(dir, "comskip.ini");
  await writeFile(iniPath, DEFAULT_COMSKIP_INI);
  return { path: iniPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Run comskip on a recording, writing the .edl next to it. Reports its progress
 * percentage via onProgress, and resolves with any non-progress messages (for
 * the error when no .edl comes out).
 */
function runComskip(
  input: string,
  iniPath: string,
  onProgress: (percent: number) => void,
): Promise<string> {
  // Override with COMSKIP_PATH; the Docker image points it at the bundled build.
  const bin = process.env.COMSKIP_PATH || "comskip";
  const dir = path.dirname(input);
  return new Promise((resolve, reject) => {
    // -v 1 makes comskip print its progress percentage (to stderr) even when its
    // output isn't a terminal; without it there's no progress at all in the logs.
    const child = spawn(bin, ["-v", "1", `--ini=${iniPath}`, `--output=${dir}`, input], {
      cwd: dir,
      stdio: ["ignore", "ignore", "pipe"],
    });

    // comskip updates progress in place with \r, so split on that too. Lines
    // ending in a percentage are progress; anything else is a real message.
    let messages = "";
    let buffer = "";
    const take = (segment: string): void => {
      const percent = segment.match(/(\d+)%\s*$/);
      if (percent) onProgress(Number(percent[1]));
      else if (segment.trim()) messages += `${segment.trim()}\n`;
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      buffer += chunk;
      const segments = buffer.split(/[\r\n]/);
      buffer = segments.pop() ?? "";
      segments.forEach(take);
    });

    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("comskip not found. Install it or set COMSKIP_PATH."));
      } else {
        reject(err);
      }
    });
    // comskip exits non-zero just for "no commercials found", so the exit code
    // isn't a failure signal. ensureEdl checks whether the .edl was written.
    child.on("close", () => {
      take(buffer);
      resolve(messages.trim());
    });
  });
}

export interface EdlResult {
  status: "created" | "exists";
  path: string;
  /** How many commercial breaks comskip found (one .edl line each). */
  commercials: number;
}

/** Count the commercial breaks in an .edl. Comskip writes one line per break. */
async function countCommercials(edlPath: string): Promise<number> {
  const contents = await readFile(edlPath, "utf8");
  return contents.split("\n").filter((line) => line.trim()).length;
}

/**
 * Make sure a recording has its comskip .edl. Comskip takes minutes, so we only
 * run it when the .edl is missing; if one is already there we leave it. A
 * commercial-free recording still gets an empty .edl, so it isn't reprocessed
 * every poll. Throws if comskip wrote no .edl, so callers can treat it as
 * non-fatal, like the .nfo.
 */
export async function ensureEdl(outputPath: string): Promise<EdlResult> {
  const edlPath = edlPathFor(outputPath);
  if (existsSync(edlPath)) {
    return { status: "exists", path: edlPath, commercials: await countCommercials(edlPath) };
  }

  // On a TTY, redraw the percentage in place. Without one (e.g. Docker logs)
  // \r-redraws never flush, so print each 10% on its own line instead.
  const tty = Boolean(process.stdout.isTTY);
  const label = "Detecting commercials with comskip";
  process.stdout.write(tty ? `  ${label}…` : `  ${label}…\n`);
  let printed = 0;
  const onProgress = (percent: number): void => {
    if (tty) {
      process.stdout.write(`\r  ${label}… ${percent}%   `);
    } else if (percent >= printed + 10 && percent < 100) {
      printed = percent - (percent % 10);
      process.stdout.write(`    ${percent}%\n`);
    }
  };

  const ini = await comskipIni();
  let messages = "";
  try {
    messages = await runComskip(outputPath, ini.path, onProgress);
  } finally {
    if (tty) clearProgressLine();
    await ini.cleanup();
    // The -v we pass for progress makes comskip drop a .log next to the
    // recording; we only want the .edl, so bin it.
    const base = path.basename(outputPath, path.extname(outputPath));
    await rm(path.join(path.dirname(outputPath), `${base}.log`), { force: true });
  }

  if (!existsSync(edlPath)) {
    throw new Error(`comskip produced no .edl${messages ? `: ${messages}` : ""}`);
  }
  return { status: "created", path: edlPath, commercials: await countCommercials(edlPath) };
}
