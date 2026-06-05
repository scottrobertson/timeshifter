import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendDefaultCatchup,
  deriveXtreamTimeshift,
  fillCatchupTemplate,
  parsePlaylist,
  parseXtreamFromUrl,
} from "../src/m3u.js";
import { parseProgrammes } from "../src/xmltv.js";
import type { RecordingWindow } from "../src/source.js";

// 2024-03-10 12:00:00 UTC, 60 minutes.
const window: RecordingWindow = {
  start: new Date(Date.UTC(2024, 2, 10, 12, 0, 0)),
  startLocal: "2024-03-10 12:00:00",
  minutes: 60,
};
const startEpoch = Math.floor(window.start.getTime() / 1000); // 1710072000

describe("parsePlaylist", () => {
  const playlist = [
    '#EXTM3U url-tvg="http://epg.example/guide.xml"',
    '#EXTINF:-1 tvg-id="bbc1.uk" group-title="UK",BBC One',
    "http://host/user/pass/100.m3u8",
    '#EXTINF:-1 tvg-id="bbc2.uk" catchup="default" catchup-days="14",BBC Two',
    "http://host/user/pass/200.m3u8",
  ].join("\n");

  it("reads the EPG url from the header", () => {
    assert.equal(parsePlaylist(playlist).epgUrl, "http://epg.example/guide.xml");
  });

  it("keeps only channels that advertise an archive", () => {
    const { entries } = parsePlaylist(playlist);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.name, "BBC Two");
    assert.equal(entries[0]!.tvgId, "bbc2.uk");
    assert.equal(entries[0]!.archiveDays, 14);
    assert.equal(entries[0]!.streamUrl, "http://host/user/pass/200.m3u8");
  });

  it("also treats tv_archive=1 as an archive channel", () => {
    const text = [
      "#EXTM3U",
      '#EXTINF:-1 tvg-id="x" tv_archive="1" tv_archive_duration="7",Channel X',
      "http://host/user/pass/300.ts",
    ].join("\n");
    const { entries } = parsePlaylist(text);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.archiveDays, 7);
  });
});

describe("parseXtreamFromUrl", () => {
  it("extracts host, credentials and stream id", () => {
    const parts = parseXtreamFromUrl("https://host.tv:443/user/pass/1518.m3u8");
    assert.deepEqual(parts, {
      baseUrl: "https://host.tv",
      username: "user",
      password: "pass",
      streamId: 1518,
    });
  });

  it("handles a /live/ prefix", () => {
    const parts = parseXtreamFromUrl("http://host:8080/live/user/pass/42.ts");
    assert.equal(parts?.streamId, 42);
    assert.equal(parts?.username, "user");
  });

  it("returns null for a non-Xtream URL", () => {
    assert.equal(parseXtreamFromUrl("http://host/stream/abc.m3u8"), null);
  });
});

describe("deriveXtreamTimeshift", () => {
  it("builds the timeshift URL from an Xtream live URL", () => {
    const url = deriveXtreamTimeshift("http://host:8080/user/pass/200.m3u8", window);
    assert.equal(url, "http://host:8080/timeshift/user/pass/60/2024-03-10:12-00/200.ts");
  });

  it("handles a /live/ prefixed URL", () => {
    const url = deriveXtreamTimeshift("http://host/live/user/pass/200.ts", window);
    assert.equal(url, "http://host/timeshift/user/pass/60/2024-03-10:12-00/200.ts");
  });

  it("returns null when the URL isn't Xtream-shaped", () => {
    assert.equal(deriveXtreamTimeshift("http://host/stream/abc.m3u8", window), null);
  });
});

describe("fillCatchupTemplate", () => {
  it("fills epoch and duration placeholders", () => {
    const url = fillCatchupTemplate(
      "http://host/archive?start=${start}&dur=${duration}",
      "http://host/live/1.ts",
      window,
    );
    assert.equal(url, `http://host/archive?start=${startEpoch}&dur=3600`);
  });

  it("appends to the stream URL when the template has no scheme", () => {
    const url = fillCatchupTemplate("?utc={utc}", "http://host/live/1.ts", window);
    assert.equal(url, `http://host/live/1.ts?utc=${startEpoch}`);
  });

  it("fills date/time component placeholders", () => {
    const url = fillCatchupTemplate(
      "http://host/{Y}/{m}/{d}/{H}-{M}.ts",
      "http://host/live/1.ts",
      window,
    );
    assert.equal(url, "http://host/2024/03/10/12-00.ts");
  });
});

describe("appendDefaultCatchup", () => {
  it("appends utc and lutc query params", () => {
    const url = appendDefaultCatchup("http://host/live/1.ts", window);
    assert.match(url, new RegExp(`utc=${startEpoch}`));
    assert.match(url, /lutc=\d+/);
  });
});

describe("parseProgrammes", () => {
  const xml = [
    "<tv>",
    '<programme start="20240310120000 +0000" stop="20240310130000 +0000" start_timestamp="1710072000" stop_timestamp="1710075600" channel="bbc1.uk">',
    "<title>The News</title>",
    "<desc>Headlines &amp; weather</desc>",
    "</programme>",
    '<programme start="20240310130000 +0000" stop="20240310140000 +0000" start_timestamp="1710075600" stop_timestamp="1710079200" channel="other.uk">',
    "<title>Ignored</title>",
    "</programme>",
    "</tv>",
  ].join("\n");

  it("parses only the wanted channel and decodes entities", () => {
    const result = parseProgrammes(xml, new Set(["bbc1.uk"]));
    assert.equal(result.size, 1);
    const programs = result.get("bbc1.uk")!;
    assert.equal(programs.length, 1);
    assert.equal(programs[0]!.title, "The News");
    assert.equal(programs[0]!.description, "Headlines & weather");
    assert.equal(programs[0]!.startLocal, "2024-03-10 12:00:00");
    assert.equal(programs[0]!.start.getTime(), 1710072000 * 1000);
    assert.equal(programs[0]!.end.getTime(), 1710075600 * 1000);
  });

  it("skips channels that weren't asked for", () => {
    const result = parseProgrammes(xml, new Set(["bbc1.uk"]));
    assert.equal(result.has("other.uk"), false);
  });
});
