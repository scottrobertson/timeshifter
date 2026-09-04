import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { EpgProgram } from "./source.js";

// One-off recordings you picked out of the guide before they aired. Watch mode
// downloads each one once it has finished airing, then marks it done.
//
// These live in their own file rather than in config.json because config.json is
// mounted read-only in the Docker setups, and because a generated list doesn't
// belong in a file you hand-edit.

export const DEFAULT_SCHEDULE_FILE = "scheduled.json";

/** How far the guide can move a show and still be recognised as the same one. */
export const MATCH_WINDOW_MS = 3 * 60 * 60_000;

/** How long a finished recording stays in the file before it's tidied away. */
const KEEP_FINISHED_DAYS = 30;

/** The guide entry as it looked when you scheduled it. */
export interface ProgramSnapshot {
  title: string;
  description: string;
  /** ISO timestamps for the guide's start and end. */
  start: string;
  end: string;
  /** The panel's own wall-clock strings, "YYYY-MM-DD HH:MM:SS". */
  startLocal: string;
  endLocal: string;
}

export type ScheduledStatus = "pending" | "done" | "expired";

export interface ScheduledRecording {
  id: string;
  /** The channel name as it appeared in the channel list. */
  channel: string;
  program: ProgramSnapshot;
  /** Minutes before the start. Falls back to the global paddingBefore. */
  paddingBefore?: number;
  /** Minutes after the end. Falls back to the global paddingAfter. */
  paddingAfter?: number;
  /** Output filename template. Falls back to the global filenameTemplate. */
  filenameTemplate?: string;
  /** Strings to remove from the title when building the filename. Falls back to the global filenameStrip. */
  filenameStrip?: string[];
  /** Write a .nfo next to the recording. Falls back to the global writeNfo. */
  writeNfo?: boolean;
  /** Generate a comskip .edl. Falls back to the global comskip. */
  comskip?: boolean;
  createdAt: string;
  status: ScheduledStatus;
  /** When it finished downloading, or when it was given up on. */
  completedAt?: string;
  outputPath?: string;
}

function fail(detail: string): never {
  throw new Error(`scheduled.json ${detail}`);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail(`has a "${field}" that must be a non-empty string.`);
  }
  return value;
}

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return asString(value, field);
}

function asOptionalInt(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`has a "${field}" that must be a whole number.`);
  }
  return value;
}

function asOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    fail(`has a "${field}" that must be true or false.`);
  }
  return value;
}

function asOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    fail(`has a "${field}" that must be an array of strings.`);
  }
  return value as string[];
}

function parseSnapshot(value: unknown, id: string): ProgramSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`has a recording (${id}) with no "program".`);
  }
  const obj = value as Record<string, unknown>;
  const snapshot: ProgramSnapshot = {
    title: asString(obj.title, "program.title"),
    description: typeof obj.description === "string" ? obj.description : "",
    start: asString(obj.start, "program.start"),
    end: asString(obj.end, "program.end"),
    startLocal: asString(obj.startLocal, "program.startLocal"),
    endLocal: asString(obj.endLocal, "program.endLocal"),
  };
  if (Number.isNaN(Date.parse(snapshot.start)) || Number.isNaN(Date.parse(snapshot.end))) {
    fail(`has a recording (${id}) whose "program.start" or "program.end" isn't a date.`);
  }
  return snapshot;
}

/**
 * Drop keys that are set to undefined, so a recording that was saved without an
 * optional field comes back without it rather than with an empty one.
 */
function compact(recording: ScheduledRecording): ScheduledRecording {
  return Object.fromEntries(
    Object.entries(recording).filter(([, value]) => value !== undefined),
  ) as unknown as ScheduledRecording;
}

function parseRecording(value: unknown, index: number): ScheduledRecording {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`has a recording at position ${index} that isn't an object.`);
  }
  const obj = value as Record<string, unknown>;
  const id = asString(obj.id, "id");

  const status = asString(obj.status, "status");
  if (status !== "pending" && status !== "done" && status !== "expired") {
    fail(`has a recording (${id}) with a "status" that must be pending, done or expired.`);
  }

  return compact({
    id,
    channel: asString(obj.channel, "channel"),
    program: parseSnapshot(obj.program, id),
    paddingBefore: asOptionalInt(obj.paddingBefore, "paddingBefore"),
    paddingAfter: asOptionalInt(obj.paddingAfter, "paddingAfter"),
    filenameTemplate: asOptionalString(obj.filenameTemplate, "filenameTemplate"),
    filenameStrip: asOptionalStringArray(obj.filenameStrip, "filenameStrip"),
    writeNfo: asOptionalBoolean(obj.writeNfo, "writeNfo"),
    comskip: asOptionalBoolean(obj.comskip, "comskip"),
    createdAt: asString(obj.createdAt, "createdAt"),
    status,
    completedAt: asOptionalString(obj.completedAt, "completedAt"),
    outputPath: asOptionalString(obj.outputPath, "outputPath"),
  });
}

