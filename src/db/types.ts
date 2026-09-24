export type DeliveryMode = "direct-pr" | "local-only";

// Roadmap #89 (2026-09-24): split the old bare 'done' into precise
// terminal states, plus a non-terminal 'in_review' for "code is up,
// waiting on a human." Non-terminal (workflow): planned, in_progress,
// blocked, in_review. Terminal (final, drives release/cleanup): merged,
// completed, discarded, dropped.
//
// 'merged' and 'discarded' both mean a PR/MR existed — merged means it
// landed on the default branch, discarded means it was reviewed and
// closed without merging. 'completed' is terminal for work that never
// produces a git artifact at all (a decision made, an investigation
// concluded). 'dropped' stays "abandoned/never attempted, no work product
// either way."
//
// Observation-required constraint (same principle as gate C7 in
// LEDGER.md): 'merged' and 'discarded' must only ever be set from an
// actual observed check against git/the PR host (e.g. `git log
// <default-branch> --grep`, or the MR's merged/closed state via the
// remote's API/CLI) — never from an agent's self-reported outcome text
// alone, and never inferred by the clerk without checking. 'in_review'
// can be set more loosely — a PR/MR URL in an agent's outcome is
// reasonable evidence code is up for review — since it isn't terminal.
export type RoadmapStatus =
  | "planned"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "merged"
  | "completed"
  | "discarded"
  | "dropped";

export const ROADMAP_STATUSES: RoadmapStatus[] = [
  "planned",
  "in_progress",
  "blocked",
  "in_review",
  "merged",
  "completed",
  "discarded",
  "dropped",
];

/** Terminal roadmap statuses: nothing further happens on the item from here. */
export const ROADMAP_TERMINAL_STATUSES: RoadmapStatus[] = [
  "merged",
  "completed",
  "discarded",
  "dropped",
];

// Coarse triage rank for the not-done queue (DECISIONS.md, 2026-08-23,
// user-directed): an *order*, not readiness — readiness stays with
// status = 'blocked' + description. A stale value only mis-sorts the
// queue (visible at catch-up); it never silently blocks ready work.
export type RoadmapPriority = "high" | "normal" | "low";

export const ROADMAP_PRIORITIES: RoadmapPriority[] = [
  "high",
  "normal",
  "low",
];

export type AgentStatus = "blocked" | "working" | "done" | "idle";

// Clerk gate C6 (DECISIONS.md): how a dispatch was authorized.
// 'user-explicit' = an in-the-moment green light from the user;
// 'pre-authorized' = a previously granted, per-item, revocable standing
// latitude. The value is clerk-attested (the CLI cannot verify the
// conversation) — the mechanics only require that every dispatch declares
// one and that it is recorded, so the board is auditable.
export type AuthorizationBasis = "user-explicit" | "pre-authorized";

export const AUTHORIZATION_BASES: AuthorizationBasis[] = [
  "user-explicit",
  "pre-authorized",
];

// Mirrors `herdr agent start --kind`'s accepted values.
export const CODING_AGENT_KINDS = [
  "pi",
  "claude",
  "codex",
  "gemini",
  "cursor",
  "devin",
  "agy",
  "cline",
  "omp",
  "mastracode",
  "opencode",
  "copilot",
  "kimi",
  "kiro",
  "droid",
  "amp",
  "grok",
  "hermes",
  "kilo",
  "qodercli",
  "maki",
] as const;

export type CodingAgentKind = (typeof CODING_AGENT_KINDS)[number];

export interface ProjectRow {
  id: number;
  name: string;
  /** NULL for a from-scratch project (`ledger project init`) — no origin exists yet. */
  repo_url: string | null;
  local_clone_path: string;
  default_branch: string;
  delivery_mode: DeliveryMode;
  created_at: string;
  /** The project's shared herdr workspace — one per project, not per dispatch. NULL until a first dispatch. */
  herdr_workspace: string | null;
}

export interface RoadmapRow {
  id: number;
  project_id: number;
  parent_id: number | null;
  title: string;
  description: string | null;
  status: RoadmapStatus;
  priority: RoadmapPriority;
  created_at: string;
  updated_at: string;
}

export interface AgentRow {
  id: number;
  project_id: number;
  roadmap_item_id: number | null;
  task_description: string;
  worktree_path: string;
  herdr_workspace: string;
  herdr_tab: string;
  herdr_pane: string;
  coding_agent: CodingAgentKind;
  status: AgentStatus;
  /** NULL only for rows predating the C6 authorization gate (migration 0003). */
  authorization_basis: AuthorizationBasis | null;
  outcome: string | null;
  spawned_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  id: number;
  agent_id: number;
  event_type: string;
  payload: string | null;
  created_at: string;
}

export interface FirstClerkRow {
  id: 1;
  session_id: string;
  herdr_pane: string;
  claimed_at: string;
  last_seen: string | null;
}
