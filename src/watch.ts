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
    console.log(`${status("✓ saved")} ${result.outputPath}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A leading newline: a failed download leaves the cursor on the progress bar.
    console.error(`\n${status("✗ failed")} will retry next poll: ${message}`);
    return false;
  }
}

async function pollOnce(
  config: Config,
  source: Source,
  watch: WatchConfig,
  dryRun: boolean,
): Promise<void> {
  const now = Date.now();
  const channels = await source.archiveChannels();

  for (const sub of watch.subscriptions) {
    console.log(`\n[${stamp(now)}] ${sub.name}`);

    const matching = channels.filter((c) => channelMatches(sub, c));
    if (matching.length === 0) {
      console.log(`No channel matches "${sub.channel}".`);
      continue;
    }
    const before = sub.paddingBefore ?? config.paddingBefore;
    const after = sub.paddingAfter ?? config.paddingAfter;
    // No "from" means take the whole archive (file-exists dedup stops repeats).
    const cutoff = sub.from ? Date.parse(sub.from) : Number.NEGATIVE_INFINITY;

    let ready = 0;
    let listed = 0;
    let downloaded = 0;
    let failed = 0;
    let alreadyHad = 0;
    for (const channel of matching) {
      const programs = await source.programs(channel);
      for (const program of programs) {
        if (!titleMatches(sub, program.title)) continue;
        if (!isDue(program, after, watch.readyGraceMinutes, cutoff, now)) continue;
        ready++;

        const when = program.startLocal.slice(0, 16);
        const filename = outputFilename(config, channel, program, sub.filenameTemplate);
        const outputPath = path.join(config.downloadDir, filename);
        if (existsSync(outputPath)) {
          alreadyHad++;
          // Refresh the sidecar even when the download is skipped, so an existing
          // recording still gets (or updates) its .nfo. Only note real changes.
          let note = "";
          if (config.writeNfo) {
            try {
              const nfo = await syncNfo(program, outputPath, new Date());
              if (nfo.status !== "unchanged") note = ` · ${nfo.status} .nfo`;
            } catch {
              // Non-fatal: the recording is there, only its .nfo didn't update.
            }
          }
          console.log(`${status("skip")} ${when} · ${program.title}${note}`);
          continue;
        }

        const label = dryRun ? "would get" : "download";
        console.log(`${status(label)} ${when} · ${program.title}`);
        listed++;
        if (dryRun) continue;
        if (await downloadProgram(config, source, channel, program, before, after, filename)) {
          downloaded++;
        } else {
          failed++;
        }
      }
    }

    const outcome = dryRun
      ? `${listed} would download`
      : `${downloaded} downloaded${failed ? `, ${failed} failed` : ""}`;
    console.log(`\n${ready} ready · ${outcome} · ${alreadyHad} already had`);
  }
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
