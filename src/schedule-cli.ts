import { select } from "@inquirer/prompts";
import { scheduleOne } from "./cli.js";
import type { Config } from "./config.js";
import { loadSchedule, removeScheduled, toProgram, type ScheduledRecording } from "./scheduled.js";
import type { Source } from "./source.js";
import { loadWatchConfig } from "./subscriptions.js";
import { readyAtLocal } from "./timeshift.js";
import { XtreamSource } from "./xtream.js";

/** Still to come at the top, soonest first, then the finished ones most recent first. */
function order(recordings: ScheduledRecording[]): ScheduledRecording[] {
  const pending = (r: ScheduledRecording) => r.status === "pending";
  const start = (r: ScheduledRecording) => Date.parse(r.program.start);
  return [...recordings].sort((a, b) => {
    if (pending(a) !== pending(b)) return pending(a) ? -1 : 1;
    return pending(a) ? start(a) - start(b) : start(b) - start(a);
  });
}

function label(
  recording: ScheduledRecording,
  config: Config,
  readyGraceMinutes: number,
  channelWidth: number,
): string {
  const when = recording.program.startLocal.slice(0, 16);
  const channel = recording.channel.padEnd(channelWidth);
  const status = recording.status.padEnd(7);

  if (recording.status === "pending") {
    const after = recording.paddingAfter ?? config.paddingAfter;
    const ready = readyAtLocal(toProgram(recording), after + readyGraceMinutes).slice(0, 16);
    return `${status} ${when}  ${channel}  ${recording.program.title}  ·  ready ${ready}`;
  }
  const tail = recording.outputPath ? `  ·  ${recording.outputPath}` : "";
  return `${status} ${when}  ${channel}  ${recording.program.title}${tail}`;
}

/** Set up one-off recordings, and see or drop the ones already set up. */
export async function runSchedule(config: Config): Promise<void> {
  // Only needed to say when a recording will happen. A broken watch block
  // shouldn't stop you scheduling, so fall back to no grace.
  let readyGraceMinutes = 0;
  try {
    readyGraceMinutes = loadWatchConfig().readyGraceMinutes;
  } catch {
    // Keep the default.
  }

  // Listing doesn't need the provider, so don't make someone wait on it just to
  // see what they've already set up.
  const source: Source = new XtreamSource(config);
  let connected = false;
  const connect = async (): Promise<void> => {
    if (connected) return;
    console.log(await source.connect());
    connected = true;
  };

  for (;;) {
    const recordings = order(loadSchedule());
    const width = Math.max(0, ...recordings.map((r) => r.channel.length));
    const describe = (r: ScheduledRecording) => label(r, config, readyGraceMinutes, width);

    console.log("");
    if (recordings.length === 0) {
      console.log("  Nothing scheduled.");
    } else {
      for (const recording of recordings) console.log(`  ${describe(recording)}`);
    }
    console.log("");

    const pending = recordings.filter((r) => r.status === "pending");
    const action = await select({
      message: "What do you want to do?",
      choices: [
        { name: "Schedule a show", value: "add" },
        ...(recordings.length ? [{ name: "Remove one", value: "remove" }] : []),
        { name: "Quit", value: "quit" },
      ],
    });

    if (action === "quit") {
      if (pending.length) {
        console.log(`\n  Run "timeshifter watch" to have these downloaded.`);
      }
      return;
    }

    if (action === "add") {
      await connect();
      console.log("");
      await scheduleOne(config, source, readyGraceMinutes);
      continue;
    }

    const id = await select<string>({
      message: "Remove which?",
      choices: [
        ...recordings.map((r) => ({ name: describe(r), value: r.id })),
        { name: "Cancel", value: "" },
      ],
    });
    if (id) {
      removeScheduled(id);
      console.log("Removed.");
    }
  }
}
