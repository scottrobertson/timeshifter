import { input, number, select } from "@inquirer/prompts";
import type { Config } from "./config.js";
import type { Channel, EpgProgram } from "./source.js";
import { BACK, backable, type Back } from "./prompts.js";
import { outputFilename, plannedWindow, readyAtLocal, recordingWindow } from "./timeshift.js";

// How a recording will be made: the filename, the padding, and whether the .nfo
// and comskip run. The interactive prompt, scheduled recordings and watch mode
// all go through here. A new option added to RecordingPlan gets offered at the
// prompt and used everywhere, and only needs a line in scheduled.ts to be saved
// against a scheduled recording.

/** Everything you can change at the prompt before a recording happens. */
export interface RecordingPlan {
  filename: string;
  paddingBefore: number;
  paddingAfter: number;
  writeNfo: boolean;
  comskip: boolean;
}

/** What a subscription or a scheduled recording saved, if anything. */
export interface PlanOverrides extends Partial<RecordingPlan> {
  filenameTemplate?: string;
  filenameStrip?: string[];
}

/**
 * The settings to record with: whatever was saved against the subscription or
 * scheduled recording, and config.json for the rest.
 */
export function resolvePlan(
  config: Config,
  channel: Channel,
  program: EpgProgram,
  overrides: PlanOverrides = {},
): RecordingPlan {
  return {
    filename:
      overrides.filename ??
      outputFilename(
        config,
        channel,
        program,
        overrides.filenameTemplate,
        overrides.filenameStrip,
      ),
    paddingBefore: overrides.paddingBefore ?? config.paddingBefore,
    paddingAfter: overrides.paddingAfter ?? config.paddingAfter,
    writeNfo: overrides.writeNfo ?? config.writeNfo,
    comskip: overrides.comskip ?? config.comskip,
  };
}

export interface PlanContext {
  config: Config;
  channel: Channel;
  program: EpgProgram;
  /** The provider's timezone, shown next to every time so they aren't read as yours. */
  timezone?: string;
  /** Set for a show that hasn't aired yet, so the plan says when it'll be ready. */
  upcoming: boolean;
  /** Extra minutes to wait for the catchup to appear, only used for the "Ready" line. */
  readyGraceMinutes: number;
}

export interface PlanAction {
  /** The question above the options, e.g. "Download this?". */
  message: string;
  /** The go-ahead option, e.g. "Download" or "Schedule". */
  confirm: string;
  /** Runs on the go-ahead. Return false to go back to the options. */
  check?: (plan: RecordingPlan) => Promise<boolean>;
}

/** What the prompt starts on: everything from config.json, nothing changed yet. */
export function defaultPlan({ config, channel, program }: PlanContext): RecordingPlan {
  return resolvePlan(config, channel, program);
}

/**
 * Only the settings that were changed at the prompt. A scheduled recording saves
 * these and nothing else, so a later edit to config.json still applies to
 * everything that was left alone.
 */
export function planOverrides(
  plan: RecordingPlan,
  defaults: RecordingPlan,
): Partial<RecordingPlan> {
  return Object.fromEntries(
    Object.entries(plan).filter(
      ([key, value]) => value !== defaults[key as keyof RecordingPlan],
    ),
  );
}

