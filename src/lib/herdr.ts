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

function runHerdr<T>(args: string[]): T {
  let stdout: string;
  try {
    stdout = execFileSync("herdr", args, { encoding: "utf8" });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    // herdr still writes its JSON error envelope to stdout on failure.
    if (e.stdout) {
      const parsed = tryParseEnvelope<T>(e.stdout);
      if (parsed?.error) {
        throw new HerdrError(parsed.error.code, parsed.error.message);
      }
    }
    throw new Error(
      `herdr ${args.join(" ")} failed: ${e.stderr ?? e.message}`,
    );
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
  agent_status: HerdrAgentStatus;
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

/** True if `workspaceId` still exists (wasn't closed, e.g. by the user). */
export function workspaceExists(workspaceId: string): boolean {
  try {
    runHerdr(["workspace", "get", workspaceId]);
    return true;
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

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Starts a supported interactive coding agent in an existing pane at its
 * shell prompt. A pane created moments earlier (e.g. right after
 * `createWorkspace`, called with zero delay in `agent dispatch`) is often
 * not yet at rest — confirmed live (see DECISIONS.md): `herdr agent start`
 * fails immediately with `agent_pane_busy: "... is not an available
 * shell"` in that window. `--timeout` does *not* cover this — that only
 * governs a later readiness wait, and passing it made no difference in
 * testing. What actually resolves it is real elapsed wall-clock time, so
 * retry specifically on `agent_pane_busy` with a short synchronous
 * backoff; any other error fails immediately, not retried.
 */
export function startAgent(opts: {
  name: string;
  kind: CodingAgentKind;
  pane: string;
}): void {
  const args = ["agent", "start", opts.name, "--kind", opts.kind, "--pane", opts.pane];
  const deadline = Date.now() + AGENT_START_READY_RETRY_BUDGET_MS;

  for (;;) {
    try {
      runHerdr(args);
      return;
    } catch (err) {
      const isPaneBusy = err instanceof HerdrError && err.code === "agent_pane_busy";
      if (!isPaneBusy || Date.now() >= deadline) throw err;
      sleepSync(AGENT_START_READY_RETRY_INTERVAL_MS);
    }
  }
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
  runHerdr(["pane", "send-keys", opts.target, "enter"]);

  if (opts.wait) {
    const waitArgs = ["agent", "wait", opts.target];
    if (opts.timeoutMs) waitArgs.push("--timeout", String(opts.timeoutMs));
    runHerdr(waitArgs);
  }
}

