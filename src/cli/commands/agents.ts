import { Command } from "commander";
import { getDb } from "../../db/client.js";
import { CODING_AGENT_KINDS } from "../../db/types.js";
import type { AgentRow, AgentStatus, CodingAgentKind, ProjectRow } from "../../db/types.js";
import * as herdr from "../../lib/herdr.js";
import { leaseWorktree, returnWorktree } from "../../lib/treehouse.js";
import { printJson, printTable } from "../format.js";
import { getProjectByName } from "./projects.js";

const VALID_STATUSES: AgentStatus[] = ["blocked", "working", "done", "idle"];

export function registerAgentCommands(program: Command): void {
  const agent = program.command("agent").description("manage dispatched agents");

  agent
    .command("dispatch")
    .description(
      "lease a treehouse worktree, open a herdr pane in it, start a coding " +
        "agent, submit the task, and record the agents row",
    )
    .requiredOption("--project <name>", "project name")
    .requiredOption("--task <description>", "task instruction for the agent")
    .option("--roadmap-item <id>", "roadmap item this dispatch implements", parseIntOpt)
    .option("--kind <kind>", "coding agent to run (claude, pi, ...)", "claude")
    .option("--label <label>", "short label for the herdr workspace/pane")
    .option(
      "--spawned-by <agentId>",
      "id of the agent that spawned this one (omit if spawned by the clerk directly)",
      parseIntOpt,
    )
    .option("--wait", "wait for the agent to leave 'working' after the initial prompt")
    .action(
      (opts: {
        project: string;
        task: string;
        roadmapItem?: number;
        kind: string;
        label?: string;
        spawnedBy?: number;
        wait?: boolean;
      }) => {
        const project = getProjectByName(opts.project);
        const db = getDb();

        if (opts.roadmapItem !== undefined) {
          const item = db
            .prepare("SELECT id, project_id FROM roadmap WHERE id = ?")
            .get(opts.roadmapItem) as { id: number; project_id: number } | undefined;
          if (!item) throw new Error(`no roadmap item #${opts.roadmapItem}`);
          if (item.project_id !== project.id) {
            throw new Error(
              `roadmap item #${opts.roadmapItem} belongs to a different project`,
            );
          }
        }

        if (opts.spawnedBy !== undefined) {
          const spawner = db
            .prepare("SELECT id FROM agents WHERE id = ?")
            .get(opts.spawnedBy);
          if (!spawner) throw new Error(`no agent #${opts.spawnedBy}`);
        }

        if (!CODING_AGENT_KINDS.includes(opts.kind as CodingAgentKind)) {
          throw new Error(`--kind must be one of: ${CODING_AGENT_KINDS.join(", ")}`);
        }
        const kind = opts.kind as CodingAgentKind;
        const label = opts.label ?? deriveLabel(opts.task);

        const worktreePath = leaseWorktree({
          repoCwd: project.local_clone_path,
          leaseHolder: `ledger:${project.name}`,
        });

        let pane: DispatchPane | undefined;
        try {
          pane = openDispatchPane(project, worktreePath, label);
          herdr.startAgent({ name: label, kind, pane: pane.paneId });
        } catch (err) {
          // Best-effort cleanup: don't leave a dangling herdr pane pointed
          // at a worktree that's already back in the treehouse pool, and
          // don't record an agents row for a dispatch that never actually
          // started. Only close the whole workspace if this dispatch just
          // created it — if it reused the project's existing workspace,
          // other tabs/agents may be live in it, so close just this tab.
          if (pane) {
            try {
              if (pane.createdNewWorkspace) herdr.closeWorkspace(pane.workspaceId);
              else herdr.closeTab(pane.tabId);
            } catch {
              // best-effort
            }
          }
          returnWorktree(worktreePath);
          throw err;
        }

        // Only now record the project's workspace — a failed first-dispatch
        // attempt above shouldn't leave the project pointing at a workspace
        // that was just closed as part of that failure's cleanup.
        if (pane.createdNewWorkspace) {
          db.prepare(`UPDATE projects SET herdr_workspace = ? WHERE id = ?`).run(
            pane.workspaceId,
            project.id,
          );
        }

        // The coding agent process is now running. Record it *before*
        // sending the task, so the task text itself can tell the agent its
        // own row id — that's what lets the reporting contract below
        // reference a real `ledger agent update <id> ...` command.
        const row = db
          .prepare(
            `INSERT INTO agents (
               project_id, roadmap_item_id, task_description, worktree_path,
               herdr_workspace, herdr_tab, herdr_pane, coding_agent, spawned_by
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING *`,
          )
          .get(
            project.id,
            opts.roadmapItem ?? null,
            opts.task,
            worktreePath,
            pane.workspaceId,
            pane.tabId,
            pane.paneId,
            kind,
            opts.spawnedBy ?? null,
          ) as AgentRow;

        db.prepare(
          `INSERT INTO events (agent_id, event_type, payload) VALUES (?, 'dispatched', ?)`,
        ).run(row.id, JSON.stringify({ task: opts.task, kind }));

        try {
          herdr.promptAgent({
            target: pane.paneId,
            text: buildTaskPrompt(row.id, opts.task),
            wait: opts.wait ?? false,
          });
        } catch (err) {
          // The agent process exists and is now tracked — don't tear any
          // of that down (the workspace/lease teardown above is only for
          // "never actually started" failures). Leave the row for the
          // clerk to investigate; `agent release` can reclaim it manually.
          db.prepare(
            `INSERT INTO events (agent_id, event_type, payload) VALUES (?, 'dispatch_prompt_failed', ?)`,
          ).run(row.id, JSON.stringify({ error: (err as Error).message }));
          throw err;
        }

        printJson(row);
      },
    );

  agent
    .command("list")
    .description("list dispatched agents")
    .option("--status <status>", `filter by status (${VALID_STATUSES.join("|")})`)
    .option("--project <name>", "filter by project name")
    .option("--json", "output as JSON")
    .action((opts: { status?: string; project?: string; json?: boolean }) => {
      const db = getDb();
      let sql = "SELECT * FROM agents WHERE 1=1";
      const params: unknown[] = [];

      if (opts.status) {
        assertValidStatus(opts.status);
        sql += " AND status = ?";
        params.push(opts.status);
      }
      if (opts.project) {
        const project = getProjectByName(opts.project);
        sql += " AND project_id = ?";
        params.push(project.id);
      }
      sql += " ORDER BY id DESC";

      const rows = db.prepare(sql).all(...params) as AgentRow[];
      if (opts.json) printJson(rows);
      else printTable(rows);
    });

  agent
    .command("get <id>")
    .description("show an agent by id")
    .action((id: string) => {
      printJson(getAgentById(Number(id)));
    });

  agent
    .command("update <id>")
    .description("update an agent's status and/or outcome")
    .option("--status <status>", `new status (${VALID_STATUSES.join("|")})`)
    .option("--outcome <text>", "pr_url | branch name | report path")
    .action((id: string, opts: { status?: string; outcome?: string }) => {
      if (opts.status) assertValidStatus(opts.status);
      const db = getDb();
      const existing = getAgentById(Number(id));

      const row = db
        .prepare(
          `UPDATE agents
           SET status = ?, outcome = ?, updated_at = datetime('now')
           WHERE id = ?
           RETURNING *`,
        )
        .get(
          opts.status ?? existing.status,
          opts.outcome ?? existing.outcome,
          Number(id),
        ) as AgentRow;

      if (opts.status || opts.outcome) {
        db.prepare(
          `INSERT INTO events (agent_id, event_type, payload) VALUES (?, 'manual_update', ?)`,
        ).run(row.id, JSON.stringify({ status: opts.status, outcome: opts.outcome }));
      }

      printJson(row);
    });

  agent
    .command("release <id>")
    .description(
      "return the agent's leased worktree to the treehouse pool and close its " +
        "herdr workspace. Does not change agents.status — do that separately " +
        "with 'agent update' if appropriate.",
    )
    .action((id: string) => {
      const db = getDb();
      const row = getAgentById(Number(id));

      returnWorktree(row.worktree_path);
      try {
        herdr.closeWorkspace(row.herdr_workspace);
      } catch {
        // Workspace may already be closed (e.g. user closed the pane
        // manually) — releasing the worktree lease is what matters.
      }

      db.prepare(
        `INSERT INTO events (agent_id, event_type, payload) VALUES (?, 'released', NULL)`,
      ).run(row.id);

      printJson({ released: true, agent_id: row.id, worktree_path: row.worktree_path });
    });
}

