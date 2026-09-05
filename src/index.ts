#!/usr/bin/env -S npx tsx
import { loadConfig } from "./config.js";
import { run } from "./cli.js";
import { runWatch } from "./watch.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const command = process.argv[2];

  if (command === "watch") {
    const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");
    await runWatch(config, dryRun);
    return;
  }

  // No command at all does the same as "manage", so double clicking the binary
  // or a bare "docker run" still gets you somewhere useful.
  if (command && command !== "manage") {
    throw new Error(
      `Unknown command "${command}". Use "manage" (or nothing) to pick shows, or "watch" to download automatically.`,
    );
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
