import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { migrations } from "./migrations/index.js";

export function ledgerHome(): string {
  return process.env["LEDGER_HOME"] ?? join(homedir(), ".ledger");
}

export function projectsDir(): string {
  return join(ledgerHome(), "projects");
}

let db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (db) return db;

  const home = ledgerHome();
  mkdirSync(home, { recursive: true });
  mkdirSync(projectsDir(), { recursive: true });

  db = new Database(join(home, "ledger.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  applyMigrations(db);

  return db;
}

function applyMigrations(database: Database.Database): void {
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
    const run = database.transaction(() => {
      database.exec(migration.sql);
      insertMigration.run(migration.version, migration.name);
    });
    run();
  }
}
