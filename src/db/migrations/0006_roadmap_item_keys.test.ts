import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DatabaseSync as Db } from "node:sqlite";
import { applyMigrations, backupStore, rollbackTo } from "../client.js";
import { deriveBackfillCode, verifyRoadmapKeys } from "./0006_roadmap_item_keys.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof Db;
};

/** A store at schema v5 holding pre-keys data: 3 projects, interleaved items, parents, agents, events. */
function v5Store(): Db {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db, { target: 5 });
  const proj = db.prepare(
    "INSERT INTO projects (name, repo_url, local_clone_path, default_branch) VALUES (?, 'u', '/p', 'main')",
  );
  // "my-app" and "My App" both collapse to MYAPP -> collision.
  for (const n of ["ledger", "my-app", "My App"]) proj.run(n);
  const item = db.prepare("INSERT INTO roadmap (project_id, parent_id, title, status) VALUES (?, ?, ?, ?)");
  item.run(1, null, "l1", "merged"); //   id 1  ledger #1
  item.run(2, null, "m1", "planned"); //  id 2  my-app #1
  item.run(1, 1, "l2 (child of l1)", "in_progress"); // id 3 ledger #2
  item.run(3, null, "a1", "dropped"); //  id 4  My App #1
  item.run(2, null, "m2", "planned"); //  id 5  my-app #2
  item.run(1, null, "l3", "planned"); //  id 6  ledger #3
  db.prepare(
    `INSERT INTO agents (project_id, roadmap_item_id, task_description, worktree_path,
       herdr_workspace, herdr_tab, herdr_pane, coding_agent, status)
     VALUES (1, 3, 't', '/w', 'w', 't', 'p', 'claude', 'working')`,
  ).run();
  db.prepare("INSERT INTO events (agent_id, event_type) VALUES (1, 'dispatched')").run();
  return db;
}

const dump = (db: Db, sql: string) => JSON.stringify(db.prepare(sql).all());
const CORE = {
  roadmap: "SELECT id, project_id, parent_id, title, description, status, priority, created_at, updated_at FROM roadmap ORDER BY id",
  agents: "SELECT * FROM agents ORDER BY id",
  events: "SELECT * FROM events ORDER BY id",
};
const snapshot = (db: Db) => Object.fromEntries(Object.entries(CORE).map(([k, q]) => [k, dump(db, q)]));

