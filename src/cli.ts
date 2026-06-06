import { search, confirm } from "@inquirer/prompts";
import type { Config } from "./config.js";
import type { Channel, EpgProgram, Source } from "./source.js";
import { XtreamSource } from "./xtream.js";
import {
  download,
  outputFilename,
  recordingWindow,
  setFileTime,
  type DownloadResult,
} from "./timeshift.js";

function formatProgramTime(program: EpgProgram): string {
  // Trim "YYYY-MM-DD HH:MM:SS" -> "YYYY-MM-DD HH:MM".
  return program.startLocal.slice(0, 16);
}

/** Reports the downloaded size and warns if it came up well short of expected. */
function reportSize(result: DownloadResult): void {
  const mb = (result.bytesDownloaded / 1_000_000).toFixed(0);
  console.log(`Downloaded ${mb} MB.`);
  if (result.expectedBytes && result.bytesDownloaded < result.expectedBytes * 0.99) {
    const expectedMb = (result.expectedBytes / 1_000_000).toFixed(0);
    console.log(
      `⚠️  Expected about ${expectedMb} MB, so this may be incomplete. Check the file before relying on it.`,
    );
  }
}

async function pickChannel(channels: Channel[]): Promise<Channel> {
  const index = await search<number>({
    message: "Search for a channel (type to filter):",
    source: async (input) => {
      const term = (input ?? "").toLowerCase();
      return channels
        .map((channel, i) => ({ channel, i }))
        .filter(({ channel }) => !term || channel.name.toLowerCase().includes(term))
        .slice(0, 50)
        .map(({ channel, i }) => ({
          name: `${channel.name}  (${channel.archiveDays}d archive)`,
          value: i,
        }));
    },
  });
  return channels[index]!;
}

async function pickProgram(programs: EpgProgram[]): Promise<EpgProgram> {
  const now = Date.now();
  const choices = programs.map((program, index) => {
    const airing = program.start.getTime() <= now && program.end.getTime() > now;
    const suffix = airing ? "  [now airing — partial]" : "";
    return {
      name: `${formatProgramTime(program)}  ${program.title}${suffix}`,
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

  const program = await pickProgram(downloadable);
  const window = recordingWindow(config, program);
  const url = source.catchupUrl(channel, window);
  const filename = outputFilename(config, channel, program);

  const programMinutes = Math.round(
    (program.end.getTime() - program.start.getTime()) / 60_000,
  );
  const paddingText =
    config.paddingBefore || config.paddingAfter
      ? `${config.paddingBefore} min before, ${config.paddingAfter} min after`
      : "none";

  console.log("");
  console.log(`  Channel:    ${channel.name}`);
  console.log(`  Program:    ${program.title}`);
  console.log(`  Aired:      ${formatProgramTime(program)}  (${programMinutes} min)`);
  console.log(`  Padding:    ${paddingText}`);
  console.log(`  Recording:  ${window.minutes} min from ${window.startLocal.slice(0, 16)}`);
  console.log(`  Saving:     ${config.downloadDir}/${filename}`);
  console.log("");

  const go = await confirm({ message: "Download this?", default: true });
  if (!go) {
    console.log("Skipped.");
    return;
  }

  // The server generates the timeshift on the fly, so it can take a moment to start.
  console.log("\nStarting… the stream can take a moment to begin.");
  const result = await download(config, url, filename);
  console.log(`\nDone: ${result.outputPath}`);
  reportSize(result);

  // Set the file's time to when the show aired, so it sorts by air date in a
  // media library rather than by when it was downloaded.
  if (config.setAiredTime) {
    try {
      await setFileTime(result.outputPath, program.end);
    } catch {
      console.log("Could not set the file's time to the air time.");
    }
  }
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
