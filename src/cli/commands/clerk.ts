import { Command } from "commander";
import { getDb } from "../../db/client.js";
import type { FirstClerkRow } from "../../db/types.js";
import { printJson } from "../format.js";

const STALE_AFTER_HOURS = 12;

export function registerClerkCommands(program: Command): void {
  const clerk = program.command("clerk").description("first-clerk authority (single row)");

  clerk
    .command("claim")
    .description(
      "claim first-clerk authority. Fails if another claim is active and not " +
        "stale, unless --force is given",
    )
    .requiredOption("--session-id <id>", "this clerk session's id")
    .requiredOption("--herdr-pane <id>", "this clerk's own herdr pane id")
    .option("--force", "claim even if the existing claim is not stale")
    .action((opts: { sessionId: string; herdrPane: string; force?: boolean }) => {
      const db = getDb();
      const existing = db
        .prepare("SELECT * FROM first_clerk WHERE id = 1")
        .get() as FirstClerkRow | undefined;

      if (existing && !opts.force && !isStale(existing)) {
        throw new Error(
          `first_clerk is already claimed by session ${existing.session_id} ` +
            `(pane ${existing.herdr_pane}, claimed ${existing.claimed_at}). ` +
            `Pass --force to override.`,
        );
      }

      const row = db
        .prepare(
          `INSERT INTO first_clerk (id, session_id, herdr_pane, claimed_at)
           VALUES (1, ?, ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET
             session_id = excluded.session_id,
             herdr_pane = excluded.herdr_pane,
             claimed_at = excluded.claimed_at,
             last_seen = NULL
           RETURNING *`,
        )
        .get(opts.sessionId, opts.herdrPane) as FirstClerkRow;

      printJson(row);
    });

  clerk
    .command("status")
    .description("show the current first-clerk claim, if any")
    .action(() => {
      const row = getDb()
        .prepare("SELECT * FROM first_clerk WHERE id = 1")
        .get() as FirstClerkRow | undefined;
      printJson(row ?? null);
    });
}

function isStale(row: FirstClerkRow): boolean {
  const claimedAt = new Date(row.claimed_at + "Z").getTime();
  const ageHours = (Date.now() - claimedAt) / (1000 * 60 * 60);
  return ageHours > STALE_AFTER_HOURS;
}
