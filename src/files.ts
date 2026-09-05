import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Where config.json, scheduled.json and comskip.ini live: a "config" folder in
 * the directory you're in. The Docker image points TIMESHIFTER_CONFIG_DIR at
 * /config instead, which is the folder you mount there.
 */
export function configPath(name: string): string {
  return path.join(process.env.TIMESHIFTER_CONFIG_DIR || "config", name);
}

/** Read a file, saying what's actually wrong when it can't be read. */
export function readTextFile(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EISDIR") {
      throw new Error(
        `${file} is a directory, not a file. Docker makes a directory when you bind mount ` +
          `a file that doesn't exist yet, so delete it and mount the folder it lives in instead.`,
      );
    }
    throw new Error(`${file} couldn't be read: ${(err as Error).message}`);
  }
}
