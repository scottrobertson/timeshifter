import type { Config } from "./config.js";
import type { Channel, EpgProgram, RecordingWindow, Source } from "./source.js";
import { formatStartForUrl } from "./timeshift.js";
import { XtreamSource } from "./xtream.js";
import { parseProgrammes } from "./xmltv.js";

export interface M3uEntry {
  name: string;
  tvgId: string;
  streamUrl: string;
  archiveDays: number;
  catchupType?: string;
  catchupSource?: string;
}

export interface Playlist {
  epgUrl?: string;
  entries: M3uEntry[];
}

function attr(line: string, name: string): string | undefined {
  return line.match(new RegExp(`${name}="([^"]*)"`))?.[1];
}

/** Split an #EXTINF line into its attributes and the display name (after the first unquoted comma). */
function splitExtinf(line: string): [string, string] {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === "," && !inQuote) return [line.slice(0, i), line.slice(i + 1).trim()];
  }
  return [line, ""];
}

/** Parse an M3U playlist, keeping only channels that advertise a catchup archive. */
export function parsePlaylist(text: string): Playlist {
  const lines = text.split(/\r?\n/);
  const header = lines.find((l) => l.startsWith("#EXTM3U")) ?? "";
  const epgUrl = attr(header, "url-tvg") ?? attr(header, "x-tvg-url");

  const entries: M3uEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith("#EXTINF")) continue;

    // The stream URL is the next non-comment, non-empty line.
    let url = "";
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!.trim();
      if (!next || next.startsWith("#")) continue;
      url = next;
      break;
    }
    if (!url) continue;

    const catchupType = attr(line, "catchup");
    const hasArchive = catchupType !== undefined || attr(line, "tv_archive") === "1";
    if (!hasArchive) continue;

    const [, name] = splitExtinf(line);
    entries.push({
      name: name || attr(line, "tvg-name") || "Unknown",
      tvgId: attr(line, "tvg-id") ?? "",
      streamUrl: url,
      archiveDays: Number(attr(line, "catchup-days") ?? attr(line, "tv_archive_duration") ?? 0),
      catchupType,
      catchupSource: attr(line, "catchup-source"),
    });
  }

  return { epgUrl, entries };
}

function epochs(window: RecordingWindow) {
  const start = Math.floor(window.start.getTime() / 1000);
  const duration = window.minutes * 60;
  return { start, duration, end: start + duration, now: Math.floor(Date.now() / 1000) };
}

/** Fill a catchup-source template. Supports {token} and ${token} placeholders. */
export function fillCatchupTemplate(
  template: string,
  streamUrl: string,
  window: RecordingWindow,
): string {
  const { start, end, duration, now } = epochs(window);
  const [date, time] = window.startLocal.split(" ");
  const [Y, mo, d] = (date ?? "").split("-");
  const [H, M, S] = (time ?? "").split(":");

  const values: Record<string, string> = {
    utc: String(start),
    start: String(start),
    timestamp: String(start),
    utcend: String(end),
    end: String(end),
    lutc: String(now),
    now: String(now),
    offset: String(now - start),
    duration: String(duration),
    Y: Y ?? "",
    m: mo ?? "",
    d: d ?? "",
    H: H ?? "",
    M: M ?? "",
    S: S ?? "",
  };

  const filled = template.replace(/\$?\{(\w+)\}/g, (match, key: string) =>
    key in values ? values[key]! : match,
  );

  // A bare template (no scheme) is a suffix appended to the channel URL.
  return /^https?:\/\//i.test(filled) ? filled : streamUrl + filled;
}

export interface XtreamUrlParts {
  baseUrl: string;
  username: string;
  password: string;
  streamId: number;
}

/**
 * Pull the Xtream details out of a live URL (".../user/pass/id.ext"). Returns
 * null if the URL isn't that shape. Both bare and "/live/"-prefixed paths work.
 */
export function parseXtreamFromUrl(streamUrl: string): XtreamUrlParts | null {
  let url: URL;
  try {
    url = new URL(streamUrl);
  } catch {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 3) return null;

  const idMatch = segments[segments.length - 1]!.match(/^(\d+)(?:\.\w+)?$/);
  if (!idMatch) return null; // not an Xtream-style numeric stream id

  return {
    baseUrl: url.origin,
    username: segments[segments.length - 3]!,
    password: segments[segments.length - 2]!,
    streamId: Number(idMatch[1]),
  };
}

/**
 * Turn an Xtream live URL into its timeshift URL. The fallback when a channel
 * advertises catchup but gives no template, which is what Xtream-backed
 * playlists do. Returns null if the URL isn't Xtream-shaped.
 */
