import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// getDb() is a process-wide singleton keyed off LEDGER_HOME at first use.
process.env["LEDGER_HOME"] = mkdtempSync(join(tmpdir(), "ledger-upgrade-"));
const { getDb } = await import("../db/client.js");
const { applyMigrations } = await import("../db/client.js");
const { walkProvisionalCodes } = await import("../cli/commands/projects.js");
const { provisionalCodesNotice, setProjectCode, resolveRoadmapRef } = await import("./roadmap-keys.js");
const { DatabaseSync } = (await import("node:module")).createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof import("node:sqlite").DatabaseSync;
};

// Build a pre-0006 store at LEDGER_HOME, then let getDb() upgrade it — the
// real upgrade path (backup -> migrate -> verify) end to end.
const path = join(process.env["LEDGER_HOME"] as string, "ledger.db");
{
  const old = new DatabaseSync(path);
  applyMigrations(old, { target: 5 });
  for (const n of ["ledger", "my-app", "My App"]) {
    old.prepare("INSERT INTO projects (name, repo_url, local_clone_path, default_branch) VALUES (?, 'u', '/p', 'main')").run(n);
  }
  for (const [p, t] of [[1, "a"], [2, "b"], [1, "c"], [3, "d"]] as const) {
    old.prepare("INSERT INTO roadmap (project_id, title) VALUES (?, ?)").run(p, t);
  }
  old.close();
}
const db = getDb();

test("opening an old store upgrades it, leaves a verified backup, marks every project provisional", () => {
  const codes = db.prepare("SELECT code, code_confirmed AS c FROM projects ORDER BY id").all();
  assert.deepEqual(codes.map((r) => [r["code"], r["c"]]), [["LEDGER", 0], ["MYAPP", 0], ["MYAPP2", 0]]);
  assert.equal(readdirSync(join(process.env["LEDGER_HOME"] as string, "backups")).length, 1);
});
test("catchup/update notice counts provisional projects and names the command", () => {
  const n = provisionalCodesNotice(db) ?? "";
  assert.match(n, /3 projects have provisional/);
  assert.match(n, /ledger project codes/);
  assert.match(n, /project update <name> --code/);
});

test("while provisional, a new code REWRITES the project's keys and confirms it", () => {
  const project = db.prepare("SELECT * FROM projects WHERE name = 'ledger'").get() as never;
  const change = setProjectCode(project, "ldg", db);
  assert.deepEqual([change.from, change.to, change.keys_rewritten], ["LEDGER", "LDG", 2]);
  assert.deepEqual(db.prepare("SELECT key FROM roadmap WHERE project_id = 1 ORDER BY id").all().map((r) => r["key"]), ["LDG-1", "LDG-2"]);
  assert.equal(resolveRoadmapRef("LDG-2", db).title, "c");
  assert.throws(() => resolveRoadmapRef("LEDGER-1", db), /no roadmap item/, "old provisional key is gone");
  // now frozen
  const again = db.prepare("SELECT * FROM projects WHERE name = 'ledger'").get() as never;
  assert.throws(() => setProjectCode(again, "OTHER", db), /confirmed and frozen/);
  // next issued key continues the counter under the confirmed code
  db.prepare("INSERT INTO roadmap (project_id, title) VALUES (1, 'new')").run();
  assert.equal(db.prepare("SELECT key FROM roadmap WHERE title = 'new'").get()?.["key"], "LDG-3");
});

test("a rewrite can't collide: taken codes are refused and nothing changes", () => {
  const project = db.prepare("SELECT * FROM projects WHERE name = 'my-app'").get() as never;
  assert.throws(() => setProjectCode(project, "LDG", db), /already used by project "ledger"/);
  assert.throws(() => setProjectCode(project, "MYAPP2", db), /already used by project "My App"/);
  assert.equal(db.prepare("SELECT key FROM roadmap WHERE project_id = 2").get()?.["key"], "MYAPP-1");
});

test("project codes walk: Enter accepts the suggestion, typed codes are validated, retried, and confirmed", async () => {
  const answers = ["", "bad code!", "MYAPP", "NEW2"]; // my-app: accept; My App: invalid, taken, then valid
  const printed: string[] = [];
  const done = await walkProvisionalCodes(async () => answers.shift() ?? "", (l) => printed.push(l));
  assert.deepEqual(done.map((d) => [d.project, d.from, d.to]), [["my-app", "MYAPP", "MYAPP"], ["My App", "MYAPP2", "NEW2"]]);
  assert.equal(printed.filter((l) => /try again/.test(l)).length, 2);
  assert.equal(db.prepare("SELECT key FROM roadmap WHERE project_id = 3").get()?.["key"], "NEW2-1");
  assert.equal(provisionalCodesNotice(db), null, "notice disappears once all are confirmed");
  assert.deepEqual(await walkProvisionalCodes(async () => "", () => {}), []);
});