test("upgrade: backfills provisional codes + per-project keys in id order, relationships untouched", () => {
  const db = v5Store();
  const before = snapshot(db);

  applyMigrations(db);

  assert.deepEqual(snapshot(db), before, "ids, parents, agents, events byte-identical");
  const keys = db.prepare("SELECT id, key, item_number FROM roadmap ORDER BY id").all();
  assert.deepEqual(
    keys.map((r) => r["key"]),
    ["LEDGER-1", "MYAPP-1", "LEDGER-2", "MYAPP2-1", "MYAPP-2", "LEDGER-3"],
  );
  const projects = db.prepare("SELECT name, code, code_confirmed AS c, roadmap_items_issued AS n FROM projects ORDER BY id").all();
  assert.deepEqual(
    projects.map((p) => [p["name"], p["code"], p["c"], p["n"]]),
    [["ledger", "LEDGER", 0, 3], ["my-app", "MYAPP", 0, 2], ["My App", "MYAPP2", 0, 1]],
    "collision resolved deterministically in project-id order; all provisional",
  );
  verifyRoadmapKeys(db);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("upgrade is idempotent", () => {
  const db = v5Store();
  applyMigrations(db);
  const once = dump(db, "SELECT key FROM roadmap ORDER BY id");
  applyMigrations(db);
  assert.equal(dump(db, "SELECT key FROM roadmap ORDER BY id"), once);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 6").get() as { n: number }).n, 1);
});

test("deriveBackfillCode: clamps, strips, pads short, suffixes collisions within 10 chars", () => {
  assert.equal(deriveBackfillCode("ledger-dashboard-v2", new Set()), "LEDGERDASH");
  assert.equal(deriveBackfillCode("x", new Set()), "XPR");
  assert.equal(deriveBackfillCode("---", new Set()), "PRJ");
  assert.equal(deriveBackfillCode("LEDGERDASH", new Set(["LEDGERDASH"])), "LEDGERDAS2");
  assert.equal(deriveBackfillCode("ab", new Set(["AB", "AB2"])), "AB3");
});

test("keys are assigned by trigger — even for an INSERT that knows nothing about keys (old binary)", () => {
  const db = v5Store();
  applyMigrations(db);
  db.prepare("INSERT INTO roadmap (project_id, title) VALUES (1, 'from an old binary')").run();
  assert.equal((db.prepare("SELECT key FROM roadmap WHERE title = 'from an old binary'").get() as { key: string }).key, "LEDGER-4");
});

test("counter is monotonic: deleting the newest item never frees its number", () => {
  const db = v5Store();
  applyMigrations(db);
  db.prepare("DELETE FROM roadmap WHERE key = 'LEDGER-3'").run();
  db.prepare("INSERT INTO roadmap (project_id, title) VALUES (1, 'next')").run();
  assert.equal((db.prepare("SELECT key FROM roadmap WHERE title = 'next'").get() as { key: string }).key, "LEDGER-4");
  assert.equal((db.prepare("SELECT roadmap_items_issued AS n FROM projects WHERE id = 1").get() as { n: number }).n, 4);
  assert.throws(() => db.prepare("UPDATE projects SET roadmap_items_issued = 1 WHERE id = 1").run(), /monotonic/);
});

test("provisional keys may be rewritten; once confirmed they are immutable", () => {
  const db = v5Store();
  applyMigrations(db);
  db.prepare("UPDATE roadmap SET key = 'LDG-1' WHERE key = 'LEDGER-1'").run(); // provisional: allowed
  assert.throws(() => db.prepare("UPDATE roadmap SET item_number = 9 WHERE key = 'LDG-1'").run(), /immutable/);
  db.prepare("UPDATE projects SET code_confirmed = 1 WHERE id = 1").run();
  assert.throws(() => db.prepare("UPDATE roadmap SET key = 'ZZ-1' WHERE key = 'LDG-1'").run(), /immutable/);
  assert.throws(() => db.prepare("UPDATE roadmap SET project_id = 2 WHERE key = 'LDG-1'").run(), /immutable/);
});

test("a failed backfill verification rolls the whole migration back", () => {
  const db = v5Store();
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare(
    `INSERT INTO agents (project_id, roadmap_item_id, task_description, worktree_path,
       herdr_workspace, herdr_tab, herdr_pane, coding_agent) VALUES (1, 999, 't', '/w', 'w', 't', 'p2', 'claude')`,
  ).run(); // dangling reference the migration must not paper over
  assert.throws(() => applyMigrations(db), /dangling item reference/);
  const cols = db.prepare("PRAGMA table_info(roadmap)").all().map((c) => c["name"]);
  assert.ok(!cols.includes("key"), "DDL rolled back too");
  assert.equal((db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v, 5);
});

test("rollback to v5 restores the old shape with all data and relationships intact; re-upgrade works", () => {
  const db = v5Store();
  const before = snapshot(db);
  applyMigrations(db);
  db.prepare("INSERT INTO roadmap (project_id, title) VALUES (1, 'post-migration item')").run();

  assert.deepEqual(rollbackTo(db, 5), [6]);

  const cols = db.prepare("PRAGMA table_info(roadmap)").all().map((c) => c["name"]);
  assert.ok(!cols.includes("key") && !cols.includes("item_number"));
  const pcols = db.prepare("PRAGMA table_info(projects)").all().map((c) => c["name"]);
  assert.ok(!pcols.includes("code") && !pcols.includes("code_confirmed") && !pcols.includes("roadmap_items_issued"));
  const after = snapshot(db);
  assert.equal(after["agents"], before["agents"]);
  assert.equal(after["events"], before["events"]);
  assert.equal(JSON.parse(after["roadmap"] as string).length, 7, "new item survives rollback");
  assert.equal((db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v, 5);

  applyMigrations(db); // forward again
  verifyRoadmapKeys(db);
});

test("rollback refuses a migration without a down, before changing anything", () => {
  const db = v5Store();
  applyMigrations(db);
  assert.throws(() => rollbackTo(db, 3), /has no rollback/);
  assert.equal((db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v, 6);
});

test("pre-migration backup is a verified copy of the store", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-bak-"));
  const src = new DatabaseSync(join(dir, "src.db"));
  applyMigrations(src, { target: 5 });
  src.exec("INSERT INTO projects (name, repo_url, local_clone_path, default_branch) VALUES ('p','u','/p','main')");
  const dest = backupStore(src, join(dir, "backups"), 5, 6);
  assert.deepEqual(readdirSync(join(dir, "backups")), [dest.split("/").pop()]);
  const copy = new DatabaseSync(dest, { readOnly: true });
  assert.equal((copy.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n, 1);
  copy.close();
});

test("applyMigrations with backupDir snapshots an existing store, not a fresh one", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-bak-"));
  const fresh = new DatabaseSync(":memory:");
  applyMigrations(fresh, { backupDir: join(dir, "fresh") });
  assert.throws(() => readdirSync(join(dir, "fresh")), "no backup for a brand-new store");

  const old = new DatabaseSync(join(dir, "old.db"));
  applyMigrations(old, { target: 5 });
  applyMigrations(old, { backupDir: join(dir, "old-backups") });
  assert.equal(readdirSync(join(dir, "old-backups")).length, 1);
});
