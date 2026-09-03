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
