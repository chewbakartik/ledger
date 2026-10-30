import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { DatabaseSync as Db } from "node:sqlite";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "index.js");
const WATCHER = join(here, "..", "plugin", "watcher.js");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof Db;
};

// Throwaway ledger home + a stub `herdr` on PATH: the real ~/.ledger and
// the real herdr/clerk pane are never touched.
const root = mkdtempSync(join(tmpdir(), "ledger-watch-"));
const home = join(root, "home");
const stub = join(root, "stub");
const bin = join(root, "bin");
mkdirSync(stub);
mkdirSync(bin);
writeFileSync(
  join(bin, "herdr"),
  `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const dir = process.env.STUB;
const a = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), a.join(" ") + "\\n");
const fail = (code) => { console.log(JSON.stringify({ id: "x", error: { code, message: code } })); process.exit(1); };
if (a[0] === "pane" && a[1] === "get") {
  const f = path.join(dir, "pane-" + a[2] + ".json");
  if (!fs.existsSync(f)) fail("pane_not_found");
  console.log(JSON.stringify({ id: "x", result: { type: "pane_info", pane: JSON.parse(fs.readFileSync(f, "utf8")) } }));
} else if (a[0] === "agent" && a[1] === "prompt") {
  if (fs.existsSync(path.join(dir, "busy"))) fail("agent_pane_busy");
  console.log(JSON.stringify({ id: "x", result: {} }));
} else if (a[0] === "workspace") {
  fail("workspace_not_found");
}
`,
);
chmodSync(join(bin, "herdr"), 0o755);

const ENV = {
  ...process.env,
  LEDGER_HOME: home,
  STUB: stub,
  PATH: `${bin}:${process.env["PATH"]}`,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const CLERK = "w9:p1";

function run(args: string[]) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", env: ENV });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function ok(args: string[]) {
  const r = run(args);
  assert.equal(r.code, 0, `ledger ${args.join(" ")} failed: ${r.err}`);
  return r;
}
const json = (args: string[]) => JSON.parse(ok(args).out);

