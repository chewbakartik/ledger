import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code's global state file; `projects[<abs path>].hasTrustDialogAccepted` is where "yes, I trust this folder" persists. */
export function claudeConfigPath(): string {
  return process.env.CLAUDE_CONFIG_PATH ?? join(homedir(), ".claude.json");
}

/**
 * Pre-accepts Claude Code's one-time "do you trust this folder?" dialog for
 * `worktreePath` by setting `projects[worktreePath].hasTrustDialogAccepted`
 * in ~/.claude.json. Claude Code has no official CLI flag, env var, or
 * setting for this (`--dangerously-skip-permissions` and
 * `--permission-mode bypassPermissions` both still show the dialog), so
 * this edits its state file directly — but conservatively:
 *   - every other key (top-level and in the project's own entry) is kept;
 *   - a missing file is created; a malformed one is NOT overwritten (that
 *     would destroy the user's global Claude state) — it throws instead;
 *   - the write is atomic (temp file + rename) and keeps the original mode
 *     (new files are 0600, since the file holds account state).
 */
export function trustClaudeWorktree(worktreePath: string, configPath = claudeConfigPath()): void {
  let config: Record<string, unknown> = {};
  let mode = 0o600;
  let raw: string | undefined;
  try {
    raw = readFileSync(configPath, "utf8");
    mode = statSync(configPath).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  if (raw !== undefined && raw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `${configPath} is not valid JSON — refusing to overwrite Claude Code's global state ` +
          `to pre-trust ${worktreePath}; fix or remove the file and retry`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${configPath} is not a JSON object — refusing to overwrite it`);
    }
    config = parsed as Record<string, unknown>;
  }

  const projects =
    typeof config.projects === "object" && config.projects !== null && !Array.isArray(config.projects)
      ? (config.projects as Record<string, unknown>)
      : {};
  const existing = projects[worktreePath];
  const entry =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  if (entry.hasTrustDialogAccepted === true) return;

  projects[worktreePath] = { ...entry, hasTrustDialogAccepted: true };
  config.projects = projects;

  const tmp = `${configPath}.ledger-${process.pid}.tmp`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, JSON.stringify(config, null, 2) + "\n");
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    unlinkSync(tmp);
    throw err;
  }
  closeSync(fd);
  chmodSync(tmp, mode); // openSync's mode is subject to umask
  renameSync(tmp, configPath);
}
