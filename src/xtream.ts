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

export class XtreamSource implements Source {
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
    };

    const info = data.user_info;
    if (!info || info.auth === 0) {
      throw new Error("Authentication failed. Check IPTV_URL, username and password.");
    }

    const expSeconds = info.exp_date ? toNumber(info.exp_date) : 0;
    const status = `Connected. Account status: ${info.status ?? "Unknown"}`;
    if (!expSeconds) return status;
    return `${status} (expires ${new Date(expSeconds * 1000).toLocaleDateString()})`;
  }

  /** All live channels that have a timeshift archive available. */
  async archiveChannels(): Promise<Channel[]> {
    const data = (await this.call({ action: "get_live_streams" })) as Array<{
      stream_id: number | string;
      name: string;
      tv_archive: number | string;
      tv_archive_duration: number | string;
    }>;

    return data
      .filter((item) => isTruthy(item.tv_archive))
      .map((item) => ({
        name: item.name,
        archiveDays: toNumber(item.tv_archive_duration),
        streamId: toNumber(item.stream_id),
      }));
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

  catchupUrl(channel: Channel, window: RecordingWindow): string {
    return buildTimeshiftUrl(this.config, channel.streamId!, window.start, window.minutes);
  }
}
