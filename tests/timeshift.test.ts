import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildNfo,
  buildTimeshiftUrl,
  download,
  edlPathFor,
  ensureEdl,
  formatStartForUrl,
  nfoPathFor,
  outputFilename,
  recordingWindow,
  setFileTime,
  streamToFile,
  syncNfo,
} from "../src/timeshift.js";
import type { Config } from "../src/config.js";
import type { Channel, EpgProgram } from "../src/source.js";
import { installFakeComskip, installFakeFfmpeg } from "./support.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    baseUrl: "http://example.com:8080",
    username: "user",
    password: "pass",
    downloadDir: "downloads",
    userAgent: undefined,
    timeshiftMode: "path",
    paddingBefore: 0,
    paddingAfter: 0,
    filenameTemplate: "{channel} - {title} - {datetime}.{ext}",
    filenameStrip: [],
    setAiredTime: true,
    writeNfo: true,
    comskip: false,
    ...overrides,
  };
}

const channel: Channel = {
  streamId: 42,
  name: "BBC One",
  archiveDays: 7,
};

function makeProgram(overrides: Partial<EpgProgram> = {}): EpgProgram {
  return {
    title: "Some Show",
    description: "",
    // 2024 so recordingWindow never caps the end at "now".
    start: new Date(Date.UTC(2024, 2, 10, 12, 0, 0)),
    end: new Date(Date.UTC(2024, 2, 10, 13, 0, 0)),
    startLocal: "2024-03-10 12:00:00",
    endLocal: "2024-03-10 13:00:00",
    hasArchive: true,
    ...overrides,
  };
}

describe("formatStartForUrl", () => {
  it("reformats a server-local string to YYYY-MM-DD:HH-MM", () => {
    assert.equal(formatStartForUrl("2024-03-10 12:00:00"), "2024-03-10:12-00");
  });

  it("drops the seconds", () => {
    assert.equal(formatStartForUrl("2024-03-10 09:05:30"), "2024-03-10:09-05");
  });
});

describe("recordingWindow", () => {
  it("uses the program length when there is no padding", () => {
    const window = recordingWindow(makeProgram(), 0, 0);
    assert.equal(window.minutes, 60);
    assert.equal(window.startLocal, "2024-03-10 12:00:00");
    assert.equal(window.endLocal, "2024-03-10 13:00:00");
  });

  it("adds padding before and after", () => {
    const window = recordingWindow(makeProgram(), 2, 5);
    assert.equal(window.minutes, 67);
    assert.equal(window.startLocal, "2024-03-10 11:58:00");
    assert.equal(window.endLocal, "2024-03-10 13:05:00");
  });

  it("trims with negative padding", () => {
    // Start 5 min later, end 10 min earlier: 60 - 5 - 10 = 45 min.
    const window = recordingWindow(makeProgram(), -5, -10);
    assert.equal(window.minutes, 45);
    assert.equal(window.startLocal, "2024-03-10 12:05:00");
  });

  it("shifts the start back by the before-padding across a day boundary", () => {
    const program = makeProgram({
      start: new Date(Date.UTC(2024, 2, 10, 0, 1, 0)),
      end: new Date(Date.UTC(2024, 2, 10, 0, 31, 0)),
      startLocal: "2024-03-10 00:01:00",
    });
    const window = recordingWindow(program, 5, 5);
    assert.equal(window.startLocal, "2024-03-09 23:56:00");
    assert.equal(window.minutes, 40);
  });

  it("caps the end at now for a still-airing program", () => {
    const now = Date.now();
    const program = makeProgram({
      start: new Date(now - 10 * 60_000), // started 10 minutes ago
      end: new Date(now + 60 * 60_000), // ends in an hour
    });
    // Without the cap this would be ~100 min; capped at "now" it's about 10.
    const window = recordingWindow(program, 0, 30);
    assert.ok(window.minutes >= 9 && window.minutes <= 12, `got ${window.minutes}`);
  });
});

