import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatProgramTimeRange } from "../src/cli.js";
import type { EpgProgram } from "../src/source.js";

function makeProgram(overrides: Partial<EpgProgram> = {}): EpgProgram {
  return {
    title: "Some Show",
    description: "",
    start: new Date(Date.UTC(2024, 2, 10, 12, 0, 0)),
    end: new Date(Date.UTC(2024, 2, 10, 13, 0, 0)),
    startLocal: "2024-03-10 12:00:00",
    endLocal: "2024-03-10 13:00:00",
    hasArchive: true,
    ...overrides,
  };
}

describe("formatProgramTimeRange", () => {
  it("shows just the end time when the show ends on the same day", () => {
    assert.equal(formatProgramTimeRange(makeProgram()), "2024-03-10 12:00-13:00");
  });

  it("shows the end date too when the show crosses midnight", () => {
    const program = makeProgram({
      startLocal: "2024-03-10 23:30:00",
      endLocal: "2024-03-11 00:30:00",
    });
    assert.equal(formatProgramTimeRange(program), "2024-03-10 23:30-2024-03-11 00:30");
  });
});