export function deriveXtreamTimeshift(
  streamUrl: string,
  window: RecordingWindow,
): string | null {
  const parts = parseXtreamFromUrl(streamUrl);
  if (!parts) return null;
  const start = formatStartForUrl(window.startLocal);
  return `${parts.baseUrl}/timeshift/${parts.username}/${parts.password}/${window.minutes}/${start}/${parts.streamId}.ts`;
}

/** Generic fallback: append a standard catchup query to the live URL. */
export function appendDefaultCatchup(
  streamUrl: string,
  window: RecordingWindow,
): string {
  const { start, now } = epochs(window);
  const url = new URL(streamUrl);
  url.searchParams.set("utc", String(start));
  url.searchParams.set("lutc", String(now));
  return url.toString();
}

export function m3uCatchupUrl(channel: Channel, window: RecordingWindow): string {
  const streamUrl = channel.streamUrl!;
  if (channel.catchupSource?.trim()) {
    return fillCatchupTemplate(channel.catchupSource, streamUrl, window);
  }
  return deriveXtreamTimeshift(streamUrl, window) ?? appendDefaultCatchup(streamUrl, window);
}

export class M3uSource implements Source {
  private entries: M3uEntry[] = [];
  private epgUrl: string | undefined;
  private epg: Map<string, EpgProgram[]> | undefined;
  // Set when the playlist is Xtream-backed: the provider's API has the past
  // guide (an XMLTV feed usually only carries now + upcoming), so we use it.
  private xtream: XtreamSource | undefined;

  constructor(private readonly config: Config) {}

  private async fetchText(url: string): Promise<string> {
    const headers: Record<string, string> = {};
    if (this.config.userAgent) headers["User-Agent"] = this.config.userAgent;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`Request failed: ${res.status} ${res.statusText} (${url})`);
    }
    return res.text();
  }

  async connect(): Promise<string> {
    const playlist = parsePlaylist(await this.fetchText(this.config.m3uUrl!));
    this.entries = playlist.entries;
    this.epgUrl = this.config.epgUrl ?? playlist.epgUrl;

    if (this.entries.length === 0) {
      throw new Error("No channels with a catchup archive were found in the playlist.");
    }

    // If the streams are Xtream-backed, the provider's API gives the past guide.
    const parts = this.entries.map((e) => parseXtreamFromUrl(e.streamUrl)).find((p) => p);
    if (parts) {
      const xtream = new XtreamSource({
        ...this.config,
        baseUrl: parts.baseUrl,
        username: parts.username,
        password: parts.password,
      });
      try {
        await xtream.connect();
        this.xtream = xtream;
        return `Loaded ${this.entries.length} archive channels from the playlist (guide via the provider API).`;
      } catch {
        // API unavailable; fall back to the playlist's EPG below.
      }
    }

    const note = this.epgUrl
      ? "guide from the playlist's EPG, which may not include past programs"
      : "no EPG link found in the playlist";
    return `Loaded ${this.entries.length} archive channels from the playlist (${note}).`;
  }

  async archiveChannels(): Promise<Channel[]> {
    return this.entries.map((entry) => ({
      name: entry.name,
      archiveDays: entry.archiveDays,
      tvgId: entry.tvgId,
      streamUrl: entry.streamUrl,
      catchupType: entry.catchupType,
      catchupSource: entry.catchupSource,
      streamId: parseXtreamFromUrl(entry.streamUrl)?.streamId,
    }));
  }

  private async loadEpg(): Promise<Map<string, EpgProgram[]>> {
    if (this.epg) return this.epg;
    if (!this.epgUrl) return (this.epg = new Map());

    const wanted = new Set(this.entries.map((e) => e.tvgId).filter(Boolean));
    console.log("Downloading the EPG (this can be large, one moment)...");
    this.epg = parseProgrammes(await this.fetchText(this.epgUrl), wanted);
    return this.epg;
  }

  async programs(channel: Channel): Promise<EpgProgram[]> {
    // Prefer the provider API: it has the past programs catchup actually covers.
    if (this.xtream && channel.streamId !== undefined) {
      return this.xtream.programs(channel);
    }

    if (!channel.tvgId) return [];
    const epg = await this.loadEpg();
    const list = epg.get(channel.tvgId) ?? [];

    const cutoff = Date.now() - channel.archiveDays * 86_400_000;
    return list
      .map((program) => ({ ...program, hasArchive: program.start.getTime() >= cutoff }))
      .sort((a, b) => b.start.getTime() - a.start.getTime());
  }

  catchupUrl(channel: Channel, window: RecordingWindow): string {
    return m3uCatchupUrl(channel, window);
  }
}