describe("buildTimeshiftUrl", () => {
  it("builds a path-style URL", () => {
    const url = buildTimeshiftUrl(makeConfig(), 42, "2024-03-10 12:00:00", 60);
    assert.equal(
      url,
      "http://example.com:8080/timeshift/user/pass/60/2024-03-10:12-00/42.ts",
    );
  });

  it("url-encodes the username and password", () => {
    const url = buildTimeshiftUrl(
      makeConfig({ username: "a b", password: "p/@" }),
      42,
      "2024-03-10 12:00:00",
      60,
    );
    assert.equal(
      url,
      "http://example.com:8080/timeshift/a%20b/p%2F%40/60/2024-03-10:12-00/42.ts",
    );
  });

  it("builds a php-style URL", () => {
    const url = buildTimeshiftUrl(
      makeConfig({ timeshiftMode: "php" }),
      42,
      "2024-03-10 12:00:00",
      60,
    );
    assert.equal(
      url,
      "http://example.com:8080/streaming/timeshift.php?username=user&password=pass&stream=42&start=2024-03-10%3A12-00&duration=60",
    );
  });
});

describe("outputFilename", () => {
  it("fills the default template", () => {
    const name = outputFilename(
      makeConfig(),
      channel,
      makeProgram({ title: "The Show", startLocal: "2024-03-10 21:30:00" }),
    );
    assert.equal(name, "BBC One - The Show - 2024-03-10_21-30.ts");
  });

  it("sanitises illegal characters in the channel and title", () => {
    const name = outputFilename(
      makeConfig(),
      { ...channel, name: "News/Sport" },
      makeProgram({ title: "Launch: Part 1", startLocal: "2024-03-10 21:30:00" }),
    );
    assert.equal(name, "News-Sport - Launch- Part 1 - 2024-03-10_21-30.ts");
  });

  it("supports subfolders", () => {
    const name = outputFilename(
      makeConfig({ filenameTemplate: "{channel}/{title}.{ext}" }),
      channel,
      makeProgram({ title: "The Show" }),
    );
    assert.equal(name, "BBC One/The Show.ts");
  });

  it("fills the year, month and day tokens", () => {
    const name = outputFilename(
      makeConfig({ filenameTemplate: "{year}/{month}/{day} {title}.{ext}" }),
      channel,
      makeProgram({ title: "The Show", startLocal: "2024-03-10 21:30:00" }),
    );
    assert.equal(name, "2024/03/10 The Show.ts");
  });

  it("strips configured strings from the title", () => {
    const name = outputFilename(
      makeConfig({ filenameTemplate: "{title}.{ext}", filenameStrip: ["ᴸᶦᵛᵉ"] }),
      channel,
      makeProgram({ title: "Rocket Launch ᴸᶦᵛᵉ" }),
    );
    assert.equal(name, "Rocket Launch.ts");
  });

  it("tidies the spaces left by a mid-title strip", () => {
    const name = outputFilename(
      makeConfig({ filenameTemplate: "{title}.{ext}", filenameStrip: ["(HD)"] }),
      channel,
      makeProgram({ title: "Rocket (HD) Launch" }),
    );
    assert.equal(name, "Rocket Launch.ts");
  });

  it("uses an explicit filenameStrip over the config one", () => {
    const name = outputFilename(
      makeConfig({ filenameTemplate: "{title}.{ext}", filenameStrip: ["Launch"] }),
      channel,
      makeProgram({ title: "Rocket Launch ᴸᶦᵛᵉ" }),
      undefined,
      ["ᴸᶦᵛᵉ"],
    );
    assert.equal(name, "Rocket Launch.ts");
  });

  it("throws on an unexpected start format", () => {
    assert.throws(
      () =>
        outputFilename(
          makeConfig(),
          channel,
          makeProgram({ startLocal: "10/03/2024 21:30" }),
        ),
      /Unexpected EPG start format/,
    );
  });

  it("leaves unknown tokens untouched", () => {
    const name = outputFilename(
      makeConfig({ filenameTemplate: "{channel} {bogus}" }),
      channel,
      makeProgram(),
    );
    assert.equal(name, "BBC One {bogus}");
  });

  it("uses an explicit template over the config one", () => {
    const name = outputFilename(
      makeConfig({ filenameTemplate: "{title}.{ext}" }),
      channel,
      makeProgram({ title: "The Show" }),
      "{channel}/{title}.{ext}",
    );
    assert.equal(name, "BBC One/The Show.ts");
  });
});

