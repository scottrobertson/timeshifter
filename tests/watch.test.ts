import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDue } from "../src/watch.js";
import type { EpgProgram } from "../src/source.js";

function makeProgram(overrides: Partial<EpgProgram> = {}): EpgProgram {
  const start = new Date(Date.UTC(2026, 5, 7, 12, 0, 0));
  const end = new Date(Date.UTC(2026, 5, 7, 13, 0, 0));
  return {
    title: "Artemis II : Moon Launch ᴸᶦᵛᵉ",
    description: "",
    start,
    end,
    startLocal: "2026-06-07 12:00:00",
    endLocal: "2026-06-07 13:00:00",
    hasArchive: true,
    ...overrides,
  };
}

describe("isDue", () => {
  const cutoff = Date.UTC(2026, 5, 7, 11, 0, 0); // an hour before the program ends
  const end = Date.UTC(2026, 5, 7, 13, 0, 0);

  it("is not due before end + after-padding has passed", () => {
    const now = end + 29 * 60_000; // 29 min after end, padding is 30
    assert.equal(isDue(makeProgram(), 30, 0, cutoff, now), false);
  });

  it("is due once end + after-padding has passed", () => {
    const now = end + 30 * 60_000;
    assert.equal(isDue(makeProgram(), 30, 0, cutoff, now), true);
  });

  it("respects the ready grace on top of the padding", () => {
    const now = end + 31 * 60_000; // 30 padding + 1 grace = 31
    assert.equal(isDue(makeProgram(), 30, 5, cutoff, now), false);
    assert.equal(isDue(makeProgram(), 30, 1, cutoff, now), true);
  });

  it("skips programs that ended at or before the cutoff", () => {
    const now = end + 60 * 60_000; // well past, so only the cutoff gates it
    assert.equal(isDue(makeProgram(), 0, 0, end, now), false); // ends exactly at cutoff
    assert.equal(isDue(makeProgram(), 0, 0, end - 1, now), true); // ends after cutoff
  });

  it("takes the whole archive when there's no cutoff", () => {
    const now = end + 60 * 60_000;
    assert.equal(isDue(makeProgram(), 0, 0, Number.NEGATIVE_INFINITY, now), true);
  });

  it("skips programs that aren't in the archive", () => {
    const now = end + 60 * 60_000;
    assert.equal(isDue(makeProgram({ hasArchive: false }), 0, 0, cutoff, now), false);
  });
});
