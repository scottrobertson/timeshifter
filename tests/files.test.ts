import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { configPath } from "../src/files.js";

describe("configPath", () => {
  const real = process.env.TIMESHIFTER_CONFIG_DIR;
  afterEach(() => {
    if (real === undefined) delete process.env.TIMESHIFTER_CONFIG_DIR;
    else process.env.TIMESHIFTER_CONFIG_DIR = real;
  });

  it("uses a config folder in the current directory by default", () => {
    delete process.env.TIMESHIFTER_CONFIG_DIR;
    assert.equal(configPath("config.json"), "config/config.json");
  });

  it("uses TIMESHIFTER_CONFIG_DIR when it's set, which is what the Docker image does", () => {
    process.env.TIMESHIFTER_CONFIG_DIR = "/config";
    assert.equal(configPath("scheduled.json"), "/config/scheduled.json");
  });
});