describe("setFileTime", () => {
  it("sets the file's modified time", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-"));
    const file = path.join(dir, "recording.ts");
    await writeFile(file, "x");

    const aired = new Date(Date.UTC(2024, 2, 10, 13, 0, 0));
    await setFileTime(file, aired);

    const stats = await stat(file);
    assert.equal(stats.mtime.getTime(), aired.getTime());
  });
});

describe("nfoPathFor", () => {
  it("swaps the .ts extension for .nfo and keeps the directory", () => {
    assert.equal(
      nfoPathFor("/catchup/NASA TV/Launch - 2024-03-10_12-00.ts"),
      "/catchup/NASA TV/Launch - 2024-03-10_12-00.nfo",
    );
  });
});

describe("buildNfo", () => {
  it("fills the episode details", () => {
    const nfo = buildNfo(
      makeProgram({
        title: "Artemis II Launch",
        description: "Live launch coverage.",
        startLocal: "2024-03-10 21:30:00",
      }),
      "2024-03-10 22:05:00",
    );
    assert.match(nfo, /^<\?xml version="1\.0" encoding="UTF-8" standalone="yes"\?>/);
    assert.match(nfo, /<episodedetails>/);
    assert.match(nfo, /<title>Artemis II Launch<\/title>/);
    assert.match(nfo, /<plot>Live launch coverage\.<\/plot>/);
    assert.match(nfo, /<aired>2024-03-10<\/aired>/);
    assert.match(nfo, /<premiered>2024-03-10<\/premiered>/);
    assert.match(nfo, /<runtime>60<\/runtime>/); // makeProgram is a 60-minute show
    assert.match(nfo, /<dateadded>2024-03-10 22:05:00<\/dateadded>/);
  });

  it("escapes XML special characters", () => {
    const nfo = buildNfo(
      makeProgram({ title: "Apollo & Soyuz <Live>", description: 'Quote: "go"' }),
      "2024-03-10 22:05:00",
    );
    assert.match(nfo, /<title>Apollo &amp; Soyuz &lt;Live&gt;<\/title>/);
    assert.match(nfo, /<plot>Quote: &quot;go&quot;<\/plot>/);
  });

  it("lifts a season/episode prefix out of the description", () => {
    const nfo = buildNfo(
      makeProgram({
        title: "Apollo Diaries",
        description: "S2 E5 Orbital Insertion\nLive coverage of the second crewed flight.",
      }),
      "2024-03-10 22:05:00",
    );
    assert.match(nfo, /<season>2<\/season>/);
    assert.match(nfo, /<episode>5<\/episode>/);
    // The prefix is stripped from the plot so it isn't repeated.
    assert.match(nfo, /<plot>Orbital Insertion\nLive coverage of the second crewed flight\.<\/plot>/);
  });

  it("omits season/episode when the description has no prefix", () => {
    const nfo = buildNfo(
      makeProgram({ description: "Live coverage of the launch." }),
      "2024-03-10 22:05:00",
    );
    assert.doesNotMatch(nfo, /<season>/);
    assert.doesNotMatch(nfo, /<episode>/);
    assert.match(nfo, /<plot>Live coverage of the launch\.<\/plot>/);
  });
});

