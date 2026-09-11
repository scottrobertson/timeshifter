import { existsSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { Channel, EpgProgram, Source } from "./source.js";
import { XtreamSource } from "./xtream.js";
import {
  download,
  ensureEdl,
  readyAtLocal,
  recordingWindow,
  setFileTime,
  syncNfo,
} from "./timeshift.js";
import { resolvePlan, type RecordingPlan } from "./plan.js";
import {
  channelMatches,
  channelNameMatches,
  loadWatchConfig,
  titleMatches,
  type WatchConfig,
} from "./subscriptions.js";
import {
  defaultScheduleFile,
  loadSchedule,
  pruneSchedule,
  saveSchedule,
  toProgram,
  updateScheduled,
} from "./scheduled.js";

/** When a program's catchup should be there to download, as a timestamp. */
function readyAt(program: EpgProgram, paddingAfter: number, readyGraceMinutes: number): number {
  return program.end.getTime() + (paddingAfter + readyGraceMinutes) * 60_000;
}

/**
 * Whether a program should be downloaded now: it's in the archive, it finished
 * airing after the cutoff (the subscription's "from" date, or -Infinity to take
 * the whole archive), and enough time has passed since its end plus padding for
 * the catchup to be ready. Pure so it's easy to test at the boundaries.
 */
export function isDue(
  program: EpgProgram,
  paddingAfter: number,
  readyGraceMinutes: number,
  cutoff: number,
  now: number,
): boolean {
  if (!program.hasArchive) return false;
  if (program.end.getTime() <= cutoff) return false;
  return now >= readyAt(program, paddingAfter, readyGraceMinutes);
}

/**
 * Whether a program is still to come: its catchup isn't there yet, either because
 * it hasn't aired or because it only just finished. The archive flag is ignored on
 * purpose, since the provider only sets it once a show has aired.
 */
export function isUpcoming(
  program: EpgProgram,
  paddingAfter: number,
  readyGraceMinutes: number,
  cutoff: number,
  now: number,
): boolean {
  if (program.end.getTime() <= cutoff) return false;
  return now < readyAt(program, paddingAfter, readyGraceMinutes);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stamp(now: number): string {
  // Local time (respects the TZ env var), not UTC like toISOString would give.
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

// A fixed-width status word so the times and titles line up in a column.
function status(label: string): string {
  return label.padEnd(9);
}

async function downloadProgram(
  config: Config,
  source: Source,
  channel: Channel,
  program: EpgProgram,
  plan: RecordingPlan,
  prefix: string,
): Promise<string | undefined> {
  try {
    const window = recordingWindow(program, plan.paddingBefore, plan.paddingAfter);
    const url = source.catchupUrl(channel, window);
    const result = await download(config, url, plan.filename);
    if (config.setAiredTime) {
      try {
        await setFileTime(result.outputPath, program.end);
      } catch {
        // Non-fatal: the recording is fine, only its file date didn't get set.
      }
    }
    if (plan.writeNfo) {
      try {
        await syncNfo(program, result.outputPath, new Date());
      } catch {
        // Non-fatal: the recording is fine, only the .nfo didn't get written.
      }
    }
    const gb = (result.bytesDownloaded / 1e9).toFixed(2);
    console.log(`${prefix}${status("✓ saved")} ${gb} GB · ${result.outputPath}`);
    // After the saved line, so the comskip spinner sits under the recording it's for.
    if (plan.comskip) {
      try {
        const edl = await ensureEdl(result.outputPath);
        // Only report when comskip actually ran. An existing .edl is a no-op, so
        // printing it would put a comskip line under every recording we already have.
        if (edl.status === "created") {
          console.log(`  ✓ comskip · ${edl.commercials} ${edl.commercials === 1 ? "ad break" : "ad breaks"} found`);
        }
      } catch {
        // Non-fatal: the recording is fine, only the .edl didn't get generated.
      }
    }
    return result.outputPath;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const when = program.startLocal.slice(0, 16);
    // Name the program again so the failure stands on its own in the log.
    console.error(
      `${prefix}${status("✗ failed")} ${when} · ${program.title} · will retry next poll: ${message}`,
    );
    return undefined;
  }
}

/** What one poll did for one subscription, for the log line and for tests. */
export interface SubscriptionPollResult {
  subscription: string;
  /** Programs that matched and were ready to download. */
  ready: number;
  /** Programs that matched but haven't aired yet, or are waiting on the catchup. */
  upcoming: number;
  /** Of those, how many a dry run would have downloaded. */
  listed: number;
  downloaded: number;
  failed: number;
  /** Skipped because the file already exists. */
  alreadyHad: number;
}

/** What one poll did for the one-off scheduled recordings, all of them together. */
export interface ScheduledPollResult {
  /** How many were still waiting to happen when the poll reached them. */
  pending: number;
  /** Of those, how many have a slot that hasn't passed yet. */
  upcoming: number;
  /** Recordings that were ready to download. */
  listed: number;
  downloaded: number;
  failed: number;
  /** Skipped because the file already exists. */
  alreadyHad: number;
  /** Given up on after 48 hours of the download not working. */
  expired: number;
}

export interface PollResult {
  subscriptions: SubscriptionPollResult[];
  scheduled: ScheduledPollResult;
}

/** The label used for scheduled recordings in the log, alongside subscription names. */
const SCHEDULED_LABEL = "scheduled";

/**
 * How long after a scheduled show was meant to end we keep trying before giving
 * up on it. Long enough to ride out a provider outage, short enough that a show
 * that never aired doesn't get retried forever.
 */
const EXPIRE_AFTER_MS = 48 * 60 * 60_000;

/**
 * How many upcoming shows a subscription lists before the rest are summed up on
 * one line. A subscription with a loose title match can have a whole week of the
 * guide ahead of it, and this prints every poll.
 */
const UPCOMING_SHOWN = 5;

/** One log line per upcoming show, soonest first, with the rest counted on the end. */
export function upcomingLines(
  upcoming: Array<{ start: number; line: string }>,
  prefix: string,
): string[] {
  const sorted = [...upcoming].sort((a, b) => a.start - b.start);
  const lines = sorted.slice(0, UPCOMING_SHOWN).map((entry) => entry.line);
  if (sorted.length > UPCOMING_SHOWN) {
    lines.push(`${prefix}${status("")} and ${sorted.length - UPCOMING_SHOWN} more`);
  }
  return lines;
}

export async function pollOnce(
  config: Config,
  source: Source,
  watch: WatchConfig,
  dryRun: boolean,
  now: number = Date.now(),
  scheduleFile: string = defaultScheduleFile(),
): Promise<PollResult> {
  const channels = await source.archiveChannels();
  const results: SubscriptionPollResult[] = [];
  const pending = loadSchedule(scheduleFile).filter((r) => r.status === "pending");

  // A rule line with the time starts each poll, so they're easy to tell apart
  // as they scroll past in the log.
  console.log(`\n${pollSeparator(now)}`);

  // Pad the subscription names to the longest so the brackets and everything
  // after them line up in a column across subscriptions.
  const nameWidth = Math.max(
    0,
    ...watch.subscriptions.map((s) => s.name.length),
    ...(pending.length ? [SCHEDULED_LABEL.length] : []),
  );

  // Two subscriptions on the same channel, or a subscription and a scheduled
  // recording, would otherwise each ask the provider for the same guide.
  const guide = new Map<string, EpgProgram[]>();
  const programsFor = async (channel: Channel): Promise<EpgProgram[]> => {
    const key = channel.name;
    const cached = guide.get(key);
    if (cached) return cached;
    const programs = await source.programs(channel);
    guide.set(key, programs);
    return programs;
  };

  for (const sub of watch.subscriptions) {
    const result: SubscriptionPollResult = {
      subscription: sub.name,
      ready: 0,
      upcoming: 0,
      listed: 0,
      downloaded: 0,
      failed: 0,
      alreadyHad: 0,
    };
    results.push(result);

    // Every line leads with the subscription so you can tell where it came from
    // without per-subscription headers.
    const prefix = `[${sub.name.padEnd(nameWidth)}] `;

    // Held back until the subscription's downloads are done, so each block reads
    // as what happened and then what's still to come. The guide also arrives
    // newest first, which would list next week above tonight.
    const upcoming: Array<{ start: number; line: string }> = [];

    const matching = channels.filter((c) => channelMatches(sub, c));
    if (matching.length === 0) {
      console.log(`${prefix}${status("no match")} no channel matches "${sub.channel}"`);
      continue;
    }
    // No "from" means take the whole archive (file-exists dedup stops repeats).
    const cutoff = sub.from ? Date.parse(sub.from) : Number.NEGATIVE_INFINITY;

    for (const channel of matching) {
      const programs = await programsFor(channel);
      for (const program of programs) {
        if (!titleMatches(sub, program.title)) continue;
        const plan = resolvePlan(config, channel, program, sub);
        const when = program.startLocal.slice(0, 16);

        if (!isDue(program, plan.paddingAfter, watch.readyGraceMinutes, cutoff, now)) {
          if (isUpcoming(program, plan.paddingAfter, watch.readyGraceMinutes, cutoff, now)) {
            const ready = readyAtLocal(program, plan.paddingAfter + watch.readyGraceMinutes).slice(0, 16);
            result.upcoming++;
            upcoming.push({
              start: program.start.getTime(),
              line: `${prefix}${status("upcoming")} ${when} · ${program.title} · ready ${ready}`,
            });
          }
          continue;
        }
        result.ready++;

        const outputPath = path.join(config.downloadDir, plan.filename);
        if (existsSync(outputPath)) {
          result.alreadyHad++;
          // Refresh the sidecar even when the file is already there, so an
          // existing recording still gets (or updates) its .nfo. Note it on the
          // line only when it actually changed.
          let note = "";
          if (plan.writeNfo) {
            try {
              const nfo = await syncNfo(program, outputPath, new Date());
              if (nfo.status !== "unchanged") note = ` · ${nfo.status} .nfo`;
            } catch {
              // Non-fatal: the recording is there, only its .nfo didn't update.
            }
          }
          // Print the recording first, so a backfill comskip run (which blocks
          // for minutes) shows its spinner under the file it's working on.
          console.log(`${prefix}${status("have")} ${when} · ${program.title}${note}`);
          if (plan.comskip) {
            try {
              // Backfill: generate the .edl for a recording we already have but
              // that's missing one. It only runs comskip once, then no-ops.
              const edl = await ensureEdl(outputPath);
              // Only report when comskip actually ran, so recordings that already
              // have their .edl stay as a single line.
              if (edl.status === "created") {
                console.log(`  ✓ comskip · ${edl.commercials} ${edl.commercials === 1 ? "ad break" : "ad breaks"} found`);
              }
            } catch {
              // Non-fatal: leave the recording as-is, try again next poll.
            }
          }
          continue;
        }

        const label = dryRun ? "would get" : "download";
        console.log(`${prefix}${status(label)} ${when} · ${program.title}`);
        result.listed++;
        if (dryRun) continue;
        const saved = await downloadProgram(config, source, channel, program, plan, prefix);
        if (saved) {
          result.downloaded++;
        } else {
          result.failed++;
        }
      }
    }

    for (const line of upcomingLines(upcoming, prefix)) console.log(line);
  }

  const scheduled = await pollScheduled(
    config,
    source,
    watch,
    dryRun,
    now,
    scheduleFile,
    channels,
    `[${SCHEDULED_LABEL.padEnd(nameWidth)}] `,
  );

  const poll: PollResult = { subscriptions: results, scheduled };

  // One summary for the whole poll, under the separator and any activity.
  console.log(`\n${pollSummaryLine(poll, watch.subscriptions.length, dryRun)}`);

  return poll;
}

/**
 * Work through the one-off recordings someone picked out of the guide before they
 * aired. Each one records the time slot that was picked, once that slot has
 * passed, then is marked done so it never runs again. The guide isn't consulted:
 * a scheduled recording is a timer, and the times are already in the file.
 */
async function pollScheduled(
  config: Config,
  source: Source,
  watch: WatchConfig,
  dryRun: boolean,
  now: number,
  scheduleFile: string,
  channels: Channel[],
  prefix: string,
): Promise<ScheduledPollResult> {
  // Re-read rather than reuse what the poll started with, so anything scheduled
  // while a long download was running still gets seen this time round.
  const pending = loadSchedule(scheduleFile).filter((r) => r.status === "pending");

  const result: ScheduledPollResult = {
    pending: pending.length,
    upcoming: 0,
    listed: 0,
    downloaded: 0,
    failed: 0,
    alreadyHad: 0,
    expired: 0,
  };

  if (pending.length === 0) return result;

  for (const recording of pending) {
    const channel = channels.find((c) => channelNameMatches(recording.channel, c));
    if (!channel) {
      console.log(`${prefix}${status("no match")} no channel matches "${recording.channel}"`);
      continue;
    }

    const program = toProgram(recording);
    const plan = resolvePlan(config, channel, program, recording);
    const when = program.startLocal.slice(0, 16);

    if (!isDue(program, plan.paddingAfter, watch.readyGraceMinutes, Number.NEGATIVE_INFINITY, now)) {
      const ready = readyAtLocal(program, plan.paddingAfter + watch.readyGraceMinutes).slice(0, 16);
      console.log(`${prefix}${status("upcoming")} ${when} · ${program.title} · ready ${ready}`);
      result.upcoming++;
      continue;
    }

    // A download that keeps failing would otherwise be retried forever.
    if (now > Date.parse(recording.program.end) + EXPIRE_AFTER_MS) {
      console.log(`${prefix}${status("expired")} ${when} · ${program.title} · gave up after 48 hours`);
      result.expired++;
      if (!dryRun) {
        updateScheduled(
          recording.id,
          { status: "expired", completedAt: new Date().toISOString() },
          scheduleFile,
        );
      }
      continue;
    }

    const outputPath = path.join(config.downloadDir, plan.filename);

    if (existsSync(outputPath)) {
      result.alreadyHad++;
      console.log(`${prefix}${status("have")} ${when} · ${program.title}`);
      if (!dryRun) {
        updateScheduled(
          recording.id,
          { status: "done", completedAt: new Date().toISOString(), outputPath },
          scheduleFile,
        );
      }
      continue;
    }

    console.log(`${prefix}${status(dryRun ? "would get" : "download")} ${when} · ${program.title}`);
    result.listed++;
    if (dryRun) continue;

    const saved = await downloadProgram(config, source, channel, program, plan, prefix);
    if (saved) {
      result.downloaded++;
      updateScheduled(
        recording.id,
        { status: "done", completedAt: new Date().toISOString(), outputPath: saved },
        scheduleFile,
      );
    } else {
      // Left pending on purpose, so the next poll tries again.
      result.failed++;
    }
  }

  if (!dryRun) {
    const all = loadSchedule(scheduleFile);
    const kept = pruneSchedule(all, now);
    if (kept.length !== all.length) saveSchedule(kept, scheduleFile);
  }

  return result;
}

// A full-width rule carrying the poll time, e.g. "── 2026-06-28 16:03:21 ──…".
function pollSeparator(now: number): string {
  const label = `── ${stamp(now)} `;
  return label + "─".repeat(Math.max(0, 60 - label.length));
}

function pollSummaryLine(poll: PollResult, subscriptions: number, dryRun: boolean): string {
  const total = poll.subscriptions.reduce(
    (acc, r) => ({
      upcoming: acc.upcoming + r.upcoming,
      listed: acc.listed + r.listed,
      downloaded: acc.downloaded + r.downloaded,
      failed: acc.failed + r.failed,
      alreadyHad: acc.alreadyHad + r.alreadyHad,
    }),
    {
      upcoming: poll.scheduled.upcoming,
      listed: poll.scheduled.listed,
      downloaded: poll.scheduled.downloaded,
      failed: poll.scheduled.failed,
      alreadyHad: poll.scheduled.alreadyHad,
    },
  );

  const parts = [`${subscriptions} sub${subscriptions === 1 ? "" : "s"}`];
  if (poll.scheduled.pending) parts.push(`${poll.scheduled.pending} scheduled`);
  if (total.upcoming) parts.push(`${total.upcoming} upcoming`);
  if (dryRun) {
    parts.push(total.listed ? `${total.listed} would download` : "nothing new");
  } else if (total.downloaded || total.failed) {
    parts.push(`${total.downloaded} downloaded`);
    if (total.failed) parts.push(`${total.failed} failed`);
  } else {
    parts.push("nothing new");
  }
  if (total.alreadyHad) parts.push(`${total.alreadyHad} already had`);
  if (poll.scheduled.expired) parts.push(`${poll.scheduled.expired} expired`);
  return parts.join(" · ");
}

export async function runWatch(config: Config, dryRun = false): Promise<void> {
  const source: Source = new XtreamSource(config);
  console.log(await source.connect());

  // Loaded fresh each loop so edits to the file are picked up without a restart.
  let watch = loadWatchConfig();
  const scheduled = loadSchedule().filter((r) => r.status === "pending").length;
  console.log(
    `${dryRun ? "Dry run: watching" : "Watching"} ${watch.subscriptions.length} subscription(s) ` +
      `and ${scheduled} scheduled recording(s), ` +
      `polling every ${watch.pollIntervalMinutes} min.${dryRun ? " Nothing will be downloaded." : ""}`,
  );
  if (watch.subscriptions.length === 0 && scheduled === 0) {
    // Keep polling anyway: a recording can be scheduled while this is running.
    console.log(
      `Nothing to watch yet. Add subscriptions to config.json, or schedule an upcoming show with "timeshifter".`,
    );
  }

  for (;;) {
    try {
      await pollOnce(config, source, watch, dryRun);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${stamp(Date.now())}] ⚠️  Poll failed: ${message}`);
    }

    const intervalMs = watch.pollIntervalMinutes * 60_000;
    console.log(`\nNext poll at ${stamp(Date.now() + intervalMs)}.`);
    await sleep(intervalMs);

    // Re-read for the next round. Keep the last good config if the file is
    // mid-edit or broken, so a typo doesn't take the watcher down.
    try {
      watch = loadWatchConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${stamp(Date.now())}] ⚠️  Couldn't reload subscriptions, keeping the previous ones: ${message}`);
    }
  }
}