/** Everything in the schedule file. An absent file just means nothing is scheduled. */
export function loadSchedule(file = DEFAULT_SCHEDULE_FILE): ScheduledRecording[] {
  if (!existsSync(file)) return [];

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(`isn't valid JSON: ${(err as Error).message}`);
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    fail(`must be a JSON object.`);
  }
  const recordings = (data as Record<string, unknown>).recordings;
  if (recordings === undefined) return [];
  if (!Array.isArray(recordings)) {
    fail(`has a "recordings" that must be an array.`);
  }
  return recordings.map((item, i) => parseRecording(item, i));
}

/**
 * Write the schedule out. Goes to a temp file first and is renamed into place, so
 * a crash halfway through can't leave a half-written file behind.
 */
export function saveSchedule(
  recordings: ScheduledRecording[],
  file = DEFAULT_SCHEDULE_FILE,
): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ recordings }, null, 2)}\n`);
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing useful to do if even the cleanup fails.
    }
    throw err;
  }
}

/**
 * Read the file, change it, write it back. The interactive CLI and watch mode can
 * both be running, so every change re-reads rather than writing back a list that
 * was loaded earlier.
 */
function mutate(
  file: string,
  change: (recordings: ScheduledRecording[]) => ScheduledRecording[],
): ScheduledRecording[] {
  const next = change(loadSchedule(file));
  saveSchedule(next, file);
  return next;
}

/** A new pending recording, with its id and createdAt filled in. */
export function newRecording(
  fields: Omit<ScheduledRecording, "id" | "createdAt" | "status">,
): ScheduledRecording {
  return compact({
    ...fields,
    id: randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    status: "pending",
  });
}

export function addScheduled(
  recording: ScheduledRecording,
  file = DEFAULT_SCHEDULE_FILE,
): ScheduledRecording[] {
  return mutate(file, (recordings) => [...recordings, recording]);
}

export function updateScheduled(
  id: string,
  patch: Partial<ScheduledRecording>,
  file = DEFAULT_SCHEDULE_FILE,
): ScheduledRecording[] {
  return mutate(file, (recordings) =>
    recordings.map((r) => (r.id === id ? { ...r, ...patch } : r)),
  );
}

export function removeScheduled(id: string, file = DEFAULT_SCHEDULE_FILE): ScheduledRecording[] {
  return mutate(file, (recordings) => recordings.filter((r) => r.id !== id));
}

/** Turn a stored snapshot back into the program shape the download path expects. */
export function toProgram(recording: ScheduledRecording): EpgProgram {
  const { program } = recording;
  return {
    title: program.title,
    description: program.description,
    start: new Date(program.start),
    end: new Date(program.end),
    startLocal: program.startLocal,
    endLocal: program.endLocal,
    // Only ever used once the show has finished airing, so the archive is there.
    hasArchive: true,
  };
}

export function snapshotOf(program: EpgProgram): ProgramSnapshot {
  return {
    title: program.title,
    description: program.description,
    start: program.start.toISOString(),
    end: program.end.toISOString(),
    startLocal: program.startLocal,
    endLocal: program.endLocal,
  };
}

/**
 * Find the scheduled show in a channel's current guide. Guide times move, so it
 * matches on the title and takes the showing closest to the slot you picked. A
 * genuine repeat later in the day is far enough away to be ignored.
 */
export function findProgram(
  recording: ScheduledRecording,
  programs: EpgProgram[],
): EpgProgram | undefined {
  const wanted = recording.program.title.trim().toLowerCase();
  const scheduledStart = Date.parse(recording.program.start);
  const drift = (p: EpgProgram) => Math.abs(p.start.getTime() - scheduledStart);

  return programs
    .filter((p) => p.title.trim().toLowerCase() === wanted && drift(p) <= MATCH_WINDOW_MS)
    .sort((a, b) => drift(a) - drift(b))[0];
}

/** Whether the guide has moved the show away from the times we stored. */
export function hasMoved(recording: ScheduledRecording, program: EpgProgram): boolean {
  return (
    program.start.toISOString() !== recording.program.start ||
    program.end.toISOString() !== recording.program.end
  );
}

/** Drop finished recordings once they're old enough that nobody's looking at them. */
export function pruneSchedule(
  recordings: ScheduledRecording[],
  now: number,
): ScheduledRecording[] {
  const cutoff = now - KEEP_FINISHED_DAYS * 24 * 60 * 60_000;
  return recordings.filter((r) => {
    if (r.status === "pending") return true;
    const finished = Date.parse(r.completedAt ?? r.createdAt);
    return Number.isNaN(finished) || finished > cutoff;
  });
}
