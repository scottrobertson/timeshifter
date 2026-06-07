import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

const BASE = {
  url: "http://example.com:8080",
  username: "user",
  password: "pass",
  downloadDir: "downloads",
};

// Write a config.json to a temp dir and load it. Each call gets its own file so
// the cases don't interfere.
function loadWith(config: Record<string, unknown>) {
  const dir = mkdtempSync(path.join(tmpdir(), "timeshifter-config-"));
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(config));
  return loadConfig(file);
}

describe("loadConfig", () => {
  it("applies sensible defaults", () => {
    const config = loadWith(BASE);
    assert.equal(config.timeshiftMode, "path");
    assert.equal(config.paddingBefore, 0);
    assert.equal(config.paddingAfter, 0);
    assert.equal(config.setAiredTime, true); // on by default
  });

  it("throws when downloadDir is missing", () => {
    assert.throws(() => loadWith({ url: BASE.url, username: "user", password: "pass" }));
  });

  it("strips a trailing slash from the base URL", () => {
    assert.equal(loadWith({ ...BASE, url: "http://example.com:8080/" }).baseUrl, "http://example.com:8080");
  });

  it("throws when a required field is missing", () => {
    assert.throws(() => loadWith({ username: "user", password: "pass" }));
  });

  it("rejects an invalid timeshift mode", () => {
    assert.throws(() => loadWith({ ...BASE, timeshiftMode: "weird" }));
  });

  it("allows negative padding (trim) but rejects non-integers", () => {
    assert.equal(loadWith({ ...BASE, paddingBefore: -2 }).paddingBefore, -2);
    assert.throws(() => loadWith({ ...BASE, paddingAfter: "abc" }));
  });

  it("turns setAiredTime off when set to false", () => {
    assert.equal(loadWith({ ...BASE, setAiredTime: false }).setAiredTime, false);
  });

  it("throws on invalid JSON", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "timeshifter-config-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, "{ not json");
    assert.throws(() => loadConfig(file), /isn't valid JSON/);
  });

  it("throws when the file is missing", () => {
    assert.throws(() => loadConfig("/no/such/config.json"), /Couldn't read/);
  });
});
