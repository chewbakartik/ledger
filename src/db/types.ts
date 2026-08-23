export type DeliveryMode = "direct-pr" | "local-only";

export type RoadmapStatus =
  | "planned"
  | "in_progress"
  | "blocked"
  | "done"
  | "dropped";

export type AgentStatus = "blocked" | "working" | "done" | "idle";

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
