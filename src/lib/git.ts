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

/** True if `cwd`'s git repo already has a remote named `name`. */
export function hasRemote(cwd: string, name: string): boolean {
  return getRemoteUrl(cwd, name) !== null;
}

/** The URL of `cwd`'s git remote `name`, or null if it doesn't exist. */
export function getRemoteUrl(cwd: string, name: string): string | null {
  try {
    // "No such remote" is an expected, routine outcome here (not an
    // error to surface) — suppress git's own stderr for it specifically.
    return execFileSync("git", ["remote", "get-url", name], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Adds a remote to `cwd`'s git repo. Caller should check `hasRemote` first. */
export function addRemote(cwd: string, name: string, url: string): void {
  execFileSync("git", ["remote", "add", name, url], { cwd, encoding: "utf8" });
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