export function getAgentById(id: number): AgentRow {
  const row = getDb().prepare("SELECT * FROM agents WHERE id = ?").get(id) as
    | AgentRow
    | undefined;
  if (!row) throw new Error(`no agent #${id}`);
  return row;
}

function assertValidStatus(status: string): asserts status is AgentStatus {
  if (!VALID_STATUSES.includes(status as AgentStatus)) {
    throw new Error(`--status must be one of: ${VALID_STATUSES.join(", ")}`);
  }
}

function parseIntOpt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`not a valid integer: ${value}`);
  return n;
}

/**
 * Every dispatched agent's actual first prompt: the clerk's task text plus
 * a short, self-contained reporting contract (full version in LEDGER.md,
 * "For dispatched agents") — so an agent never needs to read LEDGER.md
 * itself to know how to report back.
 */
function buildTaskPrompt(agentId: number, task: string): string {
  return `${task}

---
When you're done, run this as your last step:
  ledger agent update ${agentId} --status done --outcome '<pr-url-or-branch-or-report-path>'

If you get stuck and need a decision before you can continue: just state the
question and stop where you are. herdr detects that as "blocked" automatically
and the clerk (and the human, via \`ledger catchup\`) will see it — you don't
need to run any ledger command for this.

Everything else — roadmap, project registration, dispatching other agents —
is the clerk's job, not yours.`;
}

