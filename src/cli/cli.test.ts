import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "index.js");
const home = mkdtempSync(join(tmpdir(), "ledger-cli-"));
const ENV = {
  ...process.env,
  LEDGER_HOME: home,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", env: { ...ENV, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function ok(args: string[], env?: Record<string, string | undefined>) {
  const r = run(args, env);
  assert.equal(r.code, 0, `ledger ${args.join(" ")} failed: ${r.err}`);
  return r;
}
const json = (args: string[]) => JSON.parse(ok(args).out);

test("new project: explicit code required, counter starts at 0 issued, keys <CODE>-<n>", () => {
  const noCode = run(["project", "init", "--name", "alpha"]);
  assert.notEqual(noCode.code, 0);
  assert.match(noCode.err, /--code/);

  assert.match(run(["project", "init", "--name", "alpha", "--code", "a"]).err, /2-10 characters/);
  assert.match(run(["project", "init", "--name", "alpha", "--code", "al-pha"]).err, /A-Z and 0-9/);

  const p = json(["project", "init", "--name", "alpha", "--code", "alp"]);
  assert.equal(p.code, "ALP");
  assert.equal(p.code_confirmed, 1);
  assert.equal(p.roadmap_items_issued, 0);

  const dup = run(["project", "init", "--name", "beta", "--code", "ALP"]);
  assert.match(dup.err, /already used by project "alpha"/);

  const first = json(["roadmap", "add", "--project", "alpha", "--title", "one"]);
  const child = json(["roadmap", "add", "--project", "alpha", "--title", "two", "--parent", "alp-1"]);
  assert.equal(first.key, "ALP-1");
  assert.equal(child.key, "ALP-2");
  assert.equal(child.parent_key, "ALP-1");
  assert.equal(json(["project", "get", "alpha"]).roadmap_items_issued, 2);
  assert.equal(json(["project", "list", "--json"]).length, 1);
});

test("roadmap output never surfaces the internal numeric id", () => {
  const list = ok(["roadmap", "list", "--project", "alpha", "--json"]).out;
  assert.ok(!/"id"|"parent_id"|"item_number"/.test(list), list);
  const table = ok(["roadmap", "list", "--project", "alpha"]).out;
  assert.match(table, /^key\s/);
  const upd = ok(["roadmap", "update", "ALP-1", "--status", "in_progress"]);
  assert.equal(JSON.parse(upd.out).key, "ALP-1");
  assert.ok(!/"id"/.test(upd.out));
});

test("catchup (text + json) shows keys, never roadmap numeric ids", () => {
  const text = ok(["catchup", "--idle-pane-lines", "0"]).out;
  assert.match(text, /ALP-1 \[alpha\] \[in_progress\] one/);
  assert.match(text, / {4}ALP-2 /);
  assert.ok(!/#\d/.test(text.split("Roadmap in flight")[1] ?? ""));
  const j = JSON.parse(ok(["catchup", "--idle-pane-lines", "0", "--json"]).out);
  assert.deepEqual(j.roadmap.map((r: { key: string }) => r.key), ["ALP-1", "ALP-2"]);
  assert.ok(j.roadmap.every((r: object) => !("id" in r)));
  assert.deepEqual(j.provisional_project_codes, []);
});

test("numeric ids still work as a DEPRECATED alias: stderr notice naming the key, stdout clean; strict mode refuses", () => {
  const r = ok(["roadmap", "update", "1", "--priority", "high"]);
  assert.match(r.err, /Deprecated.*use the item key ALP-1/);
  assert.equal(JSON.parse(r.out).key, "ALP-1");
  const strict = run(["roadmap", "update", "1", "--priority", "low"], { LEDGER_STRICT_ITEM_KEYS: "1" });
  assert.notEqual(strict.code, 0);
  assert.match(strict.err, /no longer accepted.*ALP-1/);
  // keys never trigger the notice
  assert.equal(ok(["roadmap", "update", "ALP-1", "--priority", "normal"]).err, "");
  assert.match(run(["roadmap", "update", "NOPE-9"]).err, /no roadmap item NOPE-9/);
  assert.match(run(["roadmap", "update", "garbage"]).err, /not a roadmap item key/);
});

test("confirmed codes are frozen; keys stay immutable", () => {
  const r = run(["project", "update", "alpha", "--code", "XYZ"]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /confirmed and frozen/);
  assert.equal(json(["roadmap", "list", "--project", "alpha", "--json"])[0].key, "ALP-1");
  // same code is a harmless no-op
  assert.equal(ok(["project", "update", "alpha", "--code", "alp"]).err, "");
});

test("project codes: refuses without a TTY and points at the non-interactive command", () => {
  const r = run(["project", "codes"]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /needs a TTY.*project update <name> --code X/s);
});

test("db verify / status / rollback guard", () => {
  const v = json(["db", "verify"]);
  assert.equal(v.ok, true);
  assert.equal(v.roadmap_items, 2);
  assert.deepEqual(json(["db", "status"]).reversible, [6, 7]);
  assert.match(run(["db", "rollback", "--to", "5"]).err, /pass --yes/);
});

test("dispatch prompt names the roadmap item by key (and omits the line when there is none)", async () => {
  const { buildTaskPrompt, buildFollowupPrompt } = await import("./commands/agents.js");
  const project = { delivery_mode: "direct-pr", default_branch: "main" } as never;
  const withKey = buildTaskPrompt(7, "do it", project, "ALP-1");
  assert.match(withKey, /Roadmap item: ALP-1 — refer to it by this key/);
  assert.match(withKey, /ledger agent update 7 --status done/);
  assert.ok(!/Roadmap item:/.test(buildTaskPrompt(7, "do it", project)));
  assert.match(buildFollowupPrompt(7, "more", project, "ALP-1"), /Roadmap item: ALP-1/);
});
