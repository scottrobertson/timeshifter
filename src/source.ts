// A "source" is wherever we get channels, the guide, and the catchup URL from.
// Today that's the Xtream Codes API; the interface leaves room for others (e.g.
// an M3U playlist) without the CLI needing to change.

export interface Channel {
  name: string;
  /** How many days back the archive goes. */
  archiveDays: number;

  // Xtream sources identify a channel by its stream id.
  streamId?: number;
}

export interface EpgProgram {
  title: string;
  description: string;
  start: Date;
  end: Date;
  /** Local start string "YYYY-MM-DD HH:MM:SS", used to build the catchup URL. */
  startLocal: string;
  /** Whether this program falls inside the archive window. */
  hasArchive: boolean;
}

export interface RecordingWindow {
  /** Local start string, after the before-padding (for path-style URLs). */
  startLocal: string;
  /** Total length in whole minutes, including padding. */
  minutes: number;
}

export interface Source {
  /** Connect or load, returning a one-line status. Throws on failure. */
  connect(): Promise<string>;
  /** Channels that have a catchup archive. */
  archiveChannels(): Promise<Channel[]>;
  /** Past programs for a channel that fall inside the archive window. */
  programs(channel: Channel): Promise<EpgProgram[]>;
  /** The URL to record for a chosen program's recording window. */
  catchupUrl(channel: Channel, window: RecordingWindow): string;
}
