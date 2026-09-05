import { existsSync } from "node:fs";
import path from "node:path";
import { search, confirm } from "@inquirer/prompts";
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
import { defaultPlan, planOverrides, reviewPlan, type PlanContext } from "./plan.js";
import { addScheduled, newRecording, snapshotOf } from "./scheduled.js";
import { loadWatchConfig } from "./subscriptions.js";

export function formatLocalRange(startLocal: string, endLocal: string): string {
  // "YYYY-MM-DD HH:MM-HH:MM", but if the range ends on a different day, show the
  // end date too: "YYYY-MM-DD HH:MM-YYYY-MM-DD HH:MM".
  const start = startLocal.slice(0, 16);
  const sameDay = startLocal.slice(0, 10) === endLocal.slice(0, 10);
  const end = sameDay ? endLocal.slice(11, 16) : endLocal.slice(0, 16);
  return `${start}-${end}`;
}

export function formatProgramTimeRange(program: EpgProgram): string {
  return formatLocalRange(program.startLocal, program.endLocal);
}

async function pickChannel(channels: Channel[]): Promise<Channel> {
  // Channels are grouped by category (provider order); show the group inline.
  const label = (c: Channel): string =>
    c.group
      ? `${c.group} · ${c.name}  (${c.archiveDays}d archive)`
      : `${c.name}  (${c.archiveDays}d archive)`;

  const index = await search<number>({
    message: "Search for a channel (type to filter):",
    source: async (input) => {
      const term = (input ?? "").toLowerCase();
      return channels
        .map((channel, i) => ({ channel, i }))
        .filter(
          ({ channel }) =>
            !term || `${channel.group ?? ""} ${channel.name}`.toLowerCase().includes(term),
        )
        .map(({ channel, i }) => ({ name: label(channel), value: i }));
    },
  });
  return channels[index]!;
}

async function pickProgram(
  programs: EpgProgram[],
  timezone: string | undefined,
  message = "Pick a program (type to filter):",
): Promise<EpgProgram> {
  const now = Date.now();
  const tz = timezone ? ` ${timezone}` : "";
  const choices = programs.map((program, index) => {
    const airing = program.start.getTime() <= now && program.end.getTime() > now;
    const upcoming = program.start.getTime() > now;
    const suffix = upcoming
      ? "  [upcoming — schedule]"
      : airing
        ? "  [now airing — partial]"
        : "";
    return {
      name: `${formatProgramTimeRange(program)}${tz} · ${program.title}${suffix}`,
      value: index,
      description: program.description || undefined,
    };
  });

  const index = await search<number>({
    message,
    source: async (input) => {
      const term = (input ?? "").toLowerCase();
      if (!term) return choices;
      return choices.filter((choice) => choice.name.toLowerCase().includes(term));
    },
  });
  return programs[index]!;
}

/**
 * Shows still to come, with whatever is on next at the top. The guide arrives
 * newest first, which suits a list of past shows but puts next week above tonight.
 */