describe("syncNfo", () => {
  const now = new Date(Date.UTC(2024, 2, 10, 22, 5, 0));

  it("creates the sidecar next to the recording", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-"));
    const recording = path.join(dir, "Launch - 2024-03-10_12-00.ts");

    const result = await syncNfo(makeProgram({ title: "Launch" }), recording, now);

    assert.equal(result.status, "created");
    assert.equal(result.path, path.join(dir, "Launch - 2024-03-10_12-00.nfo"));
    const written = (await readFile(result.path)).toString();
    assert.match(written, /<title>Launch<\/title>/);
  });

  it("reports unchanged on an identical second call", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-"));
    const recording = path.join(dir, "show.ts");

    await syncNfo(makeProgram(), recording, now);
    const second = await syncNfo(makeProgram(), recording, new Date(now.getTime() + 60_000));

    assert.equal(second.status, "unchanged");
  });

  it("updates changed metadata but keeps the original dateadded", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-"));
    const recording = path.join(dir, "show.ts");

    const first = await syncNfo(makeProgram({ title: "Old title" }), recording, now);
    const originalDateAdded = (await readFile(first.path)).toString().match(/<dateadded>(.*?)<\/dateadded>/)![1];

    const later = new Date(now.getTime() + 3_600_000);
    const result = await syncNfo(makeProgram({ title: "New title" }), recording, later);

    assert.equal(result.status, "updated");
    const written = (await readFile(result.path)).toString();
    assert.match(written, /<title>New title<\/title>/);
    // dateadded is preserved from the first write, not the later "now".
    assert.match(written, new RegExp(`<dateadded>${originalDateAdded}</dateadded>`));
  });
});

describe("streamToFile", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("streams the response body to a file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-"));
    const dest = path.join(dir, "out.ts");
    const data = Buffer.from("a recording's worth of bytes");
    globalThis.fetch = (async () =>
      new Response(data, {
        headers: { "content-length": String(data.length) },
      })) as unknown as typeof globalThis.fetch;

    const result = await streamToFile(makeConfig(), "http://example.com/x.ts", dest);

    assert.equal(result.bytesDownloaded, data.length);
    assert.equal(result.expectedBytes, data.length);
    assert.equal((await readFile(dest)).toString(), data.toString());
  });

  it("throws on a non-OK response", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-"));
    globalThis.fetch = (async () =>
      new Response("nope", { status: 404, statusText: "Not Found" })) as unknown as typeof globalThis.fetch;

    await assert.rejects(
      streamToFile(makeConfig(), "http://example.com/x.ts", path.join(dir, "out.ts")),
      /Download failed: 404 Not Found/,
    );
  });

  it("accepts a stream that dies within 1% of the advertised length", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-"));
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new Uint8Array(995)); // 995 of 1000 advertised bytes
        // Let the chunk flush through the pipeline before the "connection" dies,
        // like a real server that closes just short of the advertised length.
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.error(new Error("connection reset"));
      },
    });
    globalThis.fetch = (async () =>
      new Response(body, { headers: { "content-length": "1000" } })) as unknown as typeof globalThis.fetch;

    const result = await streamToFile(makeConfig(), "http://example.com/x.ts", path.join(dir, "out.ts"));

    assert.equal(result.bytesDownloaded, 995);
    assert.equal(result.expectedBytes, 1000);
  });

  it("throws when the stream dies with a real shortfall", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-"));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(100)); // only 100 of 1000 advertised bytes
        controller.error(new Error("connection reset"));
      },
    });
    globalThis.fetch = (async () =>
      new Response(body, { headers: { "content-length": "1000" } })) as unknown as typeof globalThis.fetch;

    await assert.rejects(
      streamToFile(makeConfig(), "http://example.com/x.ts", path.join(dir, "out.ts")),
      /connection reset/,
    );
  });
});

