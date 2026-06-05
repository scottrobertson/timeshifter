import { search, select, confirm } from "@inquirer/prompts";
import type { Config } from "./config.js";
import { XtreamClient, type Channel, type EpgProgram } from "./xtream.js";
import {
  buildTimeshiftUrl,
  download,
  outputFilename,
  recordingWindow,
} from "./timeshift.js";

function formatProgramTime(program: EpgProgram): string {
  // Trim "YYYY-MM-DD HH:MM:SS" -> "YYYY-MM-DD HH:MM" (server-local, matches the guide).
  return program.startLocal.slice(0, 16);
}

async function pickChannel(channels: Channel[]): Promise<Channel> {
  const streamId = await search<number>({
    message: "Search for a channel (type to filter):",
    source: async (input) => {
      const term = (input ?? "").toLowerCase();
      return channels
        .filter((c) => !term || c.name.toLowerCase().includes(term))
        .slice(0, 50)
        .map((c) => ({
          name: `${c.name}  (${c.archiveDays}d archive)`,
          value: c.streamId,
        }));
    },
  });

  const channel = channels.find((c) => c.streamId === streamId);
  if (!channel) throw new Error("Channel not found");
  return channel;
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

  const index = await select<number>({
    message: "Pick a program to download:",
    choices,
    pageSize: 15,
  });
  return programs[index]!;
}

async function downloadOne(config: Config, client: XtreamClient): Promise<void> {
  const channels = await client.getArchiveChannels();
  if (channels.length === 0) {
    console.log("No channels with a timeshift archive were found on this account.");
    return;
  }
  console.log(`${channels.length} channels with an archive available.\n`);

  const channel = await pickChannel(channels);

  const epg = await client.getEpg(channel.streamId);
  const now = Date.now();
  // Only programs that have already started and are inside the archive window.
  const downloadable = epg.filter(
    (p) => p.hasArchive && p.start.getTime() <= now,
  );

  if (downloadable.length === 0) {
    console.log(`No archived programs available for ${channel.name}.`);
    return;
  }

  const program = await pickProgram(downloadable);
  const { startLocal, minutes } = recordingWindow(config, program);
  const url = buildTimeshiftUrl(config, channel.streamId, startLocal, minutes);
  const filename = outputFilename(config, channel, program);

  const padding =
    config.paddingBefore || config.paddingAfter
      ? `  (+${config.paddingBefore} before / +${config.paddingAfter} after)`
      : "";

  console.log("");
  console.log(`  Channel:  ${channel.name}`);
  console.log(`  Program:  ${program.title}`);
  console.log(`  Start:    ${formatProgramTime(program)}`);
  console.log(`  Length:   ${minutes} min${padding}`);
  console.log(`  Saving:   ${config.downloadDir}/${filename}`);
  console.log("");

  const go = await confirm({ message: "Download this?", default: true });
  if (!go) {
    console.log("Skipped.");
    return;
  }

  const { outputPath } = await download(config, url, minutes, filename);
  console.log(`\nDone: ${outputPath}`);
}

export async function run(config: Config): Promise<void> {
  const client = new XtreamClient(config);

  const account = await client.authenticate();
  console.log(`Connected. Account status: ${account.status}`);
  if (account.expDate) {
    console.log(`Expires: ${account.expDate.toLocaleDateString()}`);
  }
  console.log("");

  let again = true;
  while (again) {
    await downloadOne(config, client);
    again = await confirm({ message: "Download another?", default: false });
    console.log("");
  }
}
