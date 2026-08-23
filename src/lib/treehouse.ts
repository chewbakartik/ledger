import { execFileSync } from "node:child_process";

/**
 * Durably leases a worktree from the pool rooted at `repoCwd` (treehouse
 * discovers the repo from cwd) and returns its absolute path. Never opens a
 * subshell (`--lease`), never removed by prune until explicitly returned.
 */
export function leaseWorktree(opts: {
  repoCwd: string;
  leaseHolder: string;
}): string {
  const stdout = execFileSync(
    "treehouse",
    ["get", "--lease", "--lease-holder", opts.leaseHolder],
    { cwd: opts.repoCwd, encoding: "utf8" },
  );
  const path = stdout.trim();
  if (!path) {
    throw new Error("treehouse get --lease returned no path");
  }
  return path;
}

/**
 * Returns a leased worktree to the pool. Uses --force (clean, reset,
 * return without prompting) since ledger's own CLI is non-interactive.
 */
export function returnWorktree(path: string): void {
  execFileSync("treehouse", ["return", path, "--force"], {
    encoding: "utf8",
  });
}
