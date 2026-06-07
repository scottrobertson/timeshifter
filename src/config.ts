import { readFileSync } from "node:fs";

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
  /** Output filename template. Supports {channel} {title} {date} {time} {datetime} {ext}. */
  filenameTemplate: string;
  /** Set the downloaded file's modified time to when the program aired. */
  setAiredTime: boolean;
  /** Write a Kodi/Emby/Jellyfin .nfo metadata file next to each recording. */
  writeNfo: boolean;
}

export const DEFAULT_CONFIG_FILE = "config.json";

const DEFAULT_FILENAME_TEMPLATE = "{channel} - {title} - {datetime}.{ext}";
// Many panels drop connections from clients that don't look like a real player,
// especially on long downloads. A VLC user agent is a safe default.
const DEFAULT_USER_AGENT = "VLC/3.0.18 LibVLC/3.0.18";

function fail(detail: string): never {
  throw new Error(`config.json ${detail}`);
}

/** Read and JSON-parse the config file, with friendly errors. Shared with subscriptions. */
export function readConfigFile(file = DEFAULT_CONFIG_FILE): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(
      `Couldn't read ${file}. Copy config.example.json to config.json and fill in your provider details.`,
    );
  }

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

export function loadConfig(file = DEFAULT_CONFIG_FILE): Config {
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
    setAiredTime: optionalBoolean(obj, "setAiredTime", true),
    writeNfo: optionalBoolean(obj, "writeNfo", true),
  };
}
