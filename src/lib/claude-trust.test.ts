import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { trustClaudeWorktree } from "./claude-trust.js";

function setup(content?: string, mode = 0o640) {
  const dir = mkdtempSync(join(tmpdir(), "claude-trust-"));
  const file = join(dir, ".claude.json");
  if (content !== undefined) {
    writeFileSync(file, content);
    chmodSync(file, mode);
  }
  return { dir, file };
}

test("adds trust, preserves other keys and file mode, leaves no temp files", () => {
  const { dir, file } = setup(
    JSON.stringify({ theme: "dark", projects: { "/a": { allowedTools: ["x"] } } }),
  );
  trustClaudeWorktree("/wt", file);
  const out = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(out.theme, "dark");
  assert.deepEqual(out.projects["/a"], { allowedTools: ["x"] });
  assert.deepEqual(out.projects["/wt"], { hasTrustDialogAccepted: true });
  assert.equal(statSync(file).mode & 0o777, 0o640);
  assert.deepEqual(readdirSync(dir), [".claude.json"]);
});

test("keeps existing project entry fields", () => {
  const { file } = setup(
    JSON.stringify({ projects: { "/wt": { hasTrustDialogAccepted: false, foo: 1 } } }),
  );
  trustClaudeWorktree("/wt", file);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).projects["/wt"], {
    hasTrustDialogAccepted: true,
    foo: 1,
  });
});

test("creates a missing file with mode 0600", () => {
  const { file } = setup();
  trustClaudeWorktree("/wt", file);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).projects["/wt"].hasTrustDialogAccepted, true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("refuses to clobber a malformed file", () => {
  const { file } = setup("{not json");
  assert.throws(() => trustClaudeWorktree("/wt", file), /not valid JSON/);
  assert.equal(readFileSync(file, "utf8"), "{not json");
});

test("refuses a non-object JSON file", () => {
  const { file } = setup("[1]");
  assert.throws(() => trustClaudeWorktree("/wt", file), /not a JSON object/);
  assert.equal(readFileSync(file, "utf8"), "[1]");
});

test("already-trusted path is a no-op", () => {
  const raw = '{"projects":{"/wt":{"hasTrustDialogAccepted":true}}}';
  const { file } = setup(raw);
  trustClaudeWorktree("/wt", file);
  assert.equal(readFileSync(file, "utf8"), raw);
});
