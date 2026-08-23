import { Command } from "commander";
import { getDb } from "../../db/client.js";
import type { EventRow } from "../../db/types.js";
import { printJson, printTable } from "../format.js";
import { getAgentById } from "./agents.js";

export function registerEventCommands(program: Command): void {
  const event = program.command("event").description("the append-only audit log");

  event
    .command("add")
    .description("record a free-form event against an agent")
    .requiredOption("--agent <id>", "agent id", parseIntOpt)
    .requiredOption("--type <type>", "event type, e.g. note, state_change")
    .option("--payload <json>", "free-form JSON payload")
    .action((opts: { agent: number; type: string; payload?: string }) => {
      getAgentById(opts.agent); // throws if missing
      if (opts.payload) {
        try {
          JSON.parse(opts.payload);
        } catch {
          throw new Error("--payload must be valid JSON");
        }
      }

      const row = getDb()
        .prepare(
          `INSERT INTO events (agent_id, event_type, payload)
           VALUES (?, ?, ?)
           RETURNING *`,
        )
        .get(opts.agent, opts.type, opts.payload ?? null) as EventRow;

      printJson(row);
    });

  event
    .command("list")
    .description("list events, newest first")
    .option("--agent <id>", "filter by agent id", parseIntOpt)
    .option("--since <iso>", "only events after this timestamp (e.g. from a prior catchup)")
    .option("--json", "output as JSON")
    .action((opts: { agent?: number; since?: string; json?: boolean }) => {
      let sql = "SELECT * FROM events WHERE 1=1";
      const params: unknown[] = [];

      if (opts.agent !== undefined) {
        sql += " AND agent_id = ?";
        params.push(opts.agent);
      }
      if (opts.since) {
        sql += " AND created_at > ?";
        params.push(opts.since);
      }
      sql += " ORDER BY created_at DESC, id DESC";

      const rows = getDb().prepare(sql).all(...params) as EventRow[];
      if (opts.json) printJson(rows);
      else printTable(rows);
    });
}

function parseIntOpt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`not a valid integer: ${value}`);
  return n;
}
