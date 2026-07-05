import { existsSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { Channel, EpgProgram, Source } from "./source.js";
import { XtreamSource } from "./xtream.js";
import { download, ensureEdl, outputFilename, recordingWindow, setFileTime, syncNfo } from "./timeshift.js";
import {
  channelMatches,
  loadWatchConfig,
  titleMatches,
  type Subscription,
  type WatchConfig,
} from "./subscriptions.js";

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
  const readyAt = program.end.getTime() + (paddingAfter + readyGraceMinutes) * 60_000;
  return now >= readyAt;
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
  before: number,
  after: number,
  filename: string,
  prefix: string,
  comskip: boolean,
): Promise<boolean> {
  try {
    const window = recordingWindow(program, before, after);
    const url = source.catchupUrl(channel, window);
    const result = await download(config, url, filename);
    if (config.setAiredTime) {
      try {
        await setFileTime(result.outputPath, program.end);
      } catch {
        // Non-fatal: the recording is fine, only its file date didn't get set.
      }
    }
    if (config.writeNfo) {
      try {
        await syncNfo(program, result.outputPath, new Date());
      } catch {
        // Non-fatal: the recording is fine, only the .nfo didn't get written.
      }
    }
    const gb = (result.bytesDownloaded / 1e9).toFixed(2);
    console.log(`${prefix}${status("✓ saved")} ${gb} GB · ${result.outputPath}`);
    // After the saved line, so the comskip spinner sits under the recording it's for.
    if (comskip) {
      try {
        await ensureEdl(result.outputPath);
      } catch {
        // Non-fatal: the recording is fine, only the .edl didn't get generated.
      }
    }
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const when = program.startLocal.slice(0, 16);
    // Name the program again so the failure stands on its own in the log.
    console.error(
      `${prefix}${status("✗ failed")} ${when} · ${program.title} · will retry next poll: ${message}`,
    );
    return false;
  }
}

/** What one poll did for one subscription, for the log line and for tests. */
export interface SubscriptionPollResult {
  subscription: string;
  /** Programs that matched and were ready to download. */
  ready: number;
  /** Of those, how many a dry run would have downloaded. */
  listed: number;
  downloaded: number;
  failed: number;
  /** Skipped because the file already exists. */
  alreadyHad: number;
}

export async function pollOnce(
  config: Config,
  source: Source,
  watch: WatchConfig,
  dryRun: boolean,
  now: number = Date.now(),
): Promise<SubscriptionPollResult[]> {
  const channels = await source.archiveChannels();
  const results: SubscriptionPollResult[] = [];

  // A rule line with the time starts each poll, so they're easy to tell apart
  // as they scroll past in the log.
  console.log(`\n${pollSeparator(now)}`);

  // Pad the subscription names to the longest so the brackets and everything
  // after them line up in a column across subscriptions.
  const nameWidth = Math.max(0, ...watch.subscriptions.map((s) => s.name.length));

  for (const sub of watch.subscriptions) {
    const result: SubscriptionPollResult = {
      subscription: sub.name,
      ready: 0,
      listed: 0,
      downloaded: 0,
      failed: 0,
      alreadyHad: 0,
    };
    results.push(result);

    // Every line leads with the subscription so you can tell where it came from
    // without per-subscription headers.
    const prefix = `[${sub.name.padEnd(nameWidth)}] `;

    const matching = channels.filter((c) => channelMatches(sub, c));
    if (matching.length === 0) {
      console.log(`${prefix}${status("no match")} no channel matches "${sub.channel}"`);
      continue;
    }
    const before = sub.paddingBefore ?? config.paddingBefore;
    const after = sub.paddingAfter ?? config.paddingAfter;
    const comskip = sub.comskip ?? config.comskip;
    // No "from" means take the whole archive (file-exists dedup stops repeats).
    const cutoff = sub.from ? Date.parse(sub.from) : Number.NEGATIVE_INFINITY;

    for (const channel of matching) {
      const programs = await source.programs(channel);
      for (const program of programs) {
        if (!titleMatches(sub, program.title)) continue;
        if (!isDue(program, after, watch.readyGraceMinutes, cutoff, now)) continue;
        result.ready++;

        const when = program.startLocal.slice(0, 16);
        const filename = outputFilename(
          config,
          channel,
          program,
          sub.filenameTemplate,
          sub.filenameStrip,
        );
        const outputPath = path.join(config.downloadDir, filename);
        if (existsSync(outputPath)) {
          result.alreadyHad++;
          // Refresh the sidecar even when the file is already there, so an
          // existing recording still gets (or updates) its .nfo. Note it on the
          // line only when it actually changed.
          let note = "";
          if (config.writeNfo) {
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
          if (comskip) {
            try {
              // Backfill: generate the .edl for a recording we already have but
              // that's missing one. It only runs comskip once, then no-ops.
              await ensureEdl(outputPath);
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
        if (await downloadProgram(config, source, channel, program, before, after, filename, prefix, comskip)) {
          result.downloaded++;
        } else {
          result.failed++;
        }
      }
    }

  }

  // One summary for the whole poll, under the separator and any activity.
  console.log(`\n${pollSummaryLine(results, watch.subscriptions.length, dryRun)}`);

  return results;
}

// A full-width rule carrying the poll time, e.g. "── 2026-06-28 16:03:21 ──…".
function pollSeparator(now: number): string {
  const label = `── ${stamp(now)} `;
  return label + "─".repeat(Math.max(0, 60 - label.length));
}

function pollSummaryLine(
  results: SubscriptionPollResult[],
  subscriptions: number,
  dryRun: boolean,
): string {
  const total = results.reduce(
    (acc, r) => ({
      listed: acc.listed + r.listed,
      downloaded: acc.downloaded + r.downloaded,
      failed: acc.failed + r.failed,
      alreadyHad: acc.alreadyHad + r.alreadyHad,
    }),
    { listed: 0, downloaded: 0, failed: 0, alreadyHad: 0 },
  );

  const parts = [`${subscriptions} sub${subscriptions === 1 ? "" : "s"}`];
  if (dryRun) {
    parts.push(total.listed ? `${total.listed} would download` : "nothing new");
  } else if (total.downloaded || total.failed) {
    parts.push(`${total.downloaded} downloaded`);
    if (total.failed) parts.push(`${total.failed} failed`);
  } else {
    parts.push("nothing new");
  }
  if (total.alreadyHad) parts.push(`${total.alreadyHad} already had`);
  return parts.join(" · ");
}

export async function runWatch(config: Config, dryRun = false): Promise<void> {
  const source: Source = new XtreamSource(config);
  console.log(await source.connect());

  // Loaded fresh each loop so edits to the file are picked up without a restart.
  let watch = loadWatchConfig();
  console.log(
    `${dryRun ? "Dry run: watching" : "Watching"} ${watch.subscriptions.length} subscription(s), ` +
      `polling every ${watch.pollIntervalMinutes} min.${dryRun ? " Nothing will be downloaded." : ""}`,
  );

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
