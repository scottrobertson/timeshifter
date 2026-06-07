import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  channelMatches,
  loadSubscriptions,
  matchesProgram,
  titleMatches,
  type Subscription,
} from "../src/subscriptions.js";
import type { Channel } from "../src/source.js";

function makeSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    name: "F1 races",
    channel: "Sky Sports F1 FHD",
    titleContains: ["Formula 1", "ᴸᶦᵛᵉ"],
    ...overrides,
  };
}

const channel: Channel = {
  name: "Sky Sports F1 FHD",
  archiveDays: 7,
  streamId: 42,
  group: "UK: SPORTS",
};

describe("channelMatches", () => {
  it("matches the exact name, case-insensitively", () => {
    assert.equal(channelMatches(makeSub({ channel: "Sky Sports F1 FHD" }), channel), true);
    assert.equal(channelMatches(makeSub({ channel: "sky sports f1 fhd" }), channel), true);
  });

  it("does not match a substring of the name", () => {
    assert.equal(channelMatches(makeSub({ channel: "Sky Sports F1" }), channel), false);
  });

  it("does not match an unrelated channel", () => {
    assert.equal(channelMatches(makeSub({ channel: "Eurosport" }), channel), false);
  });
});

describe("titleMatches", () => {
  it("needs every titleContains term, including the superscript Live", () => {
    assert.equal(titleMatches(makeSub(), "Formula 1 : Monaco Grand Prix: Race ᴸᶦᵛᵉ"), true);
  });

  it("rejects a title missing one of the terms", () => {
    // No "ᴸᶦᵛᵉ", so the replay shouldn't match.
    assert.equal(titleMatches(makeSub(), "Formula 1 : Monaco Grand Prix: Race"), false);
  });

  it("honours titleExcludes", () => {
    const sub = makeSub({ titleContains: ["Formula 1"], titleExcludes: ["Highlights"] });
    assert.equal(titleMatches(sub, "Formula 1 : Race ᴸᶦᵛᵉ"), true);
    assert.equal(titleMatches(sub, "Formula 1 : Race Highlights"), false);
  });
});

describe("matchesProgram", () => {
  it("requires both the channel and the title to match", () => {
    const title = "Formula 1 : Monaco Grand Prix: Race ᴸᶦᵛᵉ";
    assert.equal(matchesProgram(makeSub(), channel, title), true);
    assert.equal(matchesProgram(makeSub({ channel: "Eurosport" }), channel, title), false);
  });
});

describe("loadSubscriptions", () => {
  async function writeTemp(contents: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-subs-"));
    const file = path.join(dir, "subscriptions.json");
    await writeFile(file, contents);
    return file;
  }

  it("parses a valid file and applies defaults", async () => {
    const file = await writeTemp(
      JSON.stringify({
        subscriptions: [{ name: "F1", channel: "Sky Sports F1", titleContains: ["Formula 1"] }],
      }),
    );
    const config = loadSubscriptions(file);
    assert.equal(config.pollIntervalMinutes, 10);
    assert.equal(config.readyGraceMinutes, 0);
    assert.equal(config.subscriptions.length, 1);
    assert.equal(config.subscriptions[0]!.name, "F1");
  });

  it("keeps an explicit poll interval and from date", async () => {
    const file = await writeTemp(
      JSON.stringify({
        pollIntervalMinutes: 5,
        subscriptions: [
          { name: "F1", channel: "Sky Sports F1", titleContains: ["Formula 1"], from: "2026-06-01" },
        ],
      }),
    );
    const config = loadSubscriptions(file);
    assert.equal(config.pollIntervalMinutes, 5);
    assert.equal(config.subscriptions[0]!.from, "2026-06-01");
  });

  it("throws when the file is missing", () => {
    assert.throws(() => loadSubscriptions("/no/such/subscriptions.json"), /Couldn't read/);
  });

  it("throws on invalid JSON", async () => {
    const file = await writeTemp("{ not json");
    assert.throws(() => loadSubscriptions(file), /isn't valid JSON/);
  });

  it("throws when subscriptions is empty", async () => {
    const file = await writeTemp(JSON.stringify({ subscriptions: [] }));
    assert.throws(() => loadSubscriptions(file), /non-empty "subscriptions"/);
  });

  it("throws when titleContains is empty", async () => {
    const file = await writeTemp(
      JSON.stringify({ subscriptions: [{ name: "F1", channel: "Sky", titleContains: [] }] }),
    );
    assert.throws(() => loadSubscriptions(file), /empty "titleContains"/);
  });

  it("throws on an invalid from date", async () => {
    const file = await writeTemp(
      JSON.stringify({
        subscriptions: [{ name: "F1", channel: "Sky", titleContains: ["x"], from: "not-a-date" }],
      }),
    );
    assert.throws(() => loadSubscriptions(file), /"from" that must be a date/);
  });
});
