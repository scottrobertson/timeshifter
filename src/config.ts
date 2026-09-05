import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configPath, readTextFile } from "./files.js";

export type TimeshiftMode = "path" | "php";

export interface Config {
  baseUrl: string;
  username: string;
  password: string;
  downloadDir: string;
  userAgent: string | undefined;
  timeshiftMode: TimeshiftMode;
  /** Minutes to start recording before the program's scheduled start. */
  paddingBefore: number;
  /** Minutes to keep recording after the program's scheduled end. */
  paddingAfter: number;
  /** Output filename template. Supports {channel} {title} {date} {time} {datetime} {year} {month} {day} {ext}. Month and day are zero-padded (03, not 3). */
  filenameTemplate: string;
  /** Strings to remove from the title when building the filename, e.g. a "live" badge the EPG tacks on. Only affects the filename. */
  filenameStrip: string[];
  /** Set the downloaded file's modified time to when the program aired. */
  setAiredTime: boolean;
  /** Write a Kodi/Emby/Jellyfin .nfo metadata file next to each recording. */
  writeNfo: boolean;
  /** Run comskip on each recording to generate a .edl commercial-skip file. */
  comskip: boolean;
}

export function defaultConfigFile(): string {
  return configPath("config.json");
}

/** Enough to start from. Everything else has a default and is documented in the README. */
const STARTER_CONFIG = {
  url: "http://my-provider.com:8080",
  username: "your-username",
  password: "your-password",
  downloadDir: "/catchup",
};

const DEFAULT_FILENAME_TEMPLATE = "{channel} - {title} - {datetime}.{ext}";
// Many panels drop connections from clients that don't look like a real player,
// especially on long downloads. A VLC user agent is a safe default.
const DEFAULT_USER_AGENT = "VLC/3.0.18 LibVLC/3.0.18";

function fail(detail: string): never {
  throw new Error(`config.json ${detail}`);
}

/**
 * There's nothing to run without a config, so write a starter one to fill in
 * rather than making someone find the example first.
 */
function missingConfig(file: string): never {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(STARTER_CONFIG, null, 2)}\n`, { flag: "wx" });
  } catch {
    // Nowhere to write it (a read-only mount, say), so just say it's missing.
    throw new Error(
      `Couldn't find ${file}. Copy config.example.json to config.json and fill in your provider details.`,
    );
  }
  throw new Error(`${file} didn't exist, so a starter one has been written. Fill it in and run again.`);
}

/** Read and JSON-parse the config file, with friendly errors. Shared with subscriptions. */
export function readConfigFile(file = defaultConfigFile()): Record<string, unknown> {
  if (!existsSync(file)) missingConfig(file);
  const raw = readTextFile(file);

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    fail(`isn't valid JSON: ${(err as Error).message}`);
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    fail(`must be a JSON object.`);
  }
  return data as Record<string, unknown>;
}

function requiredString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== "string" || !value.trim()) {
    fail(`is missing a "${field}". Copy config.example.json and fill in your provider details.`);
  }
  return value.trim();
}

function optionalString(obj: Record<string, unknown>, field: string, fallback: string): string {
  const value = obj[field];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim()) {
    fail(`has a "${field}" that must be a non-empty string.`);
  }
  return value.trim();
}

function optionalStringArray(obj: Record<string, unknown>, field: string): string[] {
  const value = obj[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v)) {
    fail(`has a "${field}" that must be an array of non-empty strings.`);
  }
  return value as string[];
}

function optionalInt(obj: Record<string, unknown>, field: string, fallback: number): number {
  const value = obj[field];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`has a "${field}" that must be a whole number of minutes.`);
  }
  return value;
}

function optionalBoolean(obj: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = obj[field];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    fail(`has a "${field}" that must be true or false.`);
  }
  return value;
}

export function loadConfig(file = defaultConfigFile()): Config {
  const obj = readConfigFile(file);

  const timeshiftMode = (optionalString(obj, "timeshiftMode", "path")) as TimeshiftMode;
  if (timeshiftMode !== "path" && timeshiftMode !== "php") {
    fail(`has a "timeshiftMode" that must be "path" or "php", got "${timeshiftMode}".`);
  }

  return {
    baseUrl: requiredString(obj, "url").replace(/\/+$/, ""),
    username: requiredString(obj, "username"),
    password: requiredString(obj, "password"),
    downloadDir: requiredString(obj, "downloadDir"),
    userAgent: optionalString(obj, "userAgent", DEFAULT_USER_AGENT),
    timeshiftMode,
    paddingBefore: optionalInt(obj, "paddingBefore", 0),
    paddingAfter: optionalInt(obj, "paddingAfter", 0),
    filenameTemplate: optionalString(obj, "filenameTemplate", DEFAULT_FILENAME_TEMPLATE),
    filenameStrip: optionalStringArray(obj, "filenameStrip"),
    setAiredTime: optionalBoolean(obj, "setAiredTime", true),
    writeNfo: optionalBoolean(obj, "writeNfo", true),
    comskip: optionalBoolean(obj, "comskip", false),
  };
}
