import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncCtor } from "node:sqlite";
import { migrations } from "./migrations/index.js";

// node:sqlite emits its one-time ExperimentalWarning as soon as the module
// is *loaded* — a static `import ... from "node:sqlite"` here would trigger
// it during ESM's graph-link phase, before the CLI entry point's warning
// filter (src/cli/suppress-experimental-warnings.ts) has run. Loading it
// via `require` instead defers that load to normal, in-order statement
// execution, so the filter is already installed by the time it fires.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncCtor;
};

export function ledgerHome(): string {
  return process.env["LEDGER_HOME"] ?? join(homedir(), ".ledger");
}

export function projectsDir(): string {
  return join(ledgerHome(), "projects");
}

let db: DatabaseSyncCtor | undefined;

export function getDb(): DatabaseSyncCtor {
  if (db) return db;

  const home = ledgerHome();
  mkdirSync(home, { recursive: true });
  mkdirSync(projectsDir(), { recursive: true });

  db = new DatabaseSync(join(home, "ledger.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  applyMigrations(db);

  return db;
}

let suppressNextHeartbeat = false;

/**
 * `clerk claim`'s own upsert resets last_seen to NULL on every claim,
 * fresh or forced — "a fresh claim starts a fresh clock" (DECISIONS.md,
 * item 27). Without this, the generic post-command heartbeat below would
 * immediately overwrite that NULL with `now` before the same invocation
 * ends, erasing the reset the claim command just made. Call this right
 * after the upsert; it's consumed (one-shot) by this invocation's own
 * touchClerkHeartbeat() call in src/cli/index.ts.
 */
export function suppressNextClerkHeartbeat(): void {
  suppressNextHeartbeat = true;
}

/**
 * Item 27 (activity-based clerk liveness, 2026-09-03 user decision):
 * bump first_clerk.last_seen so staleness reflects real activity, not
 * just time-since-claim. Called once per CLI invocation, from
 * src/cli/index.ts, AFTER the invoked command's own logic has run —
 * deliberately not from inside getDb() itself. `clerk claim` reads
 * first_clerk to decide whether the *existing* claim is stale before it
 * does anything else; if a heartbeat fired on that same getDb() call it
 * would stamp last_seen = now on the very row being checked (which may
 * belong to a different, possibly-dead session) and erase the staleness
 * the check exists to detect. Running the heartbeat after the command
 * body closes that gap.
 *
 * A no-op if the store was never opened this invocation (e.g. --help),
 * there's no first_clerk row yet (0 rows updated), or the invocation was
 * itself a `clerk claim` (see suppressNextClerkHeartbeat). Never throws:
 * a heartbeat failure must not fail the command it's riding on, so any
 * error is only warned to stderr.
 */
export function touchClerkHeartbeat(): void {
  if (suppressNextHeartbeat) {
    suppressNextHeartbeat = false;
    return;
  }
  if (!db) return;
  try {
    db.prepare("UPDATE first_clerk SET last_seen = datetime('now') WHERE id = 1").run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Warning: clerk heartbeat failed: ${msg}`);
  }
}

function applyMigrations(database: DatabaseSyncCtor): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const appliedRow = database
    .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations")
    .get() as { v: number };
  const applied = appliedRow.v;

  const pending = migrations.filter((m) => m.version > applied);
  if (pending.length === 0) return;

  const insertMigration = database.prepare(
    "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
  );

  for (const migration of pending) {
    // node:sqlite's DatabaseSync has no built-in `.transaction()` helper
    // (unlike better-sqlite3) — drive BEGIN/COMMIT/ROLLBACK explicitly.
    database.exec("BEGIN");
    try {
      database.exec(migration.sql);
      insertMigration.run(migration.version, migration.name);
      database.exec("COMMIT");
    } catch (err) {
      database.exec("ROLLBACK");
      throw err;
    }
  }
}
