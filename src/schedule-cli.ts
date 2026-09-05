import { select } from "@inquirer/prompts";
import type { Config } from "./config.js";
import { loadSchedule, removeScheduled, toProgram, type ScheduledRecording } from "./scheduled.js";
import { readyAtLocal } from "./timeshift.js";

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

/** See what's scheduled, and drop anything you've changed your mind about. */
export async function manageScheduled(
  config: Config,
  readyGraceMinutes: number,
): Promise<void> {
  for (;;) {
    const recordings = order(loadSchedule());
    const width = Math.max(0, ...recordings.map((r) => r.channel.length));
    const describe = (r: ScheduledRecording) => label(r, config, readyGraceMinutes, width);

    console.log("");
    if (recordings.length === 0) {
      console.log("  Nothing scheduled.");
      return;
    }
    for (const recording of recordings) console.log(`  ${describe(recording)}`);
    console.log("");

    const id = await select<string>({
      message: "Remove which?",
      choices: [
        ...recordings.map((r) => ({ name: describe(r), value: r.id })),
        { name: "Back", value: "" },
      ],
    });

    if (!id) {
      if (recordings.some((r) => r.status === "pending")) {
        console.log(`\n  Run "timeshifter watch" to have these downloaded.`);
      }
      return;
    }
    removeScheduled(id);
    console.log("Removed.");
  }
}
