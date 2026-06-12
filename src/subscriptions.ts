import { readConfigFile, DEFAULT_CONFIG_FILE } from "./config.js";
import type { Channel } from "./source.js";

/** A rule describing which programs to download automatically in watch mode. */
export interface Subscription {
  /** A label, only used in logs. */
  name: string;
  /** The channel's exact name (case-insensitive), e.g. "NASA TV". */
  channel: string;
  /** Every one of these must appear in the program title (case-insensitive). */
  titleContains: string[];
  /** None of these may appear in the title (case-insensitive). */
  titleExcludes?: string[];
  /**
   * Only download programs that finish after this date (e.g. "2026-06-01" or
   * "2026-06-01T13:00"). Omit to download everything in the channel's archive.
   */
  from?: string;
  /** Minutes before the start. Falls back to the global paddingBefore. */
  paddingBefore?: number;
  /** Minutes after the end. Falls back to the global paddingAfter. */
  paddingAfter?: number;
  /** Output filename template. Falls back to the global filenameTemplate. */
  filenameTemplate?: string;
  /** Strings to remove from the title when building the filename. Falls back to the global filenameStrip. */
  filenameStrip?: string[];
}

export interface WatchConfig {
  /** How often to re-check the EPG. */
  pollIntervalMinutes: number;
  /** Extra wait after a program's end+padding before downloading, for slow archives. */
  readyGraceMinutes: number;
  subscriptions: Subscription[];
}

/** Does the channel's name exactly match the subscription's channel (case-insensitive)? */
export function channelMatches(sub: Subscription, channel: Channel): boolean {
  return channel.name.trim().toLowerCase() === sub.channel.trim().toLowerCase();
}

/** Does the title contain all of titleContains and none of titleExcludes? */
export function titleMatches(sub: Subscription, title: string): boolean {
  const lower = title.toLowerCase();
  if (!sub.titleContains.every((t) => lower.includes(t.toLowerCase()))) return false;
  if (sub.titleExcludes?.some((t) => lower.includes(t.toLowerCase()))) return false;
  return true;
}

/** Both the channel and the title match the subscription. */
export function matchesProgram(sub: Subscription, channel: Channel, title: string): boolean {
  return channelMatches(sub, channel) && titleMatches(sub, title);
}

function fail(detail: string): never {
  throw new Error(`config.json ${detail}`);
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    fail(`has a "${field}" that must be an array of strings.`);
  }
  return value as string[];
}

function asInt(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`has a "${field}" that must be a whole number.`);
  }
  return value;
}

function asDate(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fail(`has a "${field}" that must be a date like "2026-06-01" or "2026-06-01T13:00".`);
  }
  return value;
}

function asString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    fail(`has a "${field}" that must be a non-empty string.`);
  }
  return value;
}

function parseSubscription(item: unknown, index: number): Subscription {
  if (typeof item !== "object" || item === null) {
    fail(`has a subscription at position ${index} that isn't an object.`);
  }
  const obj = item as Record<string, unknown>;

  if (typeof obj.name !== "string" || !obj.name.trim()) {
    fail(`has a subscription at position ${index} missing a "name".`);
  }
  if (typeof obj.channel !== "string" || !obj.channel.trim()) {
    fail(`has a subscription ("${obj.name}") missing a "channel".`);
  }
  const titleContains = asStringArray(obj.titleContains, "titleContains");
  if (titleContains.length === 0) {
    fail(`has a subscription ("${obj.name}") with an empty "titleContains".`);
  }

  return {
    name: obj.name,
    channel: obj.channel,
    titleContains,
    titleExcludes: obj.titleExcludes === undefined
      ? undefined
      : asStringArray(obj.titleExcludes, "titleExcludes"),
    from: asDate(obj.from, "from"),
    paddingBefore: asInt(obj.paddingBefore, "paddingBefore"),
    paddingAfter: asInt(obj.paddingAfter, "paddingAfter"),
    filenameTemplate: asString(obj.filenameTemplate, "filenameTemplate"),
    filenameStrip: obj.filenameStrip === undefined
      ? undefined
      : asStringArray(obj.filenameStrip, "filenameStrip"),
  };
}

/** Read and validate the "watch" block of the config file. Throws with a clear message. */
export function loadWatchConfig(file = DEFAULT_CONFIG_FILE): WatchConfig {
  const config = readConfigFile(file);

  const watch = config.watch;
  if (typeof watch !== "object" || watch === null || Array.isArray(watch)) {
    fail(`needs a "watch" object for watch mode (see config.example.json).`);
  }
  const obj = watch as Record<string, unknown>;

  if (!Array.isArray(obj.subscriptions) || obj.subscriptions.length === 0) {
    fail(`needs a non-empty "watch.subscriptions" array.`);
  }

  return {
    pollIntervalMinutes: asInt(obj.pollIntervalMinutes, "pollIntervalMinutes") ?? 10,
    readyGraceMinutes: asInt(obj.readyGraceMinutes, "readyGraceMinutes") ?? 0,
    subscriptions: (obj.subscriptions as unknown[]).map((item, i) => parseSubscription(item, i)),
  };
}
