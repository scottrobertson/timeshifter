import type { Config } from "./config.js";
import type { Channel, EpgProgram, RecordingWindow, Source } from "./source.js";
import { buildTimeshiftUrl } from "./timeshift.js";

// Minimal Xtream Codes API client. Only the bits we need for timeshift:
// authenticate, list channels that have an archive, and read a channel's EPG.

function decodeBase64(value: string | undefined): string {
  if (!value) return "";
  try {
    return Buffer.from(value, "base64").toString("utf-8");
  } catch {
    return value;
  }
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isTruthy(value: unknown): boolean {
  return value === 1 || value === "1" || value === true;
}

/**
 * Some panels return the same programme more than once, a few minutes apart
 * (same title, overlapping times, different listing ids). Collapse same-title
 * entries whose times overlap into one, spanning the earliest start to the
 * latest end, so the recording covers the whole show whichever copy is right. A
 * genuine later repeat has the same title but doesn't overlap, so it's left
 * alone.
 */
export function dedupeOverlapping(programs: EpgProgram[]): EpgProgram[] {
  const byStart = [...programs].sort((a, b) => a.start.getTime() - b.start.getTime());
  const kept: EpgProgram[] = [];
  for (const p of byStart) {
    const existing = kept.find(
      (k) =>
        k.title === p.title &&
        p.start.getTime() < k.end.getTime() &&
        k.start.getTime() < p.end.getTime(),
    );
    if (!existing) {
      kept.push({ ...p });
      continue;
    }
    // The earliest start is already kept (sorted ascending); widen to the later
    // end so the recording covers both feeds' idea of when it finishes.
    if (p.end.getTime() > existing.end.getTime()) {
      existing.end = p.end;
      existing.endLocal = p.endLocal;
    }
    existing.hasArchive = existing.hasArchive || p.hasArchive;
  }
  return kept;
}

export class XtreamSource implements Source {
  /** The provider's timezone (IANA name), which the guide times are in. */
  timezone: string | undefined;

  constructor(private readonly config: Config) {}

  private async call(params: Record<string, string>): Promise<unknown> {
    const url = new URL(`${this.config.baseUrl}/player_api.php`);
    url.searchParams.set("username", this.config.username);
    url.searchParams.set("password", this.config.password);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {};
    if (this.config.userAgent) headers["User-Agent"] = this.config.userAgent;

    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`Xtream API request failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  /** Authenticate and return a status line. Throws if credentials are rejected. */
  async connect(): Promise<string> {
    const data = (await this.call({})) as {
      user_info?: {
        auth?: number;
        status?: string;
        exp_date?: string | null;
      };
      server_info?: { timezone?: string };
    };

    const info = data.user_info;
    if (!info || info.auth === 0) {
      throw new Error("Authentication failed. Check the url, username and password in config.json.");
    }

    this.timezone = data.server_info?.timezone || undefined;

    const expSeconds = info.exp_date ? toNumber(info.exp_date) : 0;
    const status = `Connected. Account status: ${info.status ?? "Unknown"}`;
    if (!expSeconds) return status;
    return `${status} (expires ${new Date(expSeconds * 1000).toLocaleDateString()})`;
  }

  /** Archive channels, grouped by category in the provider's order. */
  async archiveChannels(): Promise<Channel[]> {
    const categories = await this.categories();
    const names = new Map(categories.map((c) => [String(c.category_id), c.category_name]));
    const order = new Map(categories.map((c, i) => [String(c.category_id), i]));
    const rank = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER;

    const data = (await this.call({ action: "get_live_streams" })) as Array<{
      stream_id: number | string;
      name: string;
      tv_archive: number | string;
      tv_archive_duration: number | string;
      category_id?: string | number;
    }>;

    // Group by category in the provider's category order. Array.sort is stable,
    // so channels within a category keep the provider's stream order.
    return data
      .filter((item) => isTruthy(item.tv_archive))
      .sort((a, b) => rank(String(a.category_id)) - rank(String(b.category_id)))
      .map((item) => ({
        name: item.name,
        archiveDays: toNumber(item.tv_archive_duration),
        streamId: toNumber(item.stream_id),
        group: names.get(String(item.category_id)),
      }));
  }

  /** Live categories in the provider's order. Best-effort; empty if the call fails. */
  private async categories(): Promise<Array<{ category_id: string | number; category_name: string }>> {
    try {
      return (await this.call({ action: "get_live_categories" })) as Array<{
        category_id: string | number;
        category_name: string;
      }>;
    } catch {
      return [];
    }
  }

  /** EPG for a channel, newest first. */
  async programs(channel: Channel): Promise<EpgProgram[]> {
    const data = (await this.call({
      action: "get_simple_data_table",
      stream_id: String(channel.streamId),
    })) as {
      epg_listings?: Array<{
        title?: string;
        description?: string;
        start?: string;
        end?: string;
        start_timestamp?: string | number;
        stop_timestamp?: string | number;
        has_archive?: string | number;
      }>;
    };

    const listings = data.epg_listings ?? [];

    // Set TIMESHIFTER_DEBUG to dump the panel's raw has_archive per listing,
    // before we dedupe. Useful when a program looks downloadable but 404s, or
    // when another tool disagrees about whether it has an archive. A value other
    // than "1"/"true" is used as a case-insensitive title filter.
    const debug = process.env.TIMESHIFTER_DEBUG;
    if (debug) {
      const filter = debug === "1" || debug === "true" ? "" : debug.toLowerCase();
      const rows = listings.filter(
        (item) => !filter || decodeBase64(item.title).toLowerCase().includes(filter),
      );
      console.error(`\n[debug] ${rows.length}/${listings.length} raw listings for ${channel.name}:`);
      for (const item of rows) {
        const start = (item.start ?? "").slice(0, 16);
        const flag = String(item.has_archive ?? "");
        console.error(`[debug]   has_archive=${flag.padEnd(4)} ${start}  ${decodeBase64(item.title)}`);
      }
    }

    const programs = listings
      .map((item) => ({
        title: decodeBase64(item.title) || "Untitled",
        description: decodeBase64(item.description),
        start: new Date(toNumber(item.start_timestamp) * 1000),
        end: new Date(toNumber(item.stop_timestamp) * 1000),
        startLocal: item.start ?? "",
        endLocal: item.end ?? "",
        hasArchive: isTruthy(item.has_archive),
      }))
      .filter((program) => program.startLocal && program.end > program.start);

    return dedupeOverlapping(programs).sort((a, b) => b.start.getTime() - a.start.getTime());
  }

  catchupUrl(channel: Channel, window: RecordingWindow): string {
    return buildTimeshiftUrl(this.config, channel.streamId!, window.startLocal, window.minutes);
  }
}
