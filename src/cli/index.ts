#!/usr/bin/env node
import { Command } from "commander";
import { registerAgentCommands } from "./commands/agents.js";
import { registerCatchupCommand } from "./commands/catchup.js";
import { registerClerkCommands } from "./commands/clerk.js";
import { registerDocsCommand } from "./commands/docs.js";
import { registerEventCommands } from "./commands/events.js";
import { registerProjectCommands } from "./commands/projects.js";
import { registerRoadmapCommands } from "./commands/roadmap.js";

const program = new Command();
program
  .name("ledger")
  .description(
    "Durable state store for a personal agent-orchestration workflow " +
      "(projects, roadmap, dispatched agents, events).",
  )
  .version("0.1.0");

registerProjectCommands(program);
registerRoadmapCommands(program);
registerAgentCommands(program);
registerEventCommands(program);
registerClerkCommands(program);
registerCatchupCommand(program);
registerDocsCommand(program);

program.exitOverride();

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if ((err as { code?: string }).code?.startsWith("commander.")) {
    process.exit((err as { exitCode?: number }).exitCode ?? 1);
  }
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
}
