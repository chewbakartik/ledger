import { execFileSync } from "node:child_process";
import type { AgentStatus as HerdrAgentStatus, CodingAgentKind } from "../db/types.js";

export class HerdrError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HerdrError";
  }
}

interface HerdrEnvelope<T> {
  id: string;
  result?: T;
  error?: { code: string; message: string };
}

/** Throws HerdrError (or a generic Error) from a failed herdr invocation. */
function throwHerdrFailure(args: string[], err: unknown): never {
  const e = err as { stdout?: string; stderr?: string; message: string };
  // herdr's JSON error envelope can land on stdout or stderr depending on
  // the command — confirmed live: `workspace get` on a missing id writes
  // it to stderr, unlike every other failure observed so far (stdout).
  // Check both rather than assuming one.
  for (const text of [e.stdout, e.stderr]) {
    if (!text) continue;
    const parsed = tryParseEnvelope<unknown>(text);
    if (parsed?.error) {
      throw new HerdrError(parsed.error.code, parsed.error.message);
    }
  }
  throw new Error(`herdr ${args.join(" ")} failed: ${(e.stderr ?? e.message).trim()}`);
}

function runHerdr<T>(args: string[], opts?: { quiet?: boolean }): T {
  let stdout: string;
  try {
    stdout = execFileSync("herdr", args, {
      encoding: "utf8",
      // Explicit "pipe" (not the default) captures stderr for
      // throwHerdrFailure to parse WITHOUT echoing it to the terminal —
      // "ignore" would lose it entirely, breaking error-code detection
      // for errors that land on stderr (see DECISIONS.md).
      ...(opts?.quiet ? { stdio: ["ignore", "pipe", "pipe"] } : {}),
    });
  } catch (err) {
    throwHerdrFailure(args, err);
  }

  const parsed = tryParseEnvelope<T>(stdout);
  if (!parsed) {
    throw new Error(`herdr ${args.join(" ")}: could not parse JSON output`);
  }
  if (parsed.error) {
    throw new HerdrError(parsed.error.code, parsed.error.message);
  }
  if (parsed.result === undefined) {
    throw new Error(`herdr ${args.join(" ")}: response had no result`);
  }
  return parsed.result;
}

/**
 * Like `runHerdr`, but for commands confirmed live to return empty stdout
 * on success rather than herdr's usual JSON envelope (`pane send-keys` —
 * see DECISIONS.md). A non-throwing exit is success regardless of stdout
 * content; a thrown error is still parsed the normal way.
 */
function runHerdrAction(args: string[]): void {
  try {
    execFileSync("herdr", args, { encoding: "utf8" });
  } catch (err) {
    throwHerdrFailure(args, err);
  }
}

/**
 * Like `runHerdr`, but for `pane read`, which (confirmed live) returns the
 * pane's raw rendered terminal text on stdout, not herdr's usual JSON
 * envelope.
 */
function runHerdrText(args: string[], opts?: { quiet?: boolean }): string {
  try {
    return execFileSync("herdr", args, {
      encoding: "utf8",
      // execFileSync leaks stderr straight to the parent's terminal by
      // default even though it's also captured for throwHerdrFailure to
      // parse (confirmed live) — same rationale as runHerdr's `quiet`:
      // pass it when a failure is routine/handled, not worth echoing raw.
      ...(opts?.quiet ? { stdio: ["ignore", "pipe", "pipe"] } : {}),
    });
  } catch (err) {
    throwHerdrFailure(args, err);
  }
}

function tryParseEnvelope<T>(text: string): HerdrEnvelope<T> | undefined {
  try {
    return JSON.parse(text.trim()) as HerdrEnvelope<T>;
  } catch {
    return undefined;
  }
}

export interface HerdrPaneInfo {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  // Confirmed live: a plain shell pane (no agent detected) reports
  // "unknown", not one of ledger's own four statuses — same widening
  // watcher.ts already applies to this same field (PaneAgentStatusChangedData).
  agent_status: HerdrAgentStatus | "unknown";
  cwd: string | null;
}

export interface HerdrWorkspaceCreateResult {
  workspace: { workspace_id: string; label: string };
  tab: { tab_id: string; workspace_id: string };
  root_pane: HerdrPaneInfo;
}

/** Creates a new workspace (with its own root tab + root pane) at `cwd`. */
export function createWorkspace(opts: {
  cwd: string;
  label: string;
  focus?: boolean;
}): HerdrWorkspaceCreateResult {
  const args = ["workspace", "create", "--cwd", opts.cwd, "--label", opts.label];
  args.push(opts.focus ? "--focus" : "--no-focus");
  return runHerdr<HerdrWorkspaceCreateResult>(args);
}

