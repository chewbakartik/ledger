export type DeliveryMode = "direct-pr" | "local-only";

export type RoadmapStatus =
  | "planned"
  | "in_progress"
  | "blocked"
  | "done"
  | "dropped";

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
