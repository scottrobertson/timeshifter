import { search, confirm, select, number, input } from "@inquirer/prompts";
import type { Config } from "./config.js";
import type { Channel, EpgProgram, Source } from "./source.js";
import { XtreamSource } from "./xtream.js";
import {
  download,
  ensureEdl,
  outputFilename,
  recordingWindow,
  setFileTime,
  syncNfo,
} from "./timeshift.js";

function formatProgramTime(program: EpgProgram): string {
  // Trim "YYYY-MM-DD HH:MM:SS" -> "YYYY-MM-DD HH:MM".
  return program.startLocal.slice(0, 16);
}

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
): Promise<EpgProgram> {
  const now = Date.now();
  const tz = timezone ? ` ${timezone}` : "";
  const choices = programs.map((program, index) => {
    const airing = program.start.getTime() <= now && program.end.getTime() > now;
    const suffix = airing ? "  [now airing — partial]" : "";
    return {
      name: `${formatProgramTimeRange(program)}${tz} · ${program.title}${suffix}`,
      value: index,
      description: program.description || undefined,
    };
  });

  const index = await search<number>({
    message: "Pick a program to download (type to filter):",
    source: async (input) => {
      const term = (input ?? "").toLowerCase();
      if (!term) return choices;
      return choices.filter((choice) => choice.name.toLowerCase().includes(term));
    },
  });
  return programs[index]!;
}

async function downloadOne(config: Config, source: Source): Promise<void> {
  const channels = await source.archiveChannels();
  if (channels.length === 0) {
    console.log("No channels with a catchup archive were found.");
    return;
  }
  console.log(`${channels.length} channels with an archive available.\n`);

  const channel = await pickChannel(channels);

  const epg = await source.programs(channel);
  const now = Date.now();
  // Only programs that have already started and are inside the archive window.
  const downloadable = epg.filter((p) => p.hasArchive && p.start.getTime() <= now);

  if (downloadable.length === 0) {
    console.log(`No archived programs available for ${channel.name}.`);
    return;
  }

  const program = await pickProgram(downloadable, source.timezone);
  let filename = outputFilename(config, channel, program);
  const programMinutes = Math.round(
    (program.end.getTime() - program.start.getTime()) / 60_000,
  );

  let before = config.paddingBefore;
  let after = config.paddingAfter;
  let window = recordingWindow(program, before, after);

  const printPlan = (): void => {
    const padding =
      before || after ? `${before} min before, ${after} min after` : "none";
    const tz = source.timezone ? ` ${source.timezone}` : "";
    console.log("");
    console.log(`  Channel:  ${channel.name}`);
    console.log(`  Program:  ${program.title}`);
    console.log(`  Aired:    ${formatProgramTime(program)}${tz}`);
    console.log(`  Ended:    ${program.endLocal.slice(0, 16)}${tz}`);
    console.log(`  Runtime:  ${programMinutes} min`);
    console.log("");
    console.log(`  Padding:  ${padding}`);
    console.log(`  Start:    ${window.startLocal.slice(0, 16)}${tz}`);
    console.log(`  End:      ${window.endLocal.slice(0, 16)}${tz}`);
    console.log(`  Length:   ${window.minutes} min`);
    console.log(`  Saving:   ${config.downloadDir}/${filename}`);
    console.log("");
  };

  printPlan();

  // Default action is "Download", so the common case is a single Enter.
  // Padding can be adjusted (negative values trim) without re-picking the show.
  for (;;) {
    const action = await select({
      message: "Download this?",
      choices: [
        { name: "Download", value: "download" },
        { name: "Adjust padding", value: "adjust" },
        { name: "Edit filename", value: "filename" },
        { name: "Cancel", value: "cancel" },
      ],
    });
    if (action === "cancel") {
      console.log("Skipped.");
      return;
    }
    if (action === "download") break;

    if (action === "filename") {
      filename = (
        await input({
          message: "Filename:",
          default: filename,
          prefill: "editable",
          validate: (v) => v.trim().length > 0 || "Enter a filename.",
        })
      ).trim();
      printPlan();
      continue;
    }

    console.log("\nMinutes to add at each end. A negative number records less.");
    before = Math.round((await number({ message: "Before:", default: before })) ?? before);
    after = Math.round((await number({ message: "After:", default: after })) ?? after);
    window = recordingWindow(program, before, after);
    printPlan();
  }

  const url = source.catchupUrl(channel, window);
  console.log(""); // blank line above the progress bar
  const result = await download(config, url, filename);

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

  if (config.writeNfo) {
    try {
      await syncNfo(program, result.outputPath, new Date());
      console.log("  ✓ Wrote .nfo metadata");
    } catch {
      console.log("  ⚠️  Could not write the .nfo");
    }
  }

  if (config.comskip) {
    try {
      await ensureEdl(result.outputPath);
      console.log("  ✓ Generated the .edl (comskip)");
    } catch (err) {
      console.log(`  ⚠️  comskip failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n  Saved: ${result.outputPath}`);
}

export async function run(config: Config): Promise<void> {
  const source: Source = new XtreamSource(config);

  console.log(await source.connect());
  console.log("");

  let again = true;
  while (again) {
    await downloadOne(config, source);
    again = await confirm({ message: "Download another?", default: false });
    console.log("");
  }
}
