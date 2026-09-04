import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EpgProgram } from "../src/source.js";
import {
  addScheduled,
  findProgram,
  hasMoved,
  loadSchedule,
  newRecording,
  pruneSchedule,
  removeScheduled,
  saveSchedule,
  snapshotOf,
  toProgram,
  updateScheduled,
  type ScheduledRecording,
} from "../src/scheduled.js";

function makeRecording(overrides: Partial<ScheduledRecording> = {}): ScheduledRecording {
  return {
    id: "abc12345",
    channel: "NASA TV",
    program: {
      title: "Artemis II Launch",
      description: "Crewed lunar flyby.",
      start: "2026-06-07T12:00:00.000Z",
      end: "2026-06-07T13:00:00.000Z",
      startLocal: "2026-06-07 12:00:00",
      endLocal: "2026-06-07 13:00:00",
    },
    createdAt: "2026-06-01T09:00:00.000Z",
    status: "pending",
    ...overrides,
  };
}

function makeProgram(overrides: Partial<EpgProgram> = {}): EpgProgram {
  return {
    title: "Artemis II Launch",
    description: "Crewed lunar flyby.",
    start: new Date("2026-06-07T12:00:00.000Z"),
    end: new Date("2026-06-07T13:00:00.000Z"),
    startLocal: "2026-06-07 12:00:00",
    endLocal: "2026-06-07 13:00:00",
    hasArchive: false,
    ...overrides,
  };
}

/** A program shifted by some minutes from the scheduled slot. */
function shifted(minutes: number, overrides: Partial<EpgProgram> = {}): EpgProgram {
  const start = new Date(Date.parse("2026-06-07T12:00:00.000Z") + minutes * 60_000);
  const end = new Date(Date.parse("2026-06-07T13:00:00.000Z") + minutes * 60_000);
  return makeProgram({ start, end, ...overrides });
}

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-schedule-"));
  return path.join(dir, "scheduled.json");
}