export function upcomingSoonestFirst(programs: EpgProgram[], now: number): EpgProgram[] {
  return programs
    .filter((p) => p.start.getTime() > now)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Pick a channel and a show that hasn't aired yet, and add it to the schedule.
 * The same thing the main flow does when you land on an upcoming show, but it
 * only offers shows that are still to come.
 */
export async function scheduleOne(
  config: Config,
  source: Source,
  readyGraceMinutes: number,
): Promise<void> {
  const channels = await source.archiveChannels();
  if (channels.length === 0) {
    console.log("No channels with a catchup archive were found.");
    return;
  }

  const channel = await pickChannel(channels);
  const upcoming = upcomingSoonestFirst(await source.programs(channel), Date.now());

  if (upcoming.length === 0) {
    console.log(`The guide has nothing coming up for ${channel.name}.`);
    return;
  }

  const program = await pickProgram(
    upcoming,
    source.timezone,
    "Pick a show to record (type to filter):",
  );
  await scheduleUpcoming(config, source, channel, program, readyGraceMinutes);
}

async function downloadOne(
  config: Config,
  source: Source,
  readyGraceMinutes: number,
): Promise<void> {
  const channels = await source.archiveChannels();
  if (channels.length === 0) {
    console.log("No channels with a catchup archive were found.");
    return;
  }
  console.log(`${channels.length} channels with an archive available.\n`);

  const channel = await pickChannel(channels);

  const epg = await source.programs(channel);
  const now = Date.now();
  // A past show only if it's still in the archive. Anything still to come can be
  // scheduled instead, and downloaded once it has aired.
  const pickable = epg.filter((p) => p.start.getTime() > now || p.hasArchive);

  if (pickable.length === 0) {
    console.log(`Nothing archived or coming up for ${channel.name}.`);
    return;
  }

  const program = await pickProgram(pickable, source.timezone);
  if (program.start.getTime() > Date.now()) {
    await scheduleUpcoming(config, source, channel, program, readyGraceMinutes);
    return;
  }
  await downloadNow(config, source, channel, program);
}

/**
 * Save an upcoming show to the schedule. It can't be downloaded yet, because the
 * catchup only exists once the show has aired, so watch mode picks it up later.
 */
async function scheduleUpcoming(
  config: Config,
  source: Source,
  channel: Channel,
  program: EpgProgram,
  readyGraceMinutes: number,
): Promise<void> {
  const context: PlanContext = {
    config,
    channel,
    program,
    timezone: source.timezone,
    upcoming: true,
    readyGraceMinutes,
  };

  const plan = await reviewPlan(context, { message: "Schedule this?", confirm: "Schedule" });
  if (!plan) {
    console.log("Skipped.");
    return;
  }

  addScheduled(
    newRecording({
      channel: channel.name,
      program: snapshotOf(program),
      ...planOverrides(plan, defaultPlan(context)),
    }),
  );

  const ready = readyAtLocal(program, plan.paddingAfter + readyGraceMinutes).slice(0, 16);
  console.log(`\n  Scheduled. Watch mode will download it after ${ready}.`);
  console.log(`  Run "timeshifter watch" if it isn't already running.`);
}

async function downloadNow(
  config: Config,
  source: Source,
  channel: Channel,
  program: EpgProgram,
): Promise<void> {
  const plan = await reviewPlan(
    {
      config,
      channel,
      program,
      timezone: source.timezone,
      upcoming: false,
      readyGraceMinutes: 0,
    },
    {
      message: "Download this?",
      confirm: "Download",
      check: async ({ filename }) => {
        if (!existsSync(path.join(config.downloadDir, filename))) return true;
        // Saying no goes back to the options, so you can rename it instead.
        return confirm({
          message: `${filename} already exists. Overwrite it?`,
          default: false,
        });
      },
    },
  );
  if (!plan) {
    console.log("Skipped.");
    return;
  }

  const window = recordingWindow(program, plan.paddingBefore, plan.paddingAfter);
  const url = source.catchupUrl(channel, window);
  console.log(""); // blank line above the progress bar
  const result = await download(config, url, plan.filename);

  // Set the file's time to when the show aired, so it sorts by air date in a
  // media library rather than by when it was downloaded.
  if (config.setAiredTime) {
    try {
      await setFileTime(result.outputPath, program.end);
      console.log("  ✓ Set the file date to when it aired");
    } catch {
      console.log("  ⚠️  Could not set the file date");
    }
  }

  if (plan.writeNfo) {
    try {
      await syncNfo(program, result.outputPath, new Date());
      console.log("  ✓ Wrote .nfo metadata");
    } catch {
      console.log("  ⚠️  Could not write the .nfo");
    }
  }

  if (plan.comskip) {
    try {
      const { commercials } = await ensureEdl(result.outputPath);
      console.log(`  ✓ Generated the .edl (comskip) · ${commercials} ${commercials === 1 ? "ad break" : "ad breaks"} found`);
    } catch (err) {
      console.log(`  ⚠️  comskip failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n  Saved: ${result.outputPath}`);
}

export async function run(config: Config): Promise<void> {
  const source: Source = new XtreamSource(config);

  // Only needed to tell you when a scheduled recording will happen. Not worth
  // failing the whole run over, so a broken watch block just means no grace.
  let readyGraceMinutes = 0;
  try {
    readyGraceMinutes = loadWatchConfig().readyGraceMinutes;
  } catch {
    // Keep the default.
  }

  console.log(await source.connect());
  console.log("");

  let again = true;
  while (again) {
    await downloadOne(config, source, readyGraceMinutes);
    again = await confirm({ message: "Pick another?", default: false });
    console.log("");
  }
}
