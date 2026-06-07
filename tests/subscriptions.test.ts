import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  channelMatches,
  loadWatchConfig,
  matchesProgram,
  titleMatches,
  type Subscription,
} from "../src/subscriptions.js";
import type { Channel } from "../src/source.js";

function makeSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    name: "NASA launches",
    channel: "NASA TV",
    titleContains: ["Launch", "ᴸᶦᵛᵉ"],
    ...overrides,
  };
}

const channel: Channel = {
  name: "NASA TV",
  archiveDays: 7,
  streamId: 42,
  group: "US: SCIENCE",
};

describe("channelMatches", () => {
  it("matches the exact name, case-insensitively", () => {
    assert.equal(channelMatches(makeSub({ channel: "NASA TV" }), channel), true);
    assert.equal(channelMatches(makeSub({ channel: "nasa tv" }), channel), true);
  });

  it("does not match a substring of the name", () => {
    assert.equal(channelMatches(makeSub({ channel: "NASA" }), channel), false);
  });

  it("does not match an unrelated channel", () => {
    assert.equal(channelMatches(makeSub({ channel: "Discovery" }), channel), false);
  });
});

describe("titleMatches", () => {
  it("needs every titleContains term, including the superscript Live", () => {
    assert.equal(titleMatches(makeSub(), "Artemis II : Moon Launch ᴸᶦᵛᵉ"), true);
  });

  it("rejects a title missing one of the terms", () => {
    // No "ᴸᶦᵛᵉ", so the replay shouldn't match.
    assert.equal(titleMatches(makeSub(), "Artemis II : Moon Launch"), false);
  });

  it("honours titleExcludes", () => {
    const sub = makeSub({ titleContains: ["Launch"], titleExcludes: ["Replay"] });
    assert.equal(titleMatches(sub, "Moon Launch ᴸᶦᵛᵉ"), true);
    assert.equal(titleMatches(sub, "Moon Launch Replay"), false);
  });
});

describe("matchesProgram", () => {
  it("requires both the channel and the title to match", () => {
    const title = "Artemis II : Moon Launch ᴸᶦᵛᵉ";
    assert.equal(matchesProgram(makeSub(), channel, title), true);
    assert.equal(matchesProgram(makeSub({ channel: "Discovery" }), channel, title), false);
  });
});

describe("loadWatchConfig", () => {
  async function writeTemp(watch: unknown): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-config-"));
    const file = path.join(dir, "config.json");
    const contents = typeof watch === "string" ? watch : JSON.stringify({ watch });
    await writeFile(file, contents);
    return file;
  }

  it("parses a valid watch block and applies defaults", async () => {
    const file = await writeTemp({
      subscriptions: [{ name: "Launches", channel: "NASA TV", titleContains: ["Launch"] }],
    });
    const config = loadWatchConfig(file);
    assert.equal(config.pollIntervalMinutes, 10);
    assert.equal(config.readyGraceMinutes, 0);
    assert.equal(config.subscriptions.length, 1);
    assert.equal(config.subscriptions[0]!.name, "Launches");
  });

  it("keeps an explicit poll interval and from date", async () => {
    const file = await writeTemp({
      pollIntervalMinutes: 5,
      subscriptions: [
        { name: "Launches", channel: "NASA TV", titleContains: ["Launch"], from: "2026-06-01" },
      ],
    });
    const config = loadWatchConfig(file);
    assert.equal(config.pollIntervalMinutes, 5);
    assert.equal(config.subscriptions[0]!.from, "2026-06-01");
  });

  it("throws when the file is missing", () => {
    assert.throws(() => loadWatchConfig("/no/such/config.json"), /Couldn't read/);
  });

  it("throws on invalid JSON", async () => {
    const file = await writeTemp("{ not json");
    assert.throws(() => loadWatchConfig(file), /isn't valid JSON/);
  });

  it("throws when the watch block is missing", async () => {
    const file = await writeTemp(JSON.stringify({ url: "http://example.com" }));
    assert.throws(() => loadWatchConfig(file), /needs a "watch" object/);
  });

  it("throws when subscriptions is empty", async () => {
    const file = await writeTemp({ subscriptions: [] });
    assert.throws(() => loadWatchConfig(file), /non-empty "watch.subscriptions"/);
  });

  it("throws when titleContains is empty", async () => {
    const file = await writeTemp({
      subscriptions: [{ name: "Launches", channel: "NASA TV", titleContains: [] }],
    });
    assert.throws(() => loadWatchConfig(file), /empty "titleContains"/);
  });

  it("throws on an invalid from date", async () => {
    const file = await writeTemp({
      subscriptions: [{ name: "Launches", channel: "NASA TV", titleContains: ["x"], from: "not-a-date" }],
    });
    assert.throws(() => loadWatchConfig(file), /"from" that must be a date/);
  });
});
