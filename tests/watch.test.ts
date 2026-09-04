import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isDue,
  pollOnce,
  type PollResult,
  type ScheduledPollResult,
  type SubscriptionPollResult,
} from "../src/watch.js";
import type { Config } from "../src/config.js";
import type { Channel, EpgProgram, Source } from "../src/source.js";
import type { Subscription, WatchConfig } from "../src/subscriptions.js";
import {
  loadSchedule,
  saveSchedule,
  snapshotOf,
  type ScheduledRecording,
} from "../src/scheduled.js";
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

  // Each poll gets its own schedule file inside the test's temp dir, so a real
  // scheduled.json in the working directory can't leak into the tests.
  function scheduleIn(dir: string): string {
    return path.join(dir, "scheduled.json");
  }

  function noScheduled(overrides: Partial<ScheduledPollResult> = {}): ScheduledPollResult {
    return {
      pending: 0,
      waiting: 0,
      moved: 0,
      listed: 0,
      downloaded: 0,
      failed: 0,
      alreadyHad: 0,
      expired: 0,
      ...overrides,
    };
  }

  function summary(
    overrides: Partial<SubscriptionPollResult> = {},
    scheduled: Partial<ScheduledPollResult> = {},
  ): PollResult {
    return {
      subscriptions: [
        {
          subscription: "Moon launches",
          ready: 0,
          listed: 0,
          downloaded: 0,
          failed: 0,
          alreadyHad: 0,
          ...overrides,
        },
      ],
      scheduled: noScheduled(scheduled),
    };
  }

  it("downloads a due program into the download dir", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
    serveBytes("launch footage");
    restoreFfmpeg = await installFakeFfmpeg("copy");

    const results = await pollOnce(makeConfig(dir), fakeSource([makeProgram()]), makeWatch(), false, now, scheduleIn(dir));

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
      scheduleIn(dir),
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
      scheduleIn(dir),
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
      scheduleIn(dir),
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
      scheduleIn(dir),
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
      scheduleIn(dir),
    );

    assert.deepEqual(results, summary({ ready: 1, listed: 1, downloaded: 1 }));
    assert.equal(existsSync(path.join(dir, "Artemis II - Moon Launch ᴸᶦᵛᵉ.edl")), true);
  });

  it("lists without downloading on a dry run", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));

    const results = await pollOnce(makeConfig(dir), fakeSource([makeProgram()]), makeWatch(), true, now, scheduleIn(dir));

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
      scheduleIn(dir),
    );

    assert.deepEqual(results, summary({ ready: 1, alreadyHad: 1 }));
    const nfo = await readFile(path.join(dir, "Artemis II - Moon Launch ᴸᶦᵛᵉ.nfo"));
    assert.match(nfo.toString(), /<title>Artemis II : Moon Launch ᴸᶦᵛᵉ<\/title>/);
  });

  it("counts a failed download without throwing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
    globalThis.fetch = (async () =>
      new Response("nope", { status: 404, statusText: "Not Found" })) as unknown as typeof globalThis.fetch;

    const results = await pollOnce(makeConfig(dir), fakeSource([makeProgram()]), makeWatch(), false, now, scheduleIn(dir));

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
      scheduleIn(dir),
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
      scheduleIn(dir),
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
      scheduleIn(dir),
    );

    assert.deepEqual(results, summary());
  });

  describe("scheduled recordings", () => {
    // No subscriptions, so each test is only about the one-off recording.
    const watch: WatchConfig = { pollIntervalMinutes: 15, readyGraceMinutes: 0, subscriptions: [] };

    // The same short template the subscription tests use, so the file is easy to name.
    function config(dir: string, overrides: Partial<Config> = {}): Config {
      return makeConfig(dir, { filenameTemplate: "{title}.{ext}", ...overrides });
    }

    function schedule(dir: string, overrides: Partial<ScheduledRecording> = {}): string {
      const file = scheduleIn(dir);
      saveSchedule(
        [
          {
            id: "sched1",
            channel: "NASA TV",
            program: snapshotOf(makeProgram()),
            createdAt: "2026-06-01T09:00:00.000Z",
            status: "pending",
            ...overrides,
          },
        ],
        file,
      );
      return file;
    }

    /** The same show, moved by the guide. */
    function moved(minutes: number): EpgProgram {
      const shift = (iso: string) => new Date(Date.parse(iso) + minutes * 60_000);
      const local = (hhmm: string) => `2026-06-07 ${hhmm}:00`;
      return makeProgram({
        start: shift("2026-06-07T12:00:00.000Z"),
        end: shift("2026-06-07T13:00:00.000Z"),
        startLocal: local(minutes === 90 ? "13:30" : "12:00"),
        endLocal: local(minutes === 90 ? "14:30" : "13:00"),
      });
    }

    function only(file: string): ScheduledRecording {
      const recordings = loadSchedule(file);
      assert.equal(recordings.length, 1);
      return recordings[0]!;
    }

    it("waits while the show still has to finish airing", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
      const file = schedule(dir);

      // Half an hour before the show ends, so there's no catchup to fetch yet.
      const results = await pollOnce(
        config(dir),
        fakeSource([makeProgram()]),
        watch,
        false,
        end - 30 * 60_000,
        file,
      );

      assert.deepEqual(results.scheduled, noScheduled({ pending: 1, waiting: 1 }));
      assert.equal(existsSync(path.join(dir, recordingName)), false);
      assert.equal(only(file).status, "pending");
    });

    it("downloads it once the show has finished, then marks it done", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
      const file = schedule(dir);
      serveBytes("launch footage");
      restoreFfmpeg = await installFakeFfmpeg("copy");

      const results = await pollOnce(config(dir), fakeSource([makeProgram()]), watch, false, now, file);

      assert.deepEqual(
        results.scheduled,
        noScheduled({ pending: 1, listed: 1, downloaded: 1 }),
      );
      const written = await readFile(path.join(dir, recordingName));
      assert.equal(written.toString(), "launch footage");

      const recording = only(file);
      assert.equal(recording.status, "done");
      assert.equal(recording.outputPath, path.join(dir, recordingName));
      assert.ok(recording.completedAt);
    });

    it("records the new time when the guide moves the show", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
      const file = schedule(dir);
      serveBytes("launch footage");
      restoreFfmpeg = await installFakeFfmpeg("copy");

      // The show slipped 90 min, so it now ends at 14:30 and is due after that.
      const results = await pollOnce(
        config(dir),
        fakeSource([moved(90)]),
        watch,
        false,
        end + 3 * 60 * 60_000,
        file,
      );

      assert.deepEqual(
        results.scheduled,
        noScheduled({ pending: 1, moved: 1, listed: 1, downloaded: 1 }),
      );
      const recording = only(file);
      assert.equal(recording.program.start, "2026-06-07T13:30:00.000Z");
      assert.equal(recording.program.startLocal, "2026-06-07 13:30:00");
      assert.equal(recording.status, "done");
    });

    it("records the time you picked when the guide entry has gone", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
      const file = schedule(dir);
      serveBytes("launch footage");
      restoreFfmpeg = await installFakeFfmpeg("copy");

      const results = await pollOnce(config(dir), fakeSource([]), watch, false, now, file);

      assert.deepEqual(
        results.scheduled,
        noScheduled({ pending: 1, listed: 1, downloaded: 1 }),
      );
      assert.equal(existsSync(path.join(dir, recordingName)), true);
      assert.equal(only(file).status, "done");
    });

    it("keeps waiting when the guide entry has gone but the show hasn't aired", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
      const file = schedule(dir);

      const results = await pollOnce(
        config(dir),
        fakeSource([]),
        watch,
        false,
        end - 30 * 60_000,
        file,
      );

      assert.deepEqual(results.scheduled, noScheduled({ pending: 1, waiting: 1 }));
      assert.equal(only(file).status, "pending");
    });

    it("gives up two days after a show that never showed up in the guide", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
      const file = schedule(dir);

      const results = await pollOnce(
        config(dir),
        fakeSource([]),
        watch,
        false,
        end + 49 * 60 * 60_000,
        file,
      );

      assert.deepEqual(results.scheduled, noScheduled({ pending: 1, expired: 1 }));
      assert.equal(existsSync(path.join(dir, recordingName)), false);
      assert.equal(only(file).status, "expired");
    });

    it("marks it done when the recording is already there", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
      const file = schedule(dir);
      await writeFile(path.join(dir, recordingName), "an earlier download");

      const results = await pollOnce(config(dir), fakeSource([makeProgram()]), watch, false, now, file);

      assert.deepEqual(results.scheduled, noScheduled({ pending: 1, alreadyHad: 1 }));
      const recording = only(file);
      assert.equal(recording.status, "done");
      assert.equal(recording.outputPath, path.join(dir, recordingName));
    });

    it("leaves it pending when the download fails, so the next poll tries again", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
      const file = schedule(dir);
      globalThis.fetch = (async () =>
        new Response("nope", { status: 404, statusText: "Not Found" })) as unknown as typeof globalThis.fetch;

      const results = await pollOnce(config(dir), fakeSource([makeProgram()]), watch, false, now, file);

      assert.deepEqual(results.scheduled, noScheduled({ pending: 1, listed: 1, failed: 1 }));
      assert.equal(only(file).status, "pending");
    });

    it("changes nothing on a dry run", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
      const file = schedule(dir);

      const results = await pollOnce(config(dir), fakeSource([makeProgram()]), watch, true, now, file);

      assert.deepEqual(results.scheduled, noScheduled({ pending: 1, listed: 1 }));
      assert.equal(existsSync(path.join(dir, recordingName)), false);
      assert.equal(only(file).status, "pending");
    });

    it("uses the recording's own padding over the global", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
      // now is end + 60 min, so 120 min of after-padding means it isn't ready.
      const file = schedule(dir, { paddingAfter: 120 });

      const results = await pollOnce(config(dir), fakeSource([makeProgram()]), watch, false, now, file);

      assert.deepEqual(results.scheduled, noScheduled({ pending: 1, waiting: 1 }));
    });

    it("leaves a recording that's already been done alone", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
      const file = schedule(dir, { status: "done", completedAt: new Date(now).toISOString() });

      const results = await pollOnce(config(dir), fakeSource([makeProgram()]), watch, false, now, file);

      assert.deepEqual(results.scheduled, noScheduled());
      assert.equal(existsSync(path.join(dir, recordingName)), false);
    });

    it("says so when no channel has that name any more", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
      const file = schedule(dir, { channel: "ESA TV" });

      const results = await pollOnce(config(dir), fakeSource([makeProgram()]), watch, false, now, file);

      assert.deepEqual(results.scheduled, noScheduled({ pending: 1 }));
      assert.equal(only(file).status, "pending");
    });

    it("runs alongside subscriptions in the same poll", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-watch-"));
      const file = schedule(dir);
      serveBytes("launch footage");
      restoreFfmpeg = await installFakeFfmpeg("copy");

      const results = await pollOnce(
        config(dir),
        fakeSource([makeProgram()]),
        makeWatch(),
        false,
        now,
        file,
      );

      // Both want the same file, so whichever runs first downloads it and the
      // scheduled pass finds it already there.
      assert.deepEqual(results.subscriptions, summary({ ready: 1, listed: 1, downloaded: 1 }).subscriptions);
      assert.deepEqual(results.scheduled, noScheduled({ pending: 1, alreadyHad: 1 }));
      assert.equal(only(file).status, "done");
    });
  });
});
