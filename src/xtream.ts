import type { Config } from "./config.js";

// Minimal Xtream Codes API client. Only the bits we need for timeshift:
// authenticate, list channels that have an archive, and read a channel's EPG.

export interface AccountInfo {
  status: string;
  expDate: Date | null;
  isTrial: boolean;
  activeConnections: number;
  maxConnections: number;
}

export interface Channel {
  streamId: number;
  name: string;
  /** Whether catchup/timeshift is available for this channel. */
  hasArchive: boolean;
  /** How many days back the archive goes. */
  archiveDays: number;
  categoryId: string | null;
}

export interface EpgProgram {
  title: string;
  description: string;
  start: Date;
  end: Date;
  /** Server-local start string "YYYY-MM-DD HH:MM:SS", used to build the URL. */
  startLocal: string;
  /** Whether this program falls inside the archive window. */
  hasArchive: boolean;
}

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

export class XtreamClient {
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

  /** Authenticate and return account status. Throws if credentials are rejected. */
  async authenticate(): Promise<AccountInfo> {
    const data = (await this.call({})) as {
      user_info?: {
        auth?: number;
        status?: string;
        exp_date?: string | null;
        is_trial?: string;
        active_cons?: string;
        max_connections?: string;
      };
    };

    const info = data.user_info;
    if (!info || info.auth === 0) {
      throw new Error("Authentication failed. Check IPTV_URL, username and password.");
    }

    const expSeconds = info.exp_date ? toNumber(info.exp_date) : 0;

    return {
      status: info.status ?? "Unknown",
      expDate: expSeconds ? new Date(expSeconds * 1000) : null,
      isTrial: info.is_trial === "1",
      activeConnections: toNumber(info.active_cons),
      maxConnections: toNumber(info.max_connections),
    };
  }

  /** All live channels that have a timeshift archive available. */
  async getArchiveChannels(): Promise<Channel[]> {
    const data = (await this.call({ action: "get_live_streams" })) as Array<{
      stream_id: number | string;
      name: string;
      tv_archive: number | string;
      tv_archive_duration: number | string;
      category_id: string | null;
    }>;

    return data
      .map((item) => ({
        streamId: toNumber(item.stream_id),
        name: item.name,
        hasArchive: isTruthy(item.tv_archive),
        archiveDays: toNumber(item.tv_archive_duration),
        categoryId: item.category_id ?? null,
      }))
      .filter((channel) => channel.hasArchive);
  }

  /** EPG for a channel, newest first, limited to programs with an archive. */
  async getEpg(streamId: number): Promise<EpgProgram[]> {
    const data = (await this.call({
      action: "get_simple_data_table",
      stream_id: String(streamId),
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

    return listings
      .map((item) => ({
        title: decodeBase64(item.title) || "Untitled",
        description: decodeBase64(item.description),
        start: new Date(toNumber(item.start_timestamp) * 1000),
        end: new Date(toNumber(item.stop_timestamp) * 1000),
        startLocal: item.start ?? "",
        hasArchive: isTruthy(item.has_archive),
      }))
      .filter((program) => program.startLocal && program.end > program.start)
      .sort((a, b) => b.start.getTime() - a.start.getTime());
  }
}
