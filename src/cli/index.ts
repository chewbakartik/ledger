#!/usr/bin/env node
// Must come first — see the comment in suppress-experimental-warnings.ts.
import "./suppress-experimental-warnings.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerAgentCommands } from "./commands/agents.js";
import { registerCatchupCommand } from "./commands/catchup.js";
import { registerClerkCommands } from "./commands/clerk.js";
import { registerDocsCommand } from "./commands/docs.js";
import { registerEventCommands } from "./commands/events.js";
import { registerInitCommand } from "./commands/init.js";
import { registerProjectCommands } from "./commands/projects.js";
import { registerRoadmapCommands } from "./commands/roadmap.js";
import { touchClerkHeartbeat } from "../db/client.js";

// The version is derived from the package's own package.json at runtime —
// package.json is the ONLY source of it. This entry compiles to
// dist/cli/index.js, two levels below the package root, so resolve the
// file relative to *this running code's own location* rather than the cwd
// (same approach as docs.ts): that works from any invocation directory, in
// a dev checkout, and in an npm install (the npm tarball carries
// package.json at its root — verified in the 0.1.2 tarball). Publishing
// bumps package.json, and since this reads package.json, the two can never
// desync — a literal here is a second copy and is forbidden.
// Graceful degradation: if the file can't be read or parsed (a corrupt
// install), report "unknown" instead of throwing — a version query must
// never crash the CLI (item 30, DECISIONS.md).
function packageVersion(): string {
  const pkgJsonPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "package.json",
  );
  try {
    const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      version?: string;
    };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const program = new Command();
program
  .name("ledger")
  .description(
    "Durable state store for a personal agent-orchestration workflow " +
      "(projects, roadmap, dispatched agents, events).",
  )
  .version(packageVersion());

registerProjectCommands(program);
registerRoadmapCommands(program);
registerAgentCommands(program);
registerEventCommands(program);
registerClerkCommands(program);
registerCatchupCommand(program);
registerDocsCommand(program);
registerInitCommand(program);

program.exitOverride();

try {
  await program.parseAsync(process.argv);
  // Item 27: heartbeat after the command has run its own logic — see
  // touchClerkHeartbeat's doc comment for why it can't live in getDb().
  touchClerkHeartbeat();
} catch (err) {
  touchClerkHeartbeat();
  if ((err as { code?: string }).code?.startsWith("commander.")) {
    process.exit((err as { exitCode?: number }).exitCode ?? 1);
  }
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
}
