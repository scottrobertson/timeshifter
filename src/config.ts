import "dotenv/config";

export type TimeshiftMode = "path" | "php";
export type OutputFormat = "mp4" | "ts";

export interface Config {
  baseUrl: string;
  username: string;
  password: string;
  downloadDir: string;
  outputFormat: OutputFormat;
  userAgent: string | undefined;
  timeshiftMode: TimeshiftMode;
  /** Minutes to start recording before the program's scheduled start. */
  paddingBefore: number;
  /** Minutes to keep recording after the program's scheduled end. */
  paddingAfter: number;
  /** Output filename template. Supports {channel} {title} {date} {time} {datetime} {ext}. */
  filenameTemplate: string;
  /** Show ffmpeg's full raw output instead of a clean progress line. */
  verbose: boolean;
  /** Set the downloaded file's modified time to when the program aired. */
  setAiredTime: boolean;
}

const DEFAULT_FILENAME_TEMPLATE = "{channel} - {title} - {datetime}.{ext}";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill in your provider details.`,
    );
  }
  return value;
}

function boolean(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return fallback;
}

function nonNegativeInt(name: string): number {
  const raw = process.env[name]?.trim();
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a whole number of minutes (0 or more), got "${raw}"`);
  }
  return n;
}

export function loadConfig(): Config {
  const baseUrl = required("IPTV_URL").replace(/\/+$/, "");
  const username = required("IPTV_USERNAME");
  const password = required("IPTV_PASSWORD");

  const outputFormat = (process.env.OUTPUT_FORMAT?.trim() ||
    "ts") as OutputFormat;
  if (outputFormat !== "mp4" && outputFormat !== "ts") {
    throw new Error(`OUTPUT_FORMAT must be "mp4" or "ts", got "${outputFormat}"`);
  }

  const timeshiftMode = (process.env.TIMESHIFT_MODE?.trim() ||
    "path") as TimeshiftMode;
  if (timeshiftMode !== "path" && timeshiftMode !== "php") {
    throw new Error(
      `TIMESHIFT_MODE must be "path" or "php", got "${timeshiftMode}"`,
    );
  }

  return {
    baseUrl,
    username,
    password,
    downloadDir: process.env.DOWNLOAD_DIR?.trim() || "downloads",
    outputFormat,
    userAgent: process.env.IPTV_USER_AGENT?.trim() || undefined,
    timeshiftMode,
    paddingBefore: nonNegativeInt("PADDING_BEFORE_MINUTES"),
    paddingAfter: nonNegativeInt("PADDING_AFTER_MINUTES"),
    filenameTemplate:
      process.env.FILENAME_TEMPLATE?.trim() || DEFAULT_FILENAME_TEMPLATE,
    verbose: boolean("VERBOSE"),
    setAiredTime: boolean("SET_AIRED_TIME", true),
  };
}