describe("download", () => {
  const realFetch = globalThis.fetch;
  let restoreFfmpeg: (() => void) | undefined;
  afterEach(() => {
    globalThis.fetch = realFetch;
    restoreFfmpeg?.();
    restoreFfmpeg = undefined;
  });

  function serveBytes(data: string): void {
    globalThis.fetch = (async () =>
      new Response(Buffer.from(data), {
        headers: { "content-length": String(Buffer.byteLength(data)) },
      })) as unknown as typeof globalThis.fetch;
  }

  it("downloads, remuxes and puts the finished file in place", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-"));
    serveBytes("raw transport stream");
    restoreFfmpeg = await installFakeFfmpeg("copy");

    const result = await download(
      makeConfig({ downloadDir: dir }),
      "http://example.com/x.ts",
      "Artemis II Launch.ts",
    );

    assert.equal(result.outputPath, path.join(dir, "Artemis II Launch.ts"));
    assert.equal((await readFile(result.outputPath)).toString(), "raw transport stream");
    // The .part and .remux work files are gone; only the finished recording remains.
    assert.deepEqual(await readdir(dir), ["Artemis II Launch.ts"]);
  });

  it("cleans up the work files and rethrows when the remux fails", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-"));
    serveBytes("raw transport stream");
    restoreFfmpeg = await installFakeFfmpeg("fail");

    await assert.rejects(
      download(makeConfig({ downloadDir: dir }), "http://example.com/x.ts", "Artemis II Launch.ts"),
      /ffmpeg failed: corrupt input/,
    );
    assert.deepEqual(await readdir(dir), []);
  });

  it("explains how to install ffmpeg when it's missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-"));
    serveBytes("raw transport stream");
    const emptyPath = await mkdtemp(path.join(tmpdir(), "no-ffmpeg-"));
    const realPath = process.env.PATH;
    process.env.PATH = emptyPath;

    try {
      await assert.rejects(
        download(makeConfig({ downloadDir: dir }), "http://example.com/x.ts", "Artemis II Launch.ts"),
        /ffmpeg not found/,
      );
    } finally {
      process.env.PATH = realPath;
    }
    assert.deepEqual(await readdir(dir), []);
  });
});

describe("edlPathFor", () => {
  it("swaps the .ts extension for .edl and keeps the directory", () => {
    assert.equal(
      edlPathFor("/catchup/NASA TV/Launch - 2024-03-10_12-00.ts"),
      "/catchup/NASA TV/Launch - 2024-03-10_12-00.edl",
    );
  });
});

describe("ensureEdl", () => {
  const realComskipPath = process.env.COMSKIP_PATH;
  afterEach(() => {
    if (realComskipPath === undefined) delete process.env.COMSKIP_PATH;
    else process.env.COMSKIP_PATH = realComskipPath;
  });

  it("runs comskip to create the .edl when it's missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-"));
    const recording = path.join(dir, "Artemis II Launch.ts");
    await writeFile(recording, "x");
    process.env.COMSKIP_PATH = await installFakeComskip("edl");

    const result = await ensureEdl(recording);

    assert.equal(result.status, "created");
    assert.equal(result.path, path.join(dir, "Artemis II Launch.edl"));
    assert.ok(await readFile(result.path)); // the .edl exists
  });

  it("treats an empty .edl from a non-zero exit as success (no commercials found)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-"));
    const recording = path.join(dir, "clean.ts");
    await writeFile(recording, "x");
    process.env.COMSKIP_PATH = await installFakeComskip("empty");

    const result = await ensureEdl(recording);

    assert.equal(result.status, "created");
    assert.equal((await readFile(result.path)).toString(), "");
  });

  it("leaves an existing .edl alone and doesn't run comskip", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-"));
    const recording = path.join(dir, "show.ts");
    await writeFile(recording, "x");
    await writeFile(path.join(dir, "show.edl"), "kept");
    // A failing comskip: if ensureEdl ran it, the call would reject.
    process.env.COMSKIP_PATH = await installFakeComskip("fail");

    const result = await ensureEdl(recording);

    assert.equal(result.status, "exists");
    assert.equal((await readFile(result.path)).toString(), "kept");
  });

  it("rejects when comskip writes no .edl, so callers can treat it as non-fatal", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-"));
    const recording = path.join(dir, "show.ts");
    await writeFile(recording, "x");
    process.env.COMSKIP_PATH = await installFakeComskip("fail");

    await assert.rejects(ensureEdl(recording), /comskip produced no .edl: no video stream/);
  });

  it("explains how to install comskip when the binary is missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "timeshifter-"));
    const recording = path.join(dir, "show.ts");
    await writeFile(recording, "x");
    process.env.COMSKIP_PATH = path.join(dir, "does-not-exist");

    await assert.rejects(ensureEdl(recording), /comskip not found/);
  });
});
