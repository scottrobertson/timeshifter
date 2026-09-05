import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  defaultPlan,
  planLines,
  planOverrides,
  resolvePlan,
  type PlanContext,
  type RecordingPlan,
} from "../src/plan.js";
import type { Config } from "../src/config.js";
import type { Channel, EpgProgram } from "../src/source.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    baseUrl: "http://example.com:8080",
    username: "user",
    password: "pass",
    downloadDir: "/catchup",
    userAgent: undefined,
    timeshiftMode: "path",
    paddingBefore: 0,
    paddingAfter: 0,
    filenameTemplate: "{channel} - {title} - {datetime}.{ext}",
    filenameStrip: [],
    setAiredTime: true,
    writeNfo: true,
    comskip: false,
    ...overrides,
  };
}

const channel: Channel = { streamId: 42, name: "NASA TV", archiveDays: 7 };

function makeProgram(overrides: Partial<EpgProgram> = {}): EpgProgram {
  return {
    title: "Artemis II Launch",
    description: "Crewed lunar flyby.",
    // 2024 so the recording window is never capped at "now".
    start: new Date(Date.UTC(2024, 2, 10, 12, 0, 0)),
    end: new Date(Date.UTC(2024, 2, 10, 13, 0, 0)),
    startLocal: "2024-03-10 12:00:00",
    endLocal: "2024-03-10 13:00:00",
    hasArchive: true,
    ...overrides,
  };
}

function makeContext(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    config: makeConfig(),
    channel,
    program: makeProgram(),
    timezone: "Europe/London",
    upcoming: false,
    readyGraceMinutes: 0,
    ...overrides,
  };
}

/** The value of one "  Label:  value" line, so a test can name the line it means. */
function line(lines: string[], label: string): string | undefined {
  const found = lines.find((l) => l.trim().startsWith(`${label}:`));
  return found?.split(":").slice(1).join(":").trim();
}

describe("resolvePlan", () => {
  const config = makeConfig({ paddingBefore: 5, paddingAfter: 30, comskip: true });
  const program = makeProgram();

  it("takes everything from the config when nothing was saved", () => {
    assert.deepEqual(resolvePlan(config, channel, program), {
      filename: "NASA TV - Artemis II Launch - 2024-03-10_12-00.ts",
      paddingBefore: 5,
      paddingAfter: 30,
      writeNfo: true,
      comskip: true,
    });
  });

  it("prefers what was saved, field by field", () => {
    const plan = resolvePlan(config, channel, program, { paddingAfter: 90, comskip: false });
    assert.equal(plan.paddingAfter, 90);
    assert.equal(plan.comskip, false);
    assert.equal(plan.paddingBefore, 5);
    assert.equal(plan.writeNfo, true);
  });

  it("uses a saved filename as-is", () => {
    const plan = resolvePlan(config, channel, program, { filename: "Artemis II.ts" });
    assert.equal(plan.filename, "Artemis II.ts");
  });

  it("builds the filename from a saved template", () => {
    const plan = resolvePlan(config, channel, program, {
      filenameTemplate: "NASA/{title} - {date}.{ext}",
    });
    assert.equal(plan.filename, "NASA/Artemis II Launch - 2024-03-10.ts");
  });

  it("strips what a saved filenameStrip asks for", () => {
    const plan = resolvePlan(config, channel, makeProgram({ title: "Artemis II Launch ᴸᶦᵛᵉ" }), {
      filenameTemplate: "{title}.{ext}",
      filenameStrip: ["ᴸᶦᵛᵉ"],
    });
    assert.equal(plan.filename, "Artemis II Launch.ts");
  });

  it("takes the filename someone typed over their template", () => {
    const plan = resolvePlan(config, channel, program, {
      filename: "Artemis II.ts",
      filenameTemplate: "{title}.{ext}",
    });
    assert.equal(plan.filename, "Artemis II.ts");
  });
});

describe("planOverrides", () => {
  const context = makeContext();

  it("gives nothing back when nothing was changed", () => {
    assert.deepEqual(planOverrides(defaultPlan(context), defaultPlan(context)), {});
  });

  it("gives back only what was changed", () => {
    const plan: RecordingPlan = { ...defaultPlan(context), paddingAfter: 45, comskip: true };
    assert.deepEqual(planOverrides(plan, defaultPlan(context)), {
      paddingAfter: 45,
      comskip: true,
    });
  });

  it("counts a filename that was edited", () => {
    const plan: RecordingPlan = { ...defaultPlan(context), filename: "Artemis II.ts" };
    assert.deepEqual(planOverrides(plan, defaultPlan(context)), { filename: "Artemis II.ts" });
  });
});

describe("planLines", () => {
  const context = makeContext();

  it("says a past show aired, and shows the window it will record", () => {
    const lines = planLines(context, { ...defaultPlan(context), paddingBefore: 5, paddingAfter: 30 });
    assert.equal(line(lines, "Channel"), "NASA TV");
    assert.equal(line(lines, "Program"), "Artemis II Launch");
    assert.equal(line(lines, "Aired"), "2024-03-10 12:00 Europe/London");
    assert.equal(line(lines, "Ended"), "2024-03-10 13:00 Europe/London");
    assert.equal(line(lines, "Runtime"), "60 min");
    assert.equal(line(lines, "Padding"), "5 min before, 30 min after");
    assert.equal(line(lines, "Start"), "2024-03-10 11:55 Europe/London");
    assert.equal(line(lines, "End"), "2024-03-10 13:30 Europe/London");
    assert.equal(line(lines, "Length"), "95 min");
  });

  it("says an upcoming show airs, and when it will be ready", () => {
    const upcoming = makeContext({ upcoming: true, readyGraceMinutes: 10 });
    const lines = planLines(upcoming, { ...defaultPlan(upcoming), paddingAfter: 30 });
    assert.equal(line(lines, "Airs"), "2024-03-10 12:00 Europe/London");
    assert.equal(line(lines, "Ends"), "2024-03-10 13:00 Europe/London");
    assert.equal(line(lines, "Ready"), "2024-03-10 13:40 Europe/London");
  });

  it("leaves the ready line off a show that has already aired", () => {
    assert.equal(line(planLines(context, defaultPlan(context)), "Ready"), undefined);
  });

  it("shows where it will save, and what will run afterwards", () => {
    const lines = planLines(context, { ...defaultPlan(context), comskip: true });
    assert.equal(line(lines, "Saving"), "/catchup/NASA TV - Artemis II Launch - 2024-03-10_12-00.ts");
    assert.equal(line(lines, ".nfo"), "write");
    assert.equal(line(lines, "comskip"), "run");
  });

  it("shows a filename that was edited", () => {
    const lines = planLines(context, { ...defaultPlan(context), filename: "Artemis II.ts" });
    assert.equal(line(lines, "Saving"), "/catchup/Artemis II.ts");
  });

  it("says none when there's no padding", () => {
    assert.equal(line(planLines(context, defaultPlan(context)), "Padding"), "none");
  });

  it("leaves the timezone off when the provider didn't give one", () => {
    const lines = planLines(makeContext({ timezone: undefined }), defaultPlan(context));
    assert.equal(line(lines, "Aired"), "2024-03-10 12:00");
  });
});
