import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { XtreamSource, dedupeOverlapping } from "../src/xtream.js";
import type { Config } from "../src/config.js";
import type { EpgProgram } from "../src/source.js";

const config: Config = {
  baseUrl: "http://example.com:8080",
  username: "user",
  password: "pass",
  downloadDir: "downloads",
  userAgent: undefined,
  timeshiftMode: "path",
  paddingBefore: 0,
  paddingAfter: 0,
  filenameTemplate: "{title}.{ext}",
  setAiredTime: true,
  subscriptionsFile: "subscriptions.json",
};

const realFetch = globalThis.fetch;
function stubFetch(response: unknown): void {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => response,
  })) as unknown as typeof globalThis.fetch;
}
/** Stub that returns different JSON depending on the `action` in the URL. */
function stubFetchByAction(byAction: Record<string, unknown>): void {
  globalThis.fetch = (async (url: string | URL) => {
    const action = new URL(String(url)).searchParams.get("action") ?? "";
    return { ok: true, json: async () => byAction[action] ?? [] };
  }) as unknown as typeof globalThis.fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

const base64 = (s: string) => Buffer.from(s).toString("base64");

describe("XtreamSource.connect", () => {
  it("throws when authentication is rejected", async () => {
    stubFetch({ user_info: { auth: 0 } });
    await assert.rejects(() => new XtreamSource(config).connect());
  });

  it("returns a status line on success", async () => {
    stubFetch({ user_info: { auth: 1, status: "Active" } });
    assert.match(await new XtreamSource(config).connect(), /Active/);
  });
});

describe("XtreamSource.archiveChannels", () => {
  it("groups archive channels by category in provider order", async () => {
    stubFetchByAction({
      get_live_categories: [
        { category_id: "10", category_name: "Sports" },
        { category_id: "20", category_name: "Entertainment" },
      ],
      // Provider order interleaves categories; grouping should cluster them
      // while keeping each category's channels in their stream order.
      get_live_streams: [
        { stream_id: 1, name: "Sports One", tv_archive: 1, tv_archive_duration: 7, category_id: "10" },
        { stream_id: 2, name: "Ent One", tv_archive: 1, tv_archive_duration: 5, category_id: "20" },
        { stream_id: 3, name: "No archive", tv_archive: 0, tv_archive_duration: 0, category_id: "10" },
        { stream_id: 4, name: "Sports Two", tv_archive: 1, tv_archive_duration: 7, category_id: "10" },
      ],
    });
    const channels = await new XtreamSource(config).archiveChannels();
    assert.deepEqual(channels, [
      { name: "Sports One", archiveDays: 7, streamId: 1, group: "Sports" },
      { name: "Sports Two", archiveDays: 7, streamId: 4, group: "Sports" },
      { name: "Ent One", archiveDays: 5, streamId: 2, group: "Entertainment" },
    ]);
  });
});

describe("XtreamSource.programs", () => {
  it("decodes titles, drops invalid entries and sorts newest first", async () => {
    stubFetch({
      epg_listings: [
        { title: base64("Older"), start: "2024-01-01 10:00:00", start_timestamp: 1704103200, stop_timestamp: 1704106800, has_archive: 1 },
        { title: base64("Newer"), start: "2024-01-02 10:00:00", start_timestamp: 1704189600, stop_timestamp: 1704193200, has_archive: 1 },
        { title: base64("Invalid"), start: "", start_timestamp: 0, stop_timestamp: 0 },
      ],
    });
    const programs = await new XtreamSource(config).programs({ name: "A", archiveDays: 7, streamId: 1 });
    assert.deepEqual(programs.map((p) => p.title), ["Newer", "Older"]);
    assert.equal(programs[0]!.hasArchive, true);
  });

  it("collapses a duplicate the provider returns twice, shifted by minutes", async () => {
    stubFetch({
      epg_listings: [
        // Same launch returned twice, 10 minutes apart.
        { title: base64("Moon Launch"), start: "2024-01-01 08:20:00", end: "2024-01-01 09:40:00", start_timestamp: 1704097200, stop_timestamp: 1704102000, has_archive: 1 },
        { title: base64("Moon Launch"), start: "2024-01-01 08:30:00", end: "2024-01-01 09:50:00", start_timestamp: 1704097800, stop_timestamp: 1704102600, has_archive: 1 },
      ],
    });
    const programs = await new XtreamSource(config).programs({ name: "A", archiveDays: 7, streamId: 1 });
    assert.equal(programs.length, 1);
    assert.equal(programs[0]!.startLocal, "2024-01-01 08:20:00"); // earliest start
    assert.equal(programs[0]!.endLocal, "2024-01-01 09:50:00"); // latest end
  });
});

describe("dedupeOverlapping", () => {
  function p(title: string, startMs: number, endMs: number): EpgProgram {
    return {
      title,
      description: "",
      start: new Date(startMs),
      end: new Date(endMs),
      startLocal: "",
      endLocal: "",
      hasArchive: true,
    };
  }
  const H = 3_600_000;

  it("merges a same-title overlapping entry into the earliest start and latest end", () => {
    const out = dedupeOverlapping([p("Launch", 10 * H, 11 * H), p("Launch", 10 * H + 600_000, 11 * H + 600_000)]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.start.getTime(), 10 * H); // earliest start
    assert.equal(out[0]!.end.getTime(), 11 * H + 600_000); // latest end
  });

  it("merges three or more overlapping copies into one span", () => {
    const out = dedupeOverlapping([
      p("Launch", 10 * H, 11 * H),
      p("Launch", 10 * H + 600_000, 11 * H + 600_000),
      p("Launch", 10 * H + 1_200_000, 11 * H + 1_200_000),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.start.getTime(), 10 * H); // earliest of the three
    assert.equal(out[0]!.end.getTime(), 11 * H + 1_200_000); // latest of the three
  });

  it("does not shrink the end when the later duplicate finishes sooner", () => {
    // Earliest start already kept; a shorter overlapping dup must not clip it.
    const out = dedupeOverlapping([p("Launch", 10 * H, 12 * H), p("Launch", 10 * H + 600_000, 11 * H)]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.end.getTime(), 12 * H);
  });

  it("keeps a same-title repeat that doesn't overlap", () => {
    const out = dedupeOverlapping([p("Launch", 10 * H, 11 * H), p("Launch", 18 * H, 19 * H)]);
    assert.equal(out.length, 2);
  });

  it("keeps different titles that overlap", () => {
    const out = dedupeOverlapping([p("Launch", 10 * H, 11 * H), p("Docking", 10 * H, 11 * H)]);
    assert.equal(out.length, 2);
  });

  it("keeps back-to-back same-title shows separate", () => {
    // Sequential episodes that only touch at the boundary don't overlap, so
    // they're kept as distinct shows rather than merged into one.
    const out = dedupeOverlapping([
      p("Launch", 10 * H, 11 * H),
      p("Launch", 11 * H, 12 * H),
      p("Launch", 12 * H, 13 * H),
    ]);
    assert.equal(out.length, 3);
  });

  it("does not collapse two same-title shows with a different one in between", () => {
    // The two "Launch" entries don't overlap each other, so even though a
    // differently-named show sits between them in time, they stay separate.
    const out = dedupeOverlapping([
      p("Launch", 10 * H, 11 * H),
      p("Docking", 11 * H, 12 * H),
      p("Launch", 13 * H, 14 * H),
    ]);
    assert.equal(out.length, 3);
    const launches = out.filter((x) => x.title === "Launch").map((x) => x.start.getTime());
    assert.deepEqual(launches.sort(), [10 * H, 13 * H]);
  });
});