/** Fires the watcher hook once, as herdr would. */
function event(paneId: string, status: string) {
  const payload = {
    event: "pane_agent_status_changed",
    data: { type: "pane_agent_status_changed", pane_id: paneId, workspace_id: "w1", agent: "claude", agent_status: status },
  };
  const r = spawnSync("node", [WATCHER], {
    encoding: "utf8",
    env: { ...ENV, HERDR_PLUGIN_EVENT_JSON: JSON.stringify(payload) },
  });
  assert.equal(r.status, 0, r.stderr);
}
function setClerkPane(pane: { agent: string | null; agent_status: string } | null) {
  const f = join(stub, `pane-${CLERK}.json`);
  if (pane === null) writeFileSync(f, "", { flag: "w" }), rmSync(f);
  else writeFileSync(f, JSON.stringify({ pane_id: CLERK, ...pane }));
}
function setBusy(on: boolean) {
  const f = join(stub, "busy");
  if (on) writeFileSync(f, "");
  else rmSync(f, { force: true });
}
const calls = () => {
  try {
    return readFileSync(join(stub, "calls.log"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const prompts = () => calls().filter((c) => c.startsWith("agent prompt"));
const clearCalls = () => rmSync(join(stub, "calls.log"), { force: true });
const sql = <T>(q: string) => {
  const db = new DatabaseSync(join(home, "ledger.db"));
  try {
    return db.prepare(q).all() as unknown as T[];
  } finally {
    db.close();
  }
};
const exec = (q: string) => {
  const db = new DatabaseSync(join(home, "ledger.db"));
  db.exec(q);
  db.close();
};

// ---- fixtures ---------------------------------------------------------
test("setup: project, keyed roadmap items, two agents, claimed clerk (+ one-time note)", () => {
  ok(["project", "init", "--name", "alpha", "--code", "ALP"]);
  ok(["roadmap", "add", "--project", "alpha", "--title", "one"]); // ALP-1
  ok(["roadmap", "add", "--project", "alpha", "--title", "two"]); // ALP-2
  exec(`
    INSERT INTO agents (project_id, roadmap_item_id, task_description, worktree_path,
      herdr_workspace, herdr_tab, herdr_pane, coding_agent, authorization_basis)
      VALUES (1, 1, 't1', '/w', 'w1', 'w1:t1', 'w1:p9', 'claude', 'user-explicit'),
             (1, 2, 't2', '/w', 'w1', 'w1:t2', 'w1:p8', 'claude', 'user-explicit');
  `);

  const first = ok(["clerk", "claim", "--session-id", "s", "--herdr-pane", CLERK]);
  assert.match(first.out, /ask the clerk at any time to add follow-through monitoring/);
  const second = ok(["clerk", "claim", "--session-id", "s", "--herdr-pane", CLERK, "--force"]);
  assert.ok(!/follow-through monitoring/.test(second.out), "note is one-time");
});

// ---- lifecycle --------------------------------------------------------
test("watch add validates input and stores a stable internal item reference, showing the key", () => {
  assert.match(run(["watch", "add", "--next", "x"]).err, /--agent and\/or --roadmap-item/);
  assert.match(run(["watch", "add", "--agent", "1", "--next", "x", "--on", "nope"]).err, /--on must be/);
  assert.match(run(["watch", "add", "--roadmap-item", "ALP-99", "--next", "x"]).err, /no roadmap item ALP-99/);

  const w = json(["watch", "add", "--agent", "1", "--roadmap-item", "alp-1", "--next", "A", "--next", "B", "--pre-authorized"]);
  assert.equal(w.id, 1);
  assert.equal(w.roadmap_item, "ALP-1");
  assert.ok(!("roadmap_item_id" in w), "internal numeric id withheld");
  assert.deepEqual(w.steps_list, ["A", "B"]);
  assert.equal(w.next_step, "A");
  assert.equal(w.authorization_basis, "pre-authorized");
  assert.equal(sql<{ roadmap_item_id: number }>("SELECT roadmap_item_id FROM watches WHERE id = 1")[0]?.roadmap_item_id, 1);

  const d = (json(["watch", "add", "--agent", "2", "--next", "z"]));
  assert.equal(d.authorization_basis, null);
  assert.equal(d.on_states, "done,blocked,failed");
  const hours = (Date.parse(d.expires_at + "Z") - Date.parse(d.created_at + "Z")) / 3_600_000;
  assert.ok(Math.abs(hours - 24) < 0.01, `default expiry 24h, got ${hours}`);
  ok(["watch", "cancel", "2"]);
});

test("advance/rearm/fire/cancel lifecycle and guards", () => {
  assert.match(run(["watch", "advance", "1"]).err, /give --agent and\/or --roadmap-item/);
  const adv = json(["watch", "advance", "1", "--agent", "2", "--roadmap-item", "ALP-2"]);
  assert.equal(adv.step_index, 1);
  assert.equal(adv.next_step, "B");
  assert.equal(adv.agent_id, 2);
  assert.equal(adv.roadmap_item, "ALP-2");
  assert.match(run(["watch", "advance", "1", "--agent", "2"]).err, /last step.*watch fire 1/);

  assert.equal(json(["watch", "rearm", "1"]).step_index, 1);
  assert.equal(json(["watch", "fire", "1"]).status, "fired");
  assert.match(run(["watch", "fire", "1"]).err, /is fired, not open/);
  assert.match(run(["watch", "cancel", "2"]).err, /is cancelled, not open/);

  const open = json(["watch", "list", "--json"]);
  assert.deepEqual(open, []);
  assert.deepEqual(json(["watch", "list", "--all", "--json"]).map((w: { status: string }) => w.status), ["fired", "cancelled"]);
});

test("expiry: expired watches stop waking and are reported once by catchup", () => {
  exec("DELETE FROM watches");
  ok(["watch", "add", "--agent", "1", "--next", "never", "--expires-in", "1"]);
  exec("UPDATE watches SET expires_at = datetime('now','-1 minute')");
  setClerkPane({ agent: "claude", agent_status: "idle" });
  clearCalls();
  ok(["agent", "update", "1", "--status", "done", "--outcome", "https://x/pr/1"]);
  event("w1:p9", "idle");
  assert.equal(prompts().length, 0, "expired watch must not wake");
  assert.equal(json(["watch", "list", "--status", "expired", "--json"]).length, 1);

  const text = ok(["catchup", "--idle-pane-lines", "0"]).out;
  assert.match(text, /Watches expired since last catchup \(1\)/);
  assert.match(ok(["catchup", "--idle-pane-lines", "0"]).out, /Watches expired since last catchup \(0\)/);
  ok(["agent", "update", "1", "--status", "working"]);
});

// ---- failed-outcome label --------------------------------------------
test("failed-outcome heuristic: failure prose is 'failed', bare URLs and ordinary outcomes are not", async () => {
  const { outcomeLooksFailed, wakeStateOf } = await import("../lib/watches.js");
  assert.equal(outcomeLooksFailed("FAILED: tests did not pass"), true);
  assert.equal(outcomeLooksFailed("partial: item 2 remains"), true);
  assert.equal(outcomeLooksFailed("https://github.com/o/r/pull/fix-failed-test"), false);
  assert.equal(outcomeLooksFailed("https://github.com/o/r/pull/3"), false);
  assert.equal(outcomeLooksFailed(null), false);
  const agent = (status: string, outcome: string | null) => ({ status, outcome }) as never;
  assert.equal(wakeStateOf(agent("working", null)), null);
  assert.equal(wakeStateOf(agent("idle", null)), null);
  assert.equal(wakeStateOf(agent("blocked", "need a decision")), "blocked");
  assert.equal(wakeStateOf(agent("done", "https://x/pr/1")), "done");
  assert.equal(wakeStateOf(agent("done", "FAILED")), "failed");
});

// ---- wake delivery ----------------------------------------------------
function freshWatch(...args: string[]): number {
  exec("DELETE FROM watches");
  exec("UPDATE agents SET status = 'working', outcome = NULL");
  clearCalls();
  setBusy(false);
  return json(["watch", "add", ...args]).id;
}
const watchRow = (id: number) => sql<Record<string, unknown>>(`SELECT * FROM watches WHERE id = ${id}`)[0] as Record<string, unknown>;

test("idle Claude clerk gets exactly one prompt (agent, state, outcome, item key, step); repeat events don't re-wake", () => {
  const id = freshWatch("--agent", "1", "--roadmap-item", "ALP-1", "--next", "dispatch the reviewer");
  setClerkPane({ agent: "claude", agent_status: "idle" });
  ok(["agent", "update", "1", "--status", "done", "--outcome", "https://x/pr/7"]);

  event("w1:p9", "idle");
  assert.equal(prompts().length, 1);
  const msg = prompts()[0] as string;
  assert.ok(msg.startsWith(`agent prompt ${CLERK} [ledger wake] watch #${id} (ALP-1): agent #1 is done`), msg);
  assert.match(msg, /outcome: https:\/\/x\/pr\/7/);
  assert.match(msg, /Step 1\/1: dispatch the reviewer/);
  assert.match(msg, /ledger watch get/);
  assert.ok(!/do NOT proceed mechanically/.test(msg));
  const w = watchRow(id);
  assert.equal(w["pending_wake"], 0);
  assert.equal(w["wake_count"], 1);
  assert.ok(w["wake_sent_at"]);
  assert.equal(w["status"], "open", "stays open until the clerk fires/advances it");

  clearCalls();
  event("w1:p9", "done");
  event("w1:p9", "idle");
  assert.equal(prompts().length, 0, "no re-wake");
  assert.equal(sql<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE event_type = 'watch_wake'")[0]?.n, 1);
  assert.equal(sql<{ n: number }>("SELECT COUNT(*) AS n FROM watches")[0]?.n, 1, "watcher never creates watches");
  assert.equal(sql<{ n: number }>("SELECT COUNT(*) AS n FROM agents")[0]?.n, 2, "watcher never dispatches");
});

test("blocked and failed outcomes wake even when --on lists only done, and say not to proceed mechanically", () => {
  freshWatch("--agent", "1", "--next", "go", "--on", "done");
  setClerkPane({ agent: "claude", agent_status: "idle" });
  ok(["agent", "update", "1", "--status", "blocked", "--outcome", "tried x; decision needed"]);
  event("w1:p9", "blocked");
  assert.equal(prompts().length, 1);
  assert.match(prompts()[0] as string, /is blocked.*do NOT proceed mechanically/);

  freshWatch("--agent", "2", "--next", "go", "--on", "done");
  ok(["agent", "update", "2", "--status", "done", "--outcome", "FAILED: tests did not pass"]);
  event("w1:p8", "idle");
  assert.equal(prompts().length, 1);
  assert.match(prompts()[0] as string, /is failed.*do NOT proceed mechanically/);
});

test("a plain 'done' is ignored by a watch that doesn't list done; a working agent never wakes", () => {
  freshWatch("--agent", "1", "--next", "go", "--on", "blocked");
  setClerkPane({ agent: "claude", agent_status: "idle" });
  event("w1:p9", "working");
  assert.equal(prompts().length, 0);
  ok(["agent", "update", "1", "--status", "done", "--outcome", "https://x/pr/1"]);
  event("w1:p9", "idle");
  assert.equal(prompts().length, 0);
  assert.equal(watchRow(1)["pending_wake"], 0);
});

test("roadmap-item watch matches any agent dispatched for that item", () => {
  freshWatch("--roadmap-item", "ALP-2", "--next", "go");
  setClerkPane({ agent: "claude", agent_status: "idle" });
  ok(["agent", "update", "1", "--status", "done", "--outcome", "https://x/pr/1"]);
  event("w1:p9", "idle");
  assert.equal(prompts().length, 0, "agent 1 is on ALP-1, not ALP-2");
  ok(["agent", "update", "2", "--status", "done", "--outcome", "https://x/pr/2"]);
  event("w1:p8", "idle");
  assert.equal(prompts().length, 1);
  assert.match(prompts()[0] as string, /\(ALP-2\)/);
});

test("clerk busy mid-turn -> pending, nothing sent", () => {
  const id = freshWatch("--agent", "1", "--next", "go");
  setClerkPane({ agent: "claude", agent_status: "working" });
  ok(["agent", "update", "1", "--status", "done", "--outcome", "https://x/pr/1"]);
  event("w1:p9", "idle");
  assert.equal(prompts().length, 0);
  const w = watchRow(id);
  assert.equal(w["pending_wake"], 1);
  assert.equal(w["wake_reason"], "clerk_busy");
  assert.equal(w["wake_sent_at"], null);
});

test("bare-shell clerk pane -> pending, nothing sent into the shell", () => {
  const id = freshWatch("--agent", "1", "--next", "go");
  setClerkPane({ agent: null, agent_status: "unknown" });
  ok(["agent", "update", "1", "--status", "done", "--outcome", "https://x/pr/1"]);
  event("w1:p9", "idle");
  assert.equal(prompts().length, 0);
  assert.equal(calls().filter((c) => c.startsWith("pane send-keys")).length, 0);
  assert.equal(watchRow(id)["wake_reason"], "clerk_not_claude");
  assert.equal(watchRow(id)["pending_wake"], 1);
});

test("missing clerk pane, and no clerk claim at all -> pending, nothing sent", () => {
  const id = freshWatch("--agent", "1", "--next", "go");
  setClerkPane(null);
  ok(["agent", "update", "1", "--status", "done", "--outcome", "https://x/pr/1"]);
  event("w1:p9", "idle");
  assert.equal(prompts().length, 0);
  assert.equal(watchRow(id)["wake_reason"], "clerk_pane_gone");

  const id2 = freshWatch("--agent", "2", "--next", "go");
  exec("ALTER TABLE first_clerk RENAME TO first_clerk_bak; CREATE TABLE first_clerk AS SELECT * FROM first_clerk_bak WHERE 0");
  ok(["agent", "update", "2", "--status", "done", "--outcome", "https://x/pr/2"]);
  event("w1:p8", "idle");
  exec("DROP TABLE first_clerk; ALTER TABLE first_clerk_bak RENAME TO first_clerk");
  assert.equal(prompts().length, 0);
  assert.equal(watchRow(id2)["wake_reason"], "clerk_unclaimed");
});

test("transient agent_pane_busy: three tries, then pending", () => {
  const id = freshWatch("--agent", "1", "--next", "go");
  setClerkPane({ agent: "claude", agent_status: "idle" });
  setBusy(true);
  ok(["agent", "update", "1", "--status", "done", "--outcome", "https://x/pr/1"]);
  event("w1:p9", "idle");
  assert.equal(prompts().length, 3);
  assert.equal(watchRow(id)["pending_wake"], 1);
  assert.equal(watchRow(id)["wake_reason"], "clerk_busy");
  setBusy(false);
});

test("pending wake is flushed (once) when the clerk pane settles to idle; not if catchup already surfaced it", () => {
  const id = freshWatch("--agent", "1", "--next", "go");
  setClerkPane({ agent: "claude", agent_status: "working" });
  ok(["agent", "update", "1", "--status", "done", "--outcome", "https://x/pr/1"]);
  event("w1:p9", "idle");
  assert.equal(watchRow(id)["pending_wake"], 1);

  // a clerk event while it is still working changes nothing
  event(CLERK, "working");
  assert.equal(prompts().length, 0);

  setClerkPane({ agent: "claude", agent_status: "idle" });
  event(CLERK, "idle");
  assert.equal(prompts().length, 1);
  assert.match(prompts()[0] as string, /watch #\d+: agent #1 is done/);
  assert.equal(watchRow(id)["pending_wake"], 0);
  assert.ok(watchRow(id)["wake_sent_at"]);
  clearCalls();
  event(CLERK, "idle");
  assert.equal(prompts().length, 0, "flushed only once");

  // surfaced by catchup first -> not re-prompted on clerk idle
  const id2 = freshWatch("--agent", "2", "--next", "go");
  setClerkPane({ agent: "claude", agent_status: "working" });
  ok(["agent", "update", "2", "--status", "done", "--outcome", "https://x/pr/2"]);
  event("w1:p8", "idle");
  ok(["catchup", "--idle-pane-lines", "0"]);
  setClerkPane({ agent: "claude", agent_status: "idle" });
  event(CLERK, "idle");
  assert.equal(prompts().length, 0);
  assert.equal(watchRow(id2)["pending_wake"], 1, "still pending until the clerk acts");
});

test("a chain's wakes are bounded by its length: advance re-arms for the new agent only", () => {
  const id = freshWatch("--agent", "1", "--next", "A", "--next", "B");
  setClerkPane({ agent: "claude", agent_status: "idle" });
  ok(["agent", "update", "1", "--status", "done", "--outcome", "https://x/pr/1"]);
  event("w1:p9", "idle");
  assert.equal(prompts().length, 1);
  assert.match(prompts()[0] as string, /Step 1\/2: A/);

  ok(["watch", "advance", String(id), "--agent", "2"]);
  clearCalls();
  event("w1:p9", "idle"); // old agent no longer matches
  assert.equal(prompts().length, 0);
  ok(["agent", "update", "2", "--status", "done", "--outcome", "https://x/pr/2"]);
  event("w1:p8", "idle");
  assert.equal(prompts().length, 1);
  assert.match(prompts()[0] as string, /Step 2\/2: B/);
  assert.match(run(["watch", "advance", String(id), "--agent", "1"]).err, /last step/);
});

// ---- catchup ----------------------------------------------------------
test("catchup text and --json list open watches, pending wakes (with reason) and use item keys", () => {
  const openId = freshWatch("--agent", "2", "--roadmap-item", "ALP-2", "--next", "review the PR");
  const pendId = json(["watch", "add", "--agent", "1", "--roadmap-item", "ALP-1", "--next", "ship it"]).id;
  setClerkPane({ agent: "claude", agent_status: "working" });
  ok(["agent", "update", "1", "--status", "done", "--outcome", "https://x/pr/1"]);
  event("w1:p9", "idle");

  const text = ok(["catchup", "--idle-pane-lines", "0"]).out;
  assert.match(text, /Watches open \(1\):\n {2}watch #\d+ on agent#2\+ALP-2 step 1\/1: review the PR/);
  assert.match(text, /Pending wakes \(1\)/);
  assert.match(text, /agent#1\+ALP-1/);
  assert.match(text, /agent #1 is done \(outcome: https:\/\/x\/pr\/1\); undelivered because clerk_busy/);
  assert.ok(!/item#/.test(text));

  const j = JSON.parse(ok(["catchup", "--idle-pane-lines", "0", "--json"]).out);
  assert.deepEqual(j.watches.open.map((w: { id: number }) => w.id), [openId]);
  assert.deepEqual(j.watches.pending_wakes.map((w: { id: number }) => w.id), [pendId]);
  assert.deepEqual(j.watches.expired_since_last_catchup, []);
  const p = j.watches.pending_wakes[0];
  assert.equal(p.roadmap_item, "ALP-1");
  assert.equal(p.wake_reason, "clerk_busy");
  assert.equal(p.next_step, "ship it");
  assert.ok(!("roadmap_item_id" in p));

  const scoped = JSON.parse(ok(["catchup", "--idle-pane-lines", "0", "--json", "--project", "alpha"]).out);
  assert.equal(scoped.watches.open.length, 1);
});