/**
 * Doubles as the herdr tab label and the herdr agent name, so it must
 * satisfy the stricter of the two: herdr agent names must start with a
 * lowercase letter and contain only lowercase letters, digits, '-' or '_',
 * 1-32 characters. No longer prefixed with the project name (it was, when
 * every dispatch got its own workspace) — that's now redundant, since the
 * project name is the *workspace's* label and every dispatch to it is a
 * tab within that one workspace.
 */
function deriveLabel(task: string): string {
  const raw = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const truncated = raw.slice(0, 32).replace(/-+$/g, "");
  return truncated || "task";
}

interface DispatchPane {
  workspaceId: string;
  tabId: string;
  paneId: string;
  createdNewWorkspace: boolean;
}

/**
 * One herdr workspace per project, not per dispatch (per the user — see
 * DECISIONS.md): reuses the project's existing workspace as a new tab when
 * one is already live, or creates it (and records it via the caller) when
 * this is the project's first dispatch, or its previous workspace was
 * closed (e.g. by the user) since the last dispatch.
 */
function openDispatchPane(project: ProjectRow, cwd: string, label: string): DispatchPane {
  if (project.herdr_workspace && herdr.workspaceExists(project.herdr_workspace)) {
    const tab = herdr.createTab({
      workspace: project.herdr_workspace,
      cwd,
      label,
      focus: false,
    });
    return {
      workspaceId: project.herdr_workspace,
      tabId: tab.tab.tab_id,
      paneId: tab.root_pane.pane_id,
      createdNewWorkspace: false,
    };
  }

  const ws = herdr.createWorkspace({ cwd, label: project.name, focus: false });
  // workspace create doesn't take a separate tab label — its root tab
  // gets herdr's own default ("1"); rename it to match every later tab's
  // task-based labeling for consistency.
  herdr.renameTab(ws.tab.tab_id, label);
  return {
    workspaceId: ws.workspace.workspace_id,
    tabId: ws.tab.tab_id,
    paneId: ws.root_pane.pane_id,
    createdNewWorkspace: true,
  };
}
