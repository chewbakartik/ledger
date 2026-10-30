import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { DatabaseSync as Db } from "node:sqlite";
import { applyMigrations, rollbackTo } from "../client.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof Db;
};

const maxVersion = (db: Db) =>
  (db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v;
const hasWatches = (db: Db) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'watches'").get() !== undefined;

/** A v6 store with a project, a keyed roadmap item and an agent. */
function v6Store(): Db {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db, { target: 6 });
  db.exec(`
    INSERT INTO projects (name, repo_url, local_clone_path, default_branch) VALUES ('p','u','/p','main');
    INSERT INTO roadmap (project_id, title) VALUES (1, 'item');
    INSERT INTO agents (project_id, roadmap_item_id, task_description, worktree_path,
      herdr_workspace, herdr_tab, herdr_pane, coding_agent)
      VALUES (1, 1, 't', '/w', 'w', 't', 'p', 'claude');
  `);
  return db;
}

test("upgrade from v6 adds watches without touching existing data", () => {
  const db = v6Store();
  assert.equal(hasWatches(db), false);
  const before = JSON.stringify(db.prepare("SELECT * FROM agents").all());

  applyMigrations(db);

  assert.equal(maxVersion(db), 7);
  assert.ok(hasWatches(db));
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM agents").all()), before);
});

test("watches constraints: needs an agent or item; status/trigger enums; defaults", () => {
  const db = v6Store();
  applyMigrations(db);
  const ins = (cols: string, vals: string) =>
    db.exec(`INSERT INTO watches (project_id, ${cols}, steps, expires_at) VALUES (1, ${vals}, '["x"]', datetime('now','+1 day'))`);

  assert.throws(() => db.exec(`INSERT INTO watches (project_id, steps, expires_at) VALUES (1, '["x"]', datetime('now'))`));
  ins("agent_id", "1");
  ins("roadmap_item_id", "1");
  assert.throws(() => db.exec("UPDATE watches SET status = 'bogus' WHERE id = 1"));
  assert.throws(() => db.exec("UPDATE watches SET authorization_basis = 'user-explicit' WHERE id = 1"));
  const w = db.prepare("SELECT * FROM watches WHERE id = 1").get() as Record<string, unknown>;
  assert.equal(w["status"], "open");
  assert.equal(w["on_states"], "done,blocked,failed");
  assert.equal(w["pending_wake"], 0);
  assert.equal(w["step_index"], 0);
});

test("rollback to v6 drops watches; re-upgrade works; v6 data survives", () => {
  const db = v6Store();
  applyMigrations(db);
  assert.deepEqual(rollbackTo(db, 6), [7]);
  assert.equal(maxVersion(db), 6);
  assert.equal(hasWatches(db), false);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n, 1);
  applyMigrations(db);
  assert.ok(hasWatches(db));
});
