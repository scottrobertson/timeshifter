import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { downloadableNow, formatProgramTimeRange, upcomingSoonestFirst } from "../src/cli.js";
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

describe("downloadableNow", () => {
  const now = Date.UTC(2024, 2, 10, 12, 0, 0);

  /** A show starting some hours from now, named after how far ahead it is. */
  function at(hours: number, overrides: Partial<EpgProgram> = {}): EpgProgram {
    const start = new Date(now + hours * 60 * 60_000);
    return makeProgram({
      title: `In ${hours}h`,
      start,
      end: new Date(start.getTime() + 60 * 60_000),
      ...overrides,
    });
  }

  it("keeps shows that have aired and are in the archive", () => {
    const titles = downloadableNow([at(-3), at(-24)], now).map((p) => p.title);
    assert.deepEqual(titles, ["In -3h", "In -24h"]);
  });

  it("drops shows the provider has no archive for", () => {
    assert.deepEqual(downloadableNow([at(-3, { hasArchive: false })], now), []);
  });

  it("drops shows that haven't started, because there's nothing to fetch yet", () => {
    assert.deepEqual(downloadableNow([at(2), at(48)], now), []);
  });

  it("keeps a show that started but is still on, so you get the part that aired", () => {
    const titles = downloadableNow([at(-0.5)], now).map((p) => p.title);
    assert.deepEqual(titles, ["In -0.5h"]);
  });

  it("keeps the order the guide gave", () => {
    const titles = downloadableNow([at(-1), at(-9), at(-4)], now).map((p) => p.title);
    assert.deepEqual(titles, ["In -1h", "In -9h", "In -4h"]);
  });
});

describe("upcomingSoonestFirst", () => {
  const now = Date.UTC(2024, 2, 10, 12, 0, 0);

  /** A show starting some hours from now, named after how far ahead it is. */
  function at(hours: number): EpgProgram {
    const start = new Date(now + hours * 60 * 60_000);
    return makeProgram({
      title: `In ${hours}h`,
      start,
      end: new Date(start.getTime() + 60 * 60_000),
    });
  }

  it("puts what's on next at the top, whatever order the guide gave", () => {
    const titles = upcomingSoonestFirst([at(48), at(2), at(26), at(5)], now).map((p) => p.title);
    assert.deepEqual(titles, ["In 2h", "In 5h", "In 26h", "In 48h"]);
  });

  it("drops anything that has already started", () => {
    const titles = upcomingSoonestFirst([at(-3), at(2), at(-24)], now).map((p) => p.title);
    assert.deepEqual(titles, ["In 2h"]);
  });

  it("drops a show starting exactly now, because it can't be scheduled", () => {
    assert.deepEqual(upcomingSoonestFirst([at(0)], now), []);
  });

  it("gives nothing when the guide has no future shows", () => {
    assert.deepEqual(upcomingSoonestFirst([at(-1)], now), []);
  });

  it("leaves the guide it was given alone", () => {
    const programs = [at(5), at(2)];
    upcomingSoonestFirst(programs, now);
    assert.deepEqual(programs.map((p) => p.title), ["In 5h", "In 2h"]);
  });
});
