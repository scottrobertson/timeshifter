import { existsSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { Channel, EpgProgram, Source } from "./source.js";
import { XtreamSource } from "./xtream.js";
import { download, outputFilename, recordingWindow, setFileTime, syncNfo } from "./timeshift.js";
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
    console.log(`${prefix}${status("✓ saved")} ${result.outputPath}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const when = program.startLocal.slice(0, 16);
    // Name the program here: this goes to stderr, so the logs can interleave it
    // away from the "download" line, and a leading newline clears the progress bar.
    console.error(
      `\n${prefix}${status("✗ failed")} ${when} · ${program.title} · will retry next poll: ${message}`,
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

  // Print the poll header once, the first time there's anything worth showing.
  // A quiet poll (nothing new, everything already downloaded) never prints it,
  // so a steady state is just one summary line instead of a screen of skips.
  let headerShown = false;
  const showHeader = () => {
    if (headerShown) return;
    console.log(`\n[${stamp(now)}]`);
    headerShown = true;
  };

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
    const prefix = `[${sub.name}] `;

    const matching = channels.filter((c) => channelMatches(sub, c));
    if (matching.length === 0) {
      showHeader();
      console.log(`${prefix}${status("no match")} no channel matches "${sub.channel}"`);
      continue;
    }
    const before = sub.paddingBefore ?? config.paddingBefore;
    const after = sub.paddingAfter ?? config.paddingAfter;
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
          showHeader();
          console.log(`${prefix}${status("have")} ${when} · ${program.title}${note}`);
          continue;
        }

        const label = dryRun ? "would get" : "download";
        showHeader();
        console.log(`${prefix}${status(label)} ${when} · ${program.title}`);
        result.listed++;
        if (dryRun) continue;
        if (await downloadProgram(config, source, channel, program, before, after, filename, prefix)) {
          result.downloaded++;
        } else {
          result.failed++;
        }
      }
    }

  }

  // One summary for the whole poll. When the header was shown it follows the
  // activity; when the poll was quiet it carries its own timestamp so there's
  // still a heartbeat line.
  const line = pollSummaryLine(results, watch.subscriptions.length, dryRun);
  console.log(headerShown ? `\n${line}` : `\n[${stamp(now)}] ${line}`);

  return results;
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
