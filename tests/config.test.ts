import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

// All env vars loadConfig reads. We clear these, apply overrides, then restore,
// so tests don't pick up the developer's real .env (loaded via dotenv).
const KEYS = [
  "IPTV_URL", "IPTV_USERNAME", "IPTV_PASSWORD",
  "OUTPUT_FORMAT", "TIMESHIFT_MODE", "DOWNLOAD_DIR", "IPTV_USER_AGENT",
  "PADDING_BEFORE_MINUTES", "PADDING_AFTER_MINUTES",
  "FILENAME_TEMPLATE", "VERBOSE", "SET_AIRED_TIME",
];

const BASE = {
  IPTV_URL: "http://example.com:8080",
  IPTV_USERNAME: "user",
  IPTV_PASSWORD: "pass",
};

function loadWith(overrides: Record<string, string> = {}) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, overrides);
  try {
    return loadConfig();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("loadConfig", () => {
  it("applies sensible defaults", () => {
    const config = loadWith(BASE);
    assert.equal(config.outputFormat, "ts");
    assert.equal(config.timeshiftMode, "path");
    assert.equal(config.downloadDir, "downloads");
    assert.equal(config.paddingBefore, 0);
    assert.equal(config.paddingAfter, 0);
    assert.equal(config.verbose, false);
    assert.equal(config.setAiredTime, true); // on by default
  });

  it("strips a trailing slash from the base URL", () => {
    assert.equal(loadWith({ ...BASE, IPTV_URL: "http://example.com:8080/" }).baseUrl, "http://example.com:8080");
  });

  it("throws when a required field is missing", () => {
    assert.throws(() => loadWith({ IPTV_USERNAME: "user", IPTV_PASSWORD: "pass" }));
  });

  it("rejects an invalid output format", () => {
    assert.throws(() => loadWith({ ...BASE, OUTPUT_FORMAT: "mkv" }));
  });

  it("rejects an invalid timeshift mode", () => {
    assert.throws(() => loadWith({ ...BASE, TIMESHIFT_MODE: "weird" }));
  });

  it("rejects negative or non-numeric padding", () => {
    assert.throws(() => loadWith({ ...BASE, PADDING_BEFORE_MINUTES: "-1" }));
    assert.throws(() => loadWith({ ...BASE, PADDING_AFTER_MINUTES: "abc" }));
  });

  it("parses booleans, including SET_AIRED_TIME being off", () => {
    const config = loadWith({ ...BASE, VERBOSE: "true", SET_AIRED_TIME: "false" });
    assert.equal(config.verbose, true);
    assert.equal(config.setAiredTime, false);
  });
});
