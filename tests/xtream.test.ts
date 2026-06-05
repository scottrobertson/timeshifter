import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { XtreamSource } from "../src/xtream.js";
import type { Config } from "../src/config.js";

const config: Config = {
  baseUrl: "http://example.com:8080",
  username: "user",
  password: "pass",
  downloadDir: "downloads",
  outputFormat: "ts",
  userAgent: undefined,
  timeshiftMode: "path",
  paddingBefore: 0,
  paddingAfter: 0,
  filenameTemplate: "{title}.{ext}",
  verbose: false,
  setAiredTime: true,
};

const realFetch = globalThis.fetch;
function stubFetch(response: unknown): void {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => response,
  })) as unknown as typeof globalThis.fetch;
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
  it("keeps only channels that have an archive", async () => {
    stubFetch([
      { stream_id: 1, name: "Has archive", tv_archive: 1, tv_archive_duration: 7 },
      { stream_id: 2, name: "No archive", tv_archive: 0, tv_archive_duration: 0 },
    ]);
    const channels = await new XtreamSource(config).archiveChannels();
    assert.deepEqual(channels, [{ name: "Has archive", archiveDays: 7, streamId: 1 }]);
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
});