describe("loadSchedule", () => {
  it("gives nothing when the file doesn't exist", async () => {
    assert.deepEqual(loadSchedule(await tempFile()), []);
  });

  it("round trips through save", async () => {
    const file = await tempFile();
    const recording = makeRecording({ paddingAfter: 30, comskip: true });
    saveSchedule([recording], file);
    assert.deepEqual(loadSchedule(file), [recording]);
  });

  it("gives nothing when the file has no recordings key", async () => {
    const file = await tempFile();
    await writeFile(file, "{}");
    assert.deepEqual(loadSchedule(file), []);
  });

  it("throws on invalid JSON", async () => {
    const file = await tempFile();
    await writeFile(file, "{ nope");
    assert.throws(() => loadSchedule(file), /scheduled\.json isn't valid JSON/);
  });

  it("throws on an unknown status", async () => {
    const file = await tempFile();
    await writeFile(file, JSON.stringify({ recordings: [makeRecording({ status: "maybe" as never })] }));
    assert.throws(() => loadSchedule(file), /"status" that must be pending, done or expired/);
  });

  it("throws when a program time isn't a date", async () => {
    const file = await tempFile();
    const bad = makeRecording();
    bad.program.start = "whenever";
    await writeFile(file, JSON.stringify({ recordings: [bad] }));
    assert.throws(() => loadSchedule(file), /isn't a date/);
  });

  it("throws when recordings isn't an array", async () => {
    const file = await tempFile();
    await writeFile(file, JSON.stringify({ recordings: "one" }));
    assert.throws(() => loadSchedule(file), /"recordings" that must be an array/);
  });
});

describe("saveSchedule", () => {
  it("leaves no temp file behind", async () => {
    const file = await tempFile();
    saveSchedule([makeRecording()], file);
    assert.equal(existsSync(file), true);
    assert.equal(existsSync(`${file}.tmp`), false);
  });

  it("replaces what was there before", async () => {
    const file = await tempFile();
    saveSchedule([makeRecording({ id: "one" }), makeRecording({ id: "two" })], file);
    saveSchedule([makeRecording({ id: "three" })], file);
    assert.deepEqual(loadSchedule(file).map((r) => r.id), ["three"]);
  });
});

describe("add, update and remove", () => {
  it("appends without touching what's already there", async () => {
    const file = await tempFile();
    addScheduled(makeRecording({ id: "one" }), file);
    addScheduled(makeRecording({ id: "two" }), file);
    assert.deepEqual(loadSchedule(file).map((r) => r.id), ["one", "two"]);
  });

  it("patches just the one recording", async () => {
    const file = await tempFile();
    addScheduled(makeRecording({ id: "one" }), file);
    addScheduled(makeRecording({ id: "two" }), file);

    updateScheduled("two", { status: "done", outputPath: "/catchup/launch.ts" }, file);

    const [first, second] = loadSchedule(file);
    assert.equal(first!.status, "pending");
    assert.equal(second!.status, "done");
    assert.equal(second!.outputPath, "/catchup/launch.ts");
  });

  it("removes by id", async () => {
    const file = await tempFile();
    addScheduled(makeRecording({ id: "one" }), file);
    addScheduled(makeRecording({ id: "two" }), file);
    removeScheduled("one", file);
    assert.deepEqual(loadSchedule(file).map((r) => r.id), ["two"]);
  });
});

describe("newRecording", () => {
  it("fills in an id, a created date and a pending status", () => {
    const recording = newRecording({
      channel: "NASA TV",
      program: snapshotOf(makeProgram()),
    });
    assert.match(recording.id, /^[0-9a-f]{8}$/);
    assert.equal(recording.status, "pending");
    assert.equal(Number.isNaN(Date.parse(recording.createdAt)), false);
  });

  it("gives each recording a different id", () => {
    const fields = { channel: "NASA TV", program: snapshotOf(makeProgram()) };
    assert.notEqual(newRecording(fields).id, newRecording(fields).id);
  });
});

describe("snapshotOf and toProgram", () => {
  it("round trips a program", () => {
    const program = makeProgram();
    const back = toProgram(makeRecording({ program: snapshotOf(program) }));
    assert.equal(back.title, program.title);
    assert.equal(back.description, program.description);
    assert.equal(back.start.getTime(), program.start.getTime());
    assert.equal(back.end.getTime(), program.end.getTime());
    assert.equal(back.startLocal, program.startLocal);
    assert.equal(back.endLocal, program.endLocal);
  });

  it("says the archive is there, because it's only used once the show has aired", () => {
    assert.equal(toProgram(makeRecording()).hasArchive, true);
  });
});

describe("findProgram", () => {
  const recording = makeRecording();

  it("finds the show at the time it was scheduled for", () => {
    const found = findProgram(recording, [shifted(0)]);
    assert.equal(found?.start.toISOString(), "2026-06-07T12:00:00.000Z");
  });

  it("ignores case and stray spaces in the title", () => {
    const found = findProgram(recording, [shifted(0, { title: "  artemis II LAUNCH " })]);
    assert.ok(found);
  });

  it("still finds a show the guide has moved by 90 minutes", () => {
    const found = findProgram(recording, [shifted(90)]);
    assert.equal(found?.start.toISOString(), "2026-06-07T13:30:00.000Z");
  });

  it("finds one moved earlier as well as later", () => {
    const found = findProgram(recording, [shifted(-90)]);
    assert.equal(found?.start.toISOString(), "2026-06-07T10:30:00.000Z");
  });

  it("ignores a repeat five hours later", () => {
    assert.equal(findProgram(recording, [shifted(300)]), undefined);
  });

  it("takes the showing closest to the slot that was picked", () => {
    const found = findProgram(recording, [shifted(150), shifted(20), shifted(-100)]);
    assert.equal(found?.start.toISOString(), "2026-06-07T12:20:00.000Z");
  });

  it("ignores a different show in the same slot", () => {
    assert.equal(findProgram(recording, [shifted(0, { title: "Mission Briefing" })]), undefined);
  });

  it("gives nothing for an empty guide", () => {
    assert.equal(findProgram(recording, []), undefined);
  });
});

describe("hasMoved", () => {
  it("is false when the guide still agrees", () => {
    assert.equal(hasMoved(makeRecording(), shifted(0)), false);
  });

  it("is true when the start changed", () => {
    assert.equal(hasMoved(makeRecording(), shifted(45)), true);
  });

  it("is true when only the end changed, so an overrun is spotted", () => {
    const longer = makeProgram({ end: new Date("2026-06-07T14:00:00.000Z") });
    assert.equal(hasMoved(makeRecording(), longer), true);
  });
});

describe("pruneSchedule", () => {
  const now = Date.parse("2026-08-01T00:00:00.000Z");

  it("keeps pending recordings however old they are", () => {
    const old = makeRecording({ createdAt: "2024-01-01T00:00:00.000Z" });
    assert.deepEqual(pruneSchedule([old], now), [old]);
  });

  it("drops a recording finished more than 30 days ago", () => {
    const done = makeRecording({ status: "done", completedAt: "2026-06-07T14:00:00.000Z" });
    assert.deepEqual(pruneSchedule([done], now), []);
  });

  it("keeps a recording finished last week", () => {
    const done = makeRecording({ status: "done", completedAt: "2026-07-25T14:00:00.000Z" });
    assert.deepEqual(pruneSchedule([done], now), [done]);
  });

  it("drops an old expired recording too", () => {
    const expired = makeRecording({ status: "expired", completedAt: "2026-06-07T14:00:00.000Z" });
    assert.deepEqual(pruneSchedule([expired], now), []);
  });
});