export function closeWorkspace(workspaceId: string): void {
  runHerdr(["workspace", "close", workspaceId]);
}

export interface HerdrWorkspaceInfo {
  workspace_id: string;
  label: string;
}

/**
 * Fetches a workspace's info (including its label). Throws HerdrError
 * (e.g. `workspace_not_found`) when the id doesn't exist. Pass `quiet`
 * when a missing workspace is an expected, handled outcome: it suppresses
 * herdr's raw error envelope being echoed to the terminal, while
 * `throwHerdrFailure` still parses it from the piped stderr.
 */
export function getWorkspace(
  workspaceId: string,
  opts?: { quiet?: boolean },
): HerdrWorkspaceInfo {
  const result = runHerdr<{ type: string; workspace: HerdrWorkspaceInfo }>(
    ["workspace", "get", workspaceId],
    opts,
  );
  return result.workspace;
}

export function renameWorkspace(workspaceId: string, label: string): void {
  runHerdr(["workspace", "rename", workspaceId, label]);
}

/**
 * Fetches a pane's current info, including its live `agent_status` — the
 * fresh, C7-style observation `agent followup` checks before sending more
 * work to an already-dispatched agent's pane (see agents.ts). Throws
 * HerdrError (e.g. `pane_not_found`) when the id doesn't exist. Pass `quiet`
 * when a missing pane is an expected, handled outcome (same rationale as
 * `getWorkspace`'s `quiet`).
 */
export function getPane(paneId: string, opts?: { quiet?: boolean }): HerdrPaneInfo {
  const result = runHerdr<{ type: string; pane: HerdrPaneInfo }>(
    ["pane", "get", paneId],
    opts,
  );
  return result.pane;
}

/**
 * True only if `workspaceId` still exists AND its label matches `label` —
 * not just that the id resolves to *some* workspace. Workspace ids are
 * recycled by herdr (e.g. after a herdr restart resets its allocation), so
 * a stale stored id can collide with an unrelated, freshly-created
 * workspace that happens to reuse the same id. Comparing the label is how
 * identity — not just existence — is verified.
 */
export function workspaceHasLabel(workspaceId: string, label: string): boolean {
  try {
    // quiet: this is a routine "is it still the one we think it is?"
    // check — a missing/stale workspace is an expected, handled outcome,
    // not noise worth printing to the terminal every time.
    const workspace = getWorkspace(workspaceId, { quiet: true });
    return workspace.label === label;
  } catch (err) {
    if (err instanceof HerdrError && err.code === "workspace_not_found") {
      return false;
    }
    throw err;
  }
}

export interface HerdrTabCreateResult {
  tab: { tab_id: string; workspace_id: string; label: string };
  root_pane: HerdrPaneInfo;
}

/** Adds a new tab (with its own root pane) to an existing workspace at `cwd`. */
export function createTab(opts: {
  workspace: string;
  cwd: string;
  label: string;
  focus?: boolean;
}): HerdrTabCreateResult {
  const args = [
    "tab",
    "create",
    "--workspace",
    opts.workspace,
    "--cwd",
    opts.cwd,
    "--label",
    opts.label,
  ];
  args.push(opts.focus ? "--focus" : "--no-focus");
  return runHerdr<HerdrTabCreateResult>(args);
}

export function closeTab(tabId: string): void {
  runHerdr(["tab", "close", tabId]);
}

export function renameTab(tabId: string, label: string): void {
  runHerdr(["tab", "rename", tabId, label]);
}

const AGENT_START_READY_RETRY_BUDGET_MS = 10_000;
const AGENT_START_READY_RETRY_INTERVAL_MS = 300;
const AGENT_READY_TIMEOUT_MS = 15_000;

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export type HerdrPaneReadSource = "visible" | "recent" | "recent-unwrapped" | "detection";

export interface ReadPaneOptions {
  /** Terminal snapshot source (herdr default: recent). */
  source?: HerdrPaneReadSource;
  /** Tail line count; omitted means herdr's own default (the full snapshot). */
  lines?: number;
  /** Suppress herdr's raw stderr on failure (see `runHerdr`'s `quiet`) — pass this when a failed read is routine/handled, not worth echoing raw. */
  quiet?: boolean;
}

