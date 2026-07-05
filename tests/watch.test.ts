import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDue, pollOnce, type SubscriptionPollResult } from "../src/watch.js";
import type { Config } from "../src/config.js";
import type { Channel, EpgProgram, Source } from "../src/source.js";
import type { Subscription, WatchConfig } from "../src/subscriptions.js";
import { installFakeComskip, installFakeFfmpeg } from "./support.js";

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

describe("pollOnce", () => {
  const channel: Channel = { streamId: 7, name: "NASA TV", archiveDays: 7 };
  const end = Date.UTC(2026, 5, 7, 13, 0, 0); // when makeProgram() ends
  const now = end + 60 * 60_000;
  // The per-subscription template keeps filenames short and proves the override works.
  const recordingName = "Artemis II - Moon Launch ᴸᶦᵛᵉ.ts";

  const realFetch = globalThis.fetch;
  const realComskipPath = process.env.COMSKIP_PATH;
  let restoreFfmpeg: (() => void) | undefined;
  afterEach(() => {
    globalThis.fetch = realFetch;
    restoreFfmpeg?.();
    restoreFfmpeg = undefined;
    if (realComskipPath === undefined) delete process.env.COMSKIP_PATH;
    else process.env.COMSKIP_PATH = realComskipPath;
  });

  function makeConfig(downloadDir: string, overrides: Partial<Config> = {}): Config {
    return {
      baseUrl: "http://example.com:8080",
      username: "user",
      password: "pass",
      downloadDir,
      userAgent: undefined,
      timeshiftMode: "path",
      paddingBefore: 0,
      paddingAfter: 0,
      filenameTemplate: "{channel} - {title} - {datetime}.{ext}",
      filenameStrip: [],
      setAiredTime: false,
      writeNfo: false,
      comskip: false,
      ...overrides,
    };
  }

  function makeWatch(sub: Partial<Subscription> = {}): WatchConfig {
    return {
      pollIntervalMinutes: 15,
      readyGraceMinutes: 0,
      subscriptions: [
        {
          name: "Moon launches",
          channel: "NASA TV",
          titleContains: ["launch"],
          filenameTemplate: "{title}.{ext}",
          ...sub,
        },
      ],
    };
  }

  function fakeSource(programs: EpgProgram[]): Source {
    return {
      timezone: "Europe/London",
      connect: async () => "ok",
      archiveChannels: async () => [channel],
      programs: async (c: Channel) => (c.streamId === channel.streamId ? programs : []),
      catchupUrl: () => "http://example.com/catchup.ts",
    };
  }

  function serveBytes(data: string): void {
    globalThis.fetch = (async () =>
      new Response(Buffer.from(data), {
        headers: { "content-length": String(Buffer.byteLength(data)) },
      })) as unknown as typeof globalThis.fetch;
  }

  function summary(overrides: Partial<SubscriptionPollResult> = {}): SubscriptionPollResult[] {
    return [
      {
        subscription: "Moon launches",
        ready: 0,
        listed: 0,
        downloaded: 0,
        failed: 0,
        alreadyHad: 0,
        ...overrides,
      },
    ];
  }

  it("downloads a due program into the download dir", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
    serveBytes("launch footage");
    restoreFfmpeg = await installFakeFfmpeg("copy");

    const results = await pollOnce(makeConfig(dir), fakeSource([makeProgram()]), makeWatch(), false, now);

    assert.deepEqual(results, summary({ ready: 1, listed: 1, downloaded: 1 }));
    const written = await readFile(path.join(dir, recordingName));
    assert.equal(written.toString(), "launch footage");
  });

  it("stamps the aired time and writes the .nfo after a download", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
    serveBytes("launch footage");
    restoreFfmpeg = await installFakeFfmpeg("copy");

    const results = await pollOnce(
      makeConfig(dir, { setAiredTime: true, writeNfo: true }),
      fakeSource([makeProgram()]),
      makeWatch(),
      false,
      now,
    );

    assert.deepEqual(results, summary({ ready: 1, listed: 1, downloaded: 1 }));
    const stats = await stat(path.join(dir, recordingName));
    assert.equal(stats.mtime.getTime(), Date.UTC(2026, 5, 7, 13, 0, 0)); // when it aired
    const nfo = await readFile(path.join(dir, "Artemis II - Moon Launch ᴸᶦᵛᵉ.nfo"));
    assert.match(nfo.toString(), /<title>Artemis II : Moon Launch ᴸᶦᵛᵉ<\/title>/);
  });

  it("strips the title in the filename but not the .nfo", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
    serveBytes("launch footage");
    restoreFfmpeg = await installFakeFfmpeg("copy");

    const results = await pollOnce(
      makeConfig(dir, { writeNfo: true }),
      fakeSource([makeProgram()]),
      makeWatch({ filenameStrip: ["ᴸᶦᵛᵉ"] }),
      false,
      now,
    );

    assert.deepEqual(results, summary({ ready: 1, listed: 1, downloaded: 1 }));
    assert.equal(existsSync(path.join(dir, "Artemis II - Moon Launch.ts")), true);
    const nfo = await readFile(path.join(dir, "Artemis II - Moon Launch.nfo"));
    assert.match(nfo.toString(), /<title>Artemis II : Moon Launch ᴸᶦᵛᵉ<\/title>/);
  });

  it("falls back to the global filenameStrip when the subscription has none", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
    serveBytes("launch footage");
    restoreFfmpeg = await installFakeFfmpeg("copy");

    const results = await pollOnce(
      makeConfig(dir, { filenameStrip: ["ᴸᶦᵛᵉ"] }),
      fakeSource([makeProgram()]),
      makeWatch(),
      false,
      now,
    );

    assert.deepEqual(results, summary({ ready: 1, listed: 1, downloaded: 1 }));
    assert.equal(existsSync(path.join(dir, "Artemis II - Moon Launch.ts")), true);
  });

  it("skips comskip when the subscription overrides the global on with false", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
    serveBytes("launch footage");
    restoreFfmpeg = await installFakeFfmpeg("copy");
    process.env.COMSKIP_PATH = await installFakeComskip("edl");

    const results = await pollOnce(
      makeConfig(dir, { comskip: true }),
      fakeSource([makeProgram()]),
      makeWatch({ comskip: false }),
      false,
      now,
    );

    assert.deepEqual(results, summary({ ready: 1, listed: 1, downloaded: 1 }));
    assert.equal(existsSync(path.join(dir, "Artemis II - Moon Launch ᴸᶦᵛᵉ.edl")), false);
  });

  it("runs comskip when the subscription overrides the global off with true", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
    serveBytes("launch footage");
    restoreFfmpeg = await installFakeFfmpeg("copy");
    process.env.COMSKIP_PATH = await installFakeComskip("edl");

    const results = await pollOnce(
      makeConfig(dir, { comskip: false }),
      fakeSource([makeProgram()]),
      makeWatch({ comskip: true }),
      false,
      now,
    );

    assert.deepEqual(results, summary({ ready: 1, listed: 1, downloaded: 1 }));
    assert.equal(existsSync(path.join(dir, "Artemis II - Moon Launch ᴸᶦᵛᵉ.edl")), true);
  });

  it("lists without downloading on a dry run", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));

    const results = await pollOnce(makeConfig(dir), fakeSource([makeProgram()]), makeWatch(), true, now);

    assert.deepEqual(results, summary({ ready: 1, listed: 1 }));
    assert.equal(existsSync(path.join(dir, recordingName)), false);
  });

  it("skips a recording that already exists and writes its missing .nfo", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
    await writeFile(path.join(dir, recordingName), "an earlier download");

    const results = await pollOnce(
      makeConfig(dir, { writeNfo: true }),
      fakeSource([makeProgram()]),
      makeWatch(),
      false,
      now,
    );

    assert.deepEqual(results, summary({ ready: 1, alreadyHad: 1 }));
    const nfo = await readFile(path.join(dir, "Artemis II - Moon Launch ᴸᶦᵛᵉ.nfo"));
    assert.match(nfo.toString(), /<title>Artemis II : Moon Launch ᴸᶦᵛᵉ<\/title>/);
  });

  it("counts a failed download without throwing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
    globalThis.fetch = (async () =>
      new Response("nope", { status: 404, statusText: "Not Found" })) as unknown as typeof globalThis.fetch;

    const results = await pollOnce(makeConfig(dir), fakeSource([makeProgram()]), makeWatch(), false, now);

    assert.deepEqual(results, summary({ ready: 1, listed: 1, failed: 1 }));
    assert.equal(existsSync(path.join(dir, recordingName)), false);
  });

  it("does nothing when no channel matches the subscription", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));

    const results = await pollOnce(
      makeConfig(dir),
      fakeSource([makeProgram()]),
      makeWatch({ channel: "ESA TV" }),
      false,
      now,
    );

    assert.deepEqual(results, summary());
  });

  it("skips programs that ended before the subscription's from date", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));

    const results = await pollOnce(
      makeConfig(dir),
      fakeSource([makeProgram()]), // ends 2026-06-07
      makeWatch({ from: "2026-06-08" }),
      false,
      now,
    );

    assert.deepEqual(results, summary());
  });

  it("waits for the subscription's own after-padding before a program is due", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));

    // now is end + 60 min; with 120 min of after-padding the catchup isn't ready yet.
    const results = await pollOnce(
      makeConfig(dir),
      fakeSource([makeProgram()]),
      makeWatch({ paddingAfter: 120 }),
      false,
      now,
    );

    assert.deepEqual(results, summary());
  });
});
