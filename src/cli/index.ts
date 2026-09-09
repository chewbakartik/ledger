#!/usr/bin/env node
// Must come first — see the comment in suppress-experimental-warnings.ts.
import "./suppress-experimental-warnings.js";
import { Command } from "commander";
import { registerAgentCommands } from "./commands/agents.js";
import { registerCatchupCommand } from "./commands/catchup.js";
import { registerClerkCommands } from "./commands/clerk.js";
import { registerDocsCommand } from "./commands/docs.js";
import { registerEventCommands } from "./commands/events.js";
import { registerInitCommand } from "./commands/init.js";
import { registerProjectCommands } from "./commands/projects.js";
import { registerRoadmapCommands } from "./commands/roadmap.js";
import { registerUpdateCommand } from "./commands/update.js";
import { touchClerkHeartbeat } from "../db/client.js";
import { packageVersion } from "../lib/package-info.js";

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
registerUpdateCommand(program);

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
