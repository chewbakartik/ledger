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

/** Starts a supported interactive coding agent in an existing pane at its shell prompt. */
export function startAgent(opts: {
  name: string;
  kind: CodingAgentKind;
  pane: string;
  timeoutMs?: number;
}): void {
  const args = [
    "agent",
    "start",
    opts.name,
    "--kind",
    opts.kind,
    "--pane",
    opts.pane,
  ];
  if (opts.timeoutMs) args.push("--timeout", String(opts.timeoutMs));
  runHerdr(args);
}

/** Submits the initial task instruction to a running agent. */
export function promptAgent(opts: {
  target: string;
  text: string;
  wait?: boolean;
  timeoutMs?: number;
}): void {
  const args = ["agent", "prompt", opts.target, opts.text];
  if (opts.wait) args.push("--wait");
  if (opts.timeoutMs) args.push("--timeout", String(opts.timeoutMs));
  runHerdr(args);
}