/** The plan block, as lines, so it can be checked without a terminal. */
export function planLines(context: PlanContext, plan: RecordingPlan): string[] {
  const { config, channel, program, upcoming } = context;
  const runtime = Math.round((program.end.getTime() - program.start.getTime()) / 60_000);
  // A show that hasn't aired has no footage to cap the window against, so use the
  // whole thing rather than the minute or so of it that exists.
  const window = upcoming
    ? plannedWindow(program, plan.paddingBefore, plan.paddingAfter)
    : recordingWindow(program, plan.paddingBefore, plan.paddingAfter);
  const padding =
    plan.paddingBefore || plan.paddingAfter
      ? `${plan.paddingBefore} min before, ${plan.paddingAfter} min after`
      : "none";

  // Trim "YYYY-MM-DD HH:MM:SS" -> "YYYY-MM-DD HH:MM", and name the timezone.
  const at = (local: string): string =>
    `${local.slice(0, 16)}${context.timezone ? ` ${context.timezone}` : ""}`;

  const lines = [
    "",
    `  Channel:  ${channel.name}`,
    `  Program:  ${program.title}`,
    upcoming
      ? `  Airs:     ${at(program.startLocal)}`
      : `  Aired:    ${at(program.startLocal)}`,
    upcoming ? `  Ends:     ${at(program.endLocal)}` : `  Ended:    ${at(program.endLocal)}`,
    `  Runtime:  ${runtime} min`,
    "",
    `  Padding:  ${padding}`,
    `  Start:    ${at(window.startLocal)}`,
    `  End:      ${at(window.endLocal)}`,
    `  Length:   ${window.minutes} min`,
  ];

  if (upcoming) {
    const ready = readyAtLocal(program, plan.paddingAfter + context.readyGraceMinutes);
    lines.push(`  Ready:    ${at(ready)}`);
  }

  lines.push(
    `  Saving:   ${config.downloadDir}/${plan.filename}`,
    `  .nfo:     ${plan.writeNfo ? "write" : "skip"}`,
    `  comskip:  ${plan.comskip ? "run" : "skip"}`,
    "",
  );
  return lines;
}

/**
 * Show the plan and let someone change it until they go ahead. Gives back what
 * they settled on, nothing if they cancelled, or BACK if they pressed esc.
 */
export async function reviewPlan(
  context: PlanContext,
  action: PlanAction,
): Promise<RecordingPlan | Back | undefined> {
  const plan = defaultPlan(context);
  const print = (): void => console.log(planLines(context, plan).join("\n"));

  print();

  // The go-ahead is the first option, so the common case is a single Enter.
  for (;;) {
    const choice = await backable((promptContext) =>
      select(
        {
          message: action.message,
          choices: [
            { name: action.confirm, value: "confirm" },
            { name: "Adjust padding", value: "padding" },
            { name: "Edit filename", value: "filename" },
            {
              name: `Write .nfo:  ${plan.writeNfo ? "on" : "off"}  (select to turn ${plan.writeNfo ? "off" : "on"})`,
              value: "toggle-nfo",
            },
            {
              name: `Run comskip: ${plan.comskip ? "on" : "off"}  (select to turn ${plan.comskip ? "off" : "on"})`,
              value: "toggle-comskip",
            },
            { name: "Cancel", value: "cancel" },
          ],
        },
        promptContext,
      ),
    );

    if (choice === BACK) return BACK;
    if (choice === "cancel") return undefined;

    if (choice === "confirm") {
      if (action.check && !(await action.check(plan))) continue;
      return plan;
    }

    if (choice === "filename") {
      const filename = await backable((promptContext) =>
        input(
          {
            message: "Filename:",
            default: plan.filename,
            prefill: "editable",
            validate: (v) => v.trim().length > 0 || "Enter a filename.",
          },
          promptContext,
        ),
      );
      if (filename !== BACK) plan.filename = filename.trim();
    } else if (choice === "toggle-nfo") {
      plan.writeNfo = !plan.writeNfo;
    } else if (choice === "toggle-comskip") {
      plan.comskip = !plan.comskip;
    } else if (choice === "padding") {
      console.log("\nMinutes to add at each end. A negative number records less.");
      // Esc on the first question leaves the padding alone, rather than changing
      // one end and not the other.
      const before = await backable((promptContext) =>
        number({ message: "Before:", default: plan.paddingBefore }, promptContext),
      );
      if (before !== BACK) {
        plan.paddingBefore = Math.round(before ?? plan.paddingBefore);
        const after = await backable((promptContext) =>
          number({ message: "After:", default: plan.paddingAfter }, promptContext),
        );
        if (after !== BACK) plan.paddingAfter = Math.round(after ?? plan.paddingAfter);
      }
    }

    print();
  }
}
