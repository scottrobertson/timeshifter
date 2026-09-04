#!/usr/bin/env -S npx tsx
import { loadConfig } from "./config.js";
import { run } from "./cli.js";
import { runSchedule } from "./schedule-cli.js";
import { runWatch } from "./watch.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (process.argv[2] === "watch") {
    const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");
    await runWatch(config, dryRun);
    return;
  }
  // Both spellings, because either is a fair guess at what it's called.
  if (process.argv[2] === "schedule" || process.argv[2] === "scheduled") {
    await runSchedule(config);
    return;
  }
  await run(config);
}

main().catch((err) => {
  // Inquirer throws this when you ctrl-c out of a prompt; treat it as a clean exit.
  if (err instanceof Error && err.name === "ExitPromptError") {
    process.exit(0);
  }
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
