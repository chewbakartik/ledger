import { Command } from "commander";
import { getDb, rollbackTo } from "../../db/client.js";
import { verifyRoadmapKeys } from "../../db/migrations/0006_roadmap_item_keys.js";
import { migrations } from "../../db/migrations/index.js";
import { printJson } from "../format.js";

export function registerDbCommands(program: Command): void {
  const dbCmd = program.command("db").description("inspect, verify and roll back the store's schema");

  dbCmd
    .command("status")
    .description("show applied schema migrations and whether any are pending")
    .action(() => {
      const db = getDb(); // opening the store applies anything pending
      const applied = db
        .prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version")
        .all();
      printJson({
        applied,
        latest_known: migrations[migrations.length - 1]?.version ?? 0,
        reversible: migrations.filter((m) => m.down).map((m) => m.version),
      });
    });

  dbCmd
    .command("verify")
    .description(
      "re-run the roadmap-key backfill checks (migration 0006): every item keyed, " +
        "numbered 1..n per project in id order, counters consistent, no dangling " +
        "item references. Read-only; exits non-zero on any problem.",
    )
    .action(() => {
      const db = getDb();
      verifyRoadmapKeys(db);
      const counts = db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM projects) AS projects,
                  (SELECT COUNT(*) FROM roadmap) AS roadmap_items,
                  (SELECT COUNT(*) FROM agents) AS agents,
                  (SELECT COUNT(*) FROM events) AS events`,
        )
        .get();
      printJson({ ok: true, ...counts });
    });

  dbCmd
    .command("rollback")
    .description(
      "reverse schema migrations down to --to <version> (newest first). " +
        "Destructive for data added by the reversed migrations (e.g. rolling back " +
        "6 drops roadmap keys/codes); a pre-migration snapshot is in " +
        "$LEDGER_HOME/backups. Afterwards run the OLDER ledger binary — a newer " +
        "one re-migrates forward on its next run.",
    )
    .requiredOption("--to <version>", "schema version to roll back to, e.g. 5", (v) => Number.parseInt(v, 10))
    .option("--yes", "confirm you want to reverse these migrations")
    .action((opts: { to: number; yes?: boolean }) => {
      if (!Number.isInteger(opts.to) || opts.to < 0) throw new Error("--to must be a non-negative integer");
      if (!opts.yes) {
        throw new Error("rollback is destructive for the reversed migrations' data — pass --yes to confirm");
      }
      const db = getDb();
      const reversed = rollbackTo(db, opts.to);
      printJson({ rolled_back: reversed, now_at: opts.to });
    });
}
