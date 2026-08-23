import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

function resolveDefaultBranch(cwd: string): string {
  return execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim();
}

/**
 * Clones `source` (a remote URL or a local filesystem path) into
 * `destPath`. A local path clones via git's own local-clone fast path
 * (hardlinks where possible) and picks up every local commit/branch,
 * including unpushed ones — the dirty working tree itself is the one
 * thing that can never be captured, by design (see DESIGN.md).
 */
export function cloneProject(source: string, destPath: string): { defaultBranch: string } {
  if (existsSync(destPath)) {
    throw new Error(`clone destination already exists: ${destPath}`);
  }
  execFileSync("git", ["clone", source, destPath], { encoding: "utf8" });
  return { defaultBranch: resolveDefaultBranch(destPath) };
}

/**
 * Creates a brand-new project from scratch at `destPath` — for work that
 * doesn't exist anywhere yet (no repo to clone, local or remote). An empty
 * initial commit gives treehouse a real ref to lease worktrees from;
 * deliberately no scaffolding beyond that — what the project actually
 * becomes is a dispatched agent's job, not ledger's.
 */
export function initProject(destPath: string): { defaultBranch: string } {
  if (existsSync(destPath)) {
    throw new Error(`init destination already exists: ${destPath}`);
  }
  mkdirSync(destPath, { recursive: true });
  execFileSync("git", ["init", "--quiet", destPath], { encoding: "utf8" });
  execFileSync(
    "git",
    ["commit", "--allow-empty", "-m", "Initial commit (ledger project init)"],
    { cwd: destPath, encoding: "utf8" },
  );
  return { defaultBranch: resolveDefaultBranch(destPath) };
}