/**
 * Reads a pane's rendered terminal text — the general-purpose entry point
 * (catch-up's idle-agent pane tails; anything else that needs to look at
 * what a pane last showed). Throws HerdrError (e.g. `pane_not_found`) for a
 * gone pane, or a generic Error for something more fundamental (socket
 * unreachable) — callers that need to tell those apart use `instanceof
 * HerdrError`, same as every other herdr-client call in this file.
 */
export function readPane(paneId: string, opts?: ReadPaneOptions): string {
  const args = ["pane", "read", paneId, "--source", opts?.source ?? "recent", "--format", "text"];
  if (opts?.lines !== undefined) {
    args.push("--lines", String(opts.lines));
  }
  return runHerdrText(args, opts?.quiet !== undefined ? { quiet: opts.quiet } : undefined);
}

/**
 * Starts a supported interactive coding agent in an existing pane at its
 * shell prompt. A pane created moments earlier (e.g. right after
 * `createWorkspace`, called with zero delay in `agent dispatch`) is often
 * not yet at rest — confirmed live (see DECISIONS.md): `herdr agent start`
 * fails with `agent_pane_busy: "... is not an available shell"` in that
 * window, and real elapsed time resolves it, so retry on that code with a
 * short synchronous backoff; any other error fails immediately.
 *
 * `agent_pane_busy` can also mean the opposite: an earlier attempt already
 * launched the agent (seen live on dispatch, panes wE/wF, 2026-10-01 — the
 * agent engaged fine) and the pane is no longer a bare shell. So before
 * each retry, check whether herdr already sees an agent on the pane; if so
 * the start succeeded and we just wait for it to settle.
 *
 * Claude Code's "trust this folder?" dialog is not handled here: callers
 * pre-trust the worktree (see `trustClaudeWorktree`) before launching, so
 * the dialog never appears and herdr's readiness detection isn't blocked.
 */
export function startAgent(opts: {
  name: string;
  kind: CodingAgentKind;
  pane: string;
  /** Passed through to the launched agent binary itself (after `--`). */
  extraArgs?: string[];
}): void {
  const args = ["agent", "start", opts.name, "--kind", opts.kind, "--pane", opts.pane];
  if (opts.extraArgs && opts.extraArgs.length > 0) {
    args.push("--", ...opts.extraArgs);
  }
  const deadline = Date.now() + AGENT_START_READY_RETRY_BUDGET_MS;

  for (;;) {
    try {
      runHerdr(args);
      return;
    } catch (err) {
      if (!(err instanceof HerdrError) || err.code !== "agent_pane_busy") throw err;
      if (paneHasAgent(opts.pane)) {
        // --until idle specifically: right after launch Claude Code passes
        // through a transient "blocked" status, which `agent wait`'s default
        // (idle/done/blocked) would match too early.
        runHerdr([
          "agent", "wait", opts.pane, "--until", "idle",
          "--timeout", String(AGENT_READY_TIMEOUT_MS),
        ]);
        return;
      }
      if (Date.now() >= deadline) throw err;
      sleepSync(AGENT_START_READY_RETRY_INTERVAL_MS);
    }
  }
}

function paneHasAgent(paneId: string): boolean {
  try {
    const status = getPane(paneId, { quiet: true }).agent_status;
    return status !== "unknown";
  } catch {
    return false;
  }
}

export function sendKeys(paneId: string, ...keys: string[]): void {
  runHerdrAction(["pane", "send-keys", paneId, ...keys]);
}

/**
 * Submits the initial task instruction to a running agent. Confirmed live
 * (see DECISIONS.md): for text long/multi-line enough that Claude Code's
 * TUI collapses it into a "[Pasted text #N +M lines]" placeholder — which
 * every real dispatch hits, since `buildTaskPrompt` always appends a
 * multi-paragraph reporting contract — `herdr agent prompt` pastes the
 * text into the input box but does not submit it; the agent sits idle
 * until something sends Enter. Always follow up with an explicit Enter
 * keypress to guarantee submission regardless of text length.
 *
 * Never pass `--wait` to the `agent prompt` call itself: it would block
 * waiting for a state change that can't happen until *after* the
 * follow-up Enter below is sent (a deadlock/stall). If waiting is
 * requested, do it as its own step afterward via `agent wait`.
 */
export function promptAgent(opts: {
  target: string;
  text: string;
  wait?: boolean;
  timeoutMs?: number;
}): void {
  runHerdr(["agent", "prompt", opts.target, opts.text]);
  sendKeys(opts.target, "enter");

  if (opts.wait) {
    const waitArgs = ["agent", "wait", opts.target];
    if (opts.timeoutMs) waitArgs.push("--timeout", String(opts.timeoutMs));
    runHerdr(waitArgs);
  }
}

