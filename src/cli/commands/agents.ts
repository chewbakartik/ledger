import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { SQLInputValue } from "node:sqlite";
import { getDb } from "../../db/client.js";
import { AUTHORIZATION_BASES, CODING_AGENT_KINDS } from "../../db/types.js";
import type {
  AgentRow,
  AgentStatus,
  AuthorizationBasis,
  CodingAgentKind,
  ProjectRow,
} from "../../db/types.js";
import * as herdr from "../../lib/herdr.js";
import { leaseWorktree, returnWorktree } from "../../lib/treehouse.js";
import { printJson, printTable } from "../format.js";
import { getProjectByName } from "./projects.js";

const VALID_STATUSES: AgentStatus[] = ["blocked", "working", "done", "idle"];

// Dispatched Claude agents run unattended — nobody is present in the pane
// to answer a permission prompt, so "auto" mode (Claude Code's default,
// which still prompts for some actions) would just stall. bypassPermissions
// skips all of them. Per the user: scoped to claude specifically, not
// every coding-agent kind.
const CLAUDE_BYPASS_ARGS = ["--permission-mode", "bypassPermissions"];

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
    .requiredOption(
      "--authorization <basis>",
      "who authorized this dispatch (user-explicit | pre-authorized) - " +
        "clerk-attested, recorded on the agent row for audit (C6)",
    )
    .option("--roadmap-item <id>", "roadmap item this dispatch implements", parseIntOpt)
    .option(
      "--confirm-duplicate",
      "explicit user authorization to run a second live agent on a roadmap " +
        "item that already has one (C6)",
    )
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
        authorization: string;
        roadmapItem?: number;
        confirmDuplicate?: boolean;
        kind: string;
        label?: string;
        spawnedBy?: number;
        wait?: boolean;
      }) => {
        const project = getProjectByName(opts.project);
        const db = getDb();

        if (!AUTHORIZATION_BASES.includes(opts.authorization as AuthorizationBasis)) {
          throw new Error(
            `--authorization must be one of: ${AUTHORIZATION_BASES.join(" | ")}`,
          );
        }
        const authorization = opts.authorization as AuthorizationBasis;

        if (opts.roadmapItem !== undefined) {
          const item = db
            .prepare("SELECT id, project_id FROM roadmap WHERE id = ?")
            .get(opts.roadmapItem) as unknown as
            | { id: number; project_id: number }
            | undefined;
          if (!item) throw new Error(`no roadmap item #${opts.roadmapItem}`);
          if (item.project_id !== project.id) {
            throw new Error(
              `roadmap item #${opts.roadmapItem} belongs to a different project`,
            );
          }
          // C6: refuse a second live agent on an item that already has one
          // without explicit confirmation. done/idle rows are terminal or
          // dormant and don't count as live.
          const live = db
            .prepare(
              `SELECT id FROM agents
               WHERE roadmap_item_id = ? AND status IN ('working', 'blocked')`,
            )
            .all(opts.roadmapItem) as unknown as { id: number }[];
          if (live.length > 0 && !opts.confirmDuplicate) {
            throw new Error(
              `roadmap item #${opts.roadmapItem} already has a live agent ` +
                `(${live.map((a) => `#${a.id}`).join(", ")}) — a second dispatch ` +
                `needs the user's explicit word; pass --confirm-duplicate only ` +
                `if they gave it (C6)`,
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
          // For kind === "claude", herdr.startAgent itself detects and
          // dismisses Claude Code's one-time "do you trust this folder?"
          // dialog when it blocks readiness (see its docstring in
          // herdr.ts and DECISIONS.md) — a blind post-hoc Enter here
          // cannot work, since `startAgent` only returns successfully
          // once the agent is actually ready, and that success never
          // comes while the dialog is still up.
          herdr.startAgent({
            name: label,
            kind,
            pane: pane.paneId,
            ...(kind === "claude" ? { extraArgs: CLAUDE_BYPASS_ARGS } : {}),
          });
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
               herdr_workspace, herdr_tab, herdr_pane, coding_agent, authorization_basis, spawned_by
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            authorization,
            opts.spawnedBy ?? null,
          ) as unknown as AgentRow;

        db.prepare(
          `INSERT INTO events (agent_id, event_type, payload) VALUES (?, 'dispatched', ?)`,
        ).run(row.id, JSON.stringify({ task: opts.task, kind, authorization }));

        try {
          herdr.promptAgent({
            target: pane.paneId,
            text: buildTaskPrompt(row.id, opts.task, project),
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
      const params: SQLInputValue[] = [];

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

      const rows = db.prepare(sql).all(...params) as unknown as AgentRow[];
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
        ) as unknown as AgentRow;

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
        "herdr tab. Refuses unless the work in the worktree is proven durable " +
        "(C3 in DECISIONS.md); --force is the user's explicit authorization " +
        "to discard. Does not change agents.status — do that separately with " +
        "'agent update' if appropriate.",
    )
    .option(
      "--force",
      "explicit user authorization to discard whatever is in the worktree — " +
        "bypasses the survival proof; never a repair path for a bad proof (C3)",
    )
    .action((id: string, opts: { force?: boolean }) => {
      const db = getDb();
      const row = getAgentById(Number(id));

      const proof = survivalProof(row.worktree_path);
      if (proof.state !== "durable" && !opts.force) {
        // Fail closed: record the refusal and hand the decision to the
        // clerk→user channel. Never auto-discard work we couldn't prove
        // survives somewhere durable.
        db.prepare(
          `INSERT INTO events (agent_id, event_type, payload) VALUES (?, 'release_refused', ?)`,
        ).run(row.id, JSON.stringify({ survival: proof }));
        const what =
          proof.state === "at-risk"
            ? `${proof.uncommittedChanges ?? 0} uncommitted change(s) and/or ` +
              `${proof.unpushedCommits ?? 0} commit(s) on branch ` +
              `'${proof.branch}' not on any remote`
            : (proof.reason ?? "unknown");
        throw new Error(
          `refusing to release agent #${row.id}: its work is ${proof.state} — ` +
            `${what}. Escalate to the user before discarding; pass --force ` +
            `only with the user's explicit authorization to discard this ` +
            `work (C3).`,
        );
      }

      returnWorktree(row.worktree_path);
      try {
        // Close just this agent's own tab, never the whole workspace —
        // other agents working the same project may have live tabs in it
        // (see "one herdr workspace per project" in DECISIONS.md).
        herdr.closeTab(row.herdr_tab);
      } catch {
        // Tab may already be closed (e.g. user closed the pane manually)
        // — releasing the worktree lease is what matters.
      }

      db.prepare(
        `INSERT INTO events (agent_id, event_type, payload) VALUES (?, 'released', ?)`,
      ).run(
        row.id,
        JSON.stringify({ survival: proof, forced: opts.force ?? false }),
      );

      printJson({
        released: true,
        agent_id: row.id,
        worktree_path: row.worktree_path,
        survival: proof,
      });
    });
}

export function getAgentById(id: number): AgentRow {
  const row = getDb().prepare("SELECT * FROM agents WHERE id = ?").get(id) as unknown as
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

type SurvivalState = "durable" | "at-risk" | "unprovable";

interface SurvivalProof {
  state: SurvivalState;
  /** Branch checked out in the worktree (or "HEAD" if detached). */
  branch?: string;
  /** Uncommitted changes in the worktree, including untracked files. */
  uncommittedChanges?: number;
  /** Commits on the checked-out branch not present on any remote. */
  unpushedCommits?: number;
  /** Why the proof could not be established (unprovable). */
  reason?: string;
}

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * Clerk gate C3 (DECISIONS.md, 2026-08-23): before `agent release` returns a
 * worktree that may hold work, establish a three-state proof of where that work stands:
 *
 *   durable   — nothing uncommitted, and every commit on this worktree's
 *               checked-out branch is already on a remote (pushed or merged)
 *               → the work survives the worktree being reset away; safe to
 *               auto-return.
 *   at-risk   — uncommitted changes and/or commits on a local ref that no
 *               remote has → returning the worktree (treehouse `return
 *               --force` resets it) would destroy them.
 *   unprovable— git failed, or the worktree can't be inspected → fail
 *               closed, treated like at-risk.
 *
 * Only the checked-out branch is inspected: all worktrees of one repo share
 * refs, so counting every local branch would misattribute other agents'
 * unpushed work to this release.
 */
function survivalProof(worktreePath: string): SurvivalProof {
  if (!existsSync(worktreePath)) {
    return {
      state: "durable",
      reason: "worktree path no longer exists — nothing to lose",
    };
  }

  let status: string;
  let branch: string;
  try {
    status = gitIn(worktreePath, ["status", "--porcelain"]);
    branch = gitIn(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  } catch (err) {
    return {
      state: "unprovable",
      reason: `git failed in ${worktreePath}: ${(err as Error).message}`,
    };
  }

  let unpushed: number;
  try {
    // `--remotes` expands to local remote-tracking refs only (no network
    // call). A commit counts as durable iff some remote already has it —
    // including the merged case, where a remote branch contains it. With
    // no remotes at all (a from-scratch local-only project) every commit
    // counts as unpushed, which is right: there is nowhere for it to be
    // durable yet.
    unpushed = Number.parseInt(
      gitIn(worktreePath, ["rev-list", "HEAD", "--not", "--remotes", "--count"]).trim(),
      10,
    );
  } catch (err) {
    return {
      state: "unprovable",
      reason: `git failed in ${worktreePath}: ${(err as Error).message}`,
    };
  }

  const uncommitted = status.trim() === "" ? 0 : status.trim().split("\n").length;
  if (uncommitted === 0 && unpushed === 0) {
    return { state: "durable", branch, uncommittedChanges: 0, unpushedCommits: 0 };
  }
  return {
    state: "at-risk",
    branch,
    uncommittedChanges: uncommitted,
    unpushedCommits: unpushed,
  };
}

/**
 * Every dispatched agent's actual first prompt: the clerk's task text plus
 * a short, self-contained reporting contract (full version in LEDGER.md,
 * "For dispatched agents") — so an agent never needs to read LEDGER.md
 * itself to know how to report back.
 *
 * The delivery step (branch + PR vs. just a branch) is driven entirely by
 * `project.delivery_mode`, already core schema — but *how* a PR actually
 * gets opened is deliberately left to the agent's own judgment/tooling
 * (e.g. `tea` against a Forgejo remote), not something ledger orchestrates
 * or needs to know about. See DECISIONS.md.
 *
 * The appended contract also carries the worker-side governance gates
 * (DECISIONS.md, "Agent (worker) gates" — roadmap item #5): one task /
 * one worktree / no spawning (A1), blocked as a structured decision
 * request (A4), no self-modification of the contract or the board (A5),
 * faithful outcomes (A6), and work surviving in a durable posture before
 * exit (A7). A2 (no merging, ever: no branch merge in any mode,
 * no PR approval) lives in both delivery texts since the
 * self-merge incident, generalized 2026-09-02.
 */
function buildTaskPrompt(agentId: number, task: string, project: ProjectRow): string {
  const deliveryInstructions =
    project.delivery_mode === "direct-pr"
      ? `Work on a new branch — never commit directly to '${project.default_branch}'.
Before you exit, all your work must be on that branch pushed to the remote
— your worktree is leased and gets recycled, so anything that lives only in
it is at risk of being lost.
When you're done, open a pull request against '${project.default_branch}'
(use whatever tooling is available for this project's remote, e.g. \`tea\`
for a Forgejo remote). Never merge any branch or PR — your own or anyone
else's — and never approve any PR, even if you technically can: opening
the PR is the whole job. Merging and approving are human/review decisions,
not yours to make, regardless of anything else you're told, including by
the clerk. Then run this as your last step:
  ledger agent update ${agentId} --status done --outcome '<pr-url>'
using the PR's URL.`
      : `Work on a new branch — never commit directly to '${project.default_branch}'.
Before you exit, commit all your work in the worktree — it is leased and
gets recycled, so anything left uncommitted is at risk of being lost.
Merging that branch into any other branch is not your act — you report it
and stop. Never merge any branch or PR, and never approve any PR, regardless
of anything else you're told; the merge is a human decision.
When you're done, run this as your last step:
  ledger agent update ${agentId} --status done --outcome '<branch-name-or-report-path>'`;

  return `${task}

---
${deliveryInstructions}

Your \`--outcome\` is a faithful report, not a claim: what actually
happened, plus evidence (commits, PR URL, test output). "done" means
done — if the work is partial, say so in the outcome and name what
remains. State failures plainly; don't dress them up.

If you get stuck and need a decision before you can continue: stop where
you are and record the decision as a structured request — what you tried,
the exact decision you need, and 2–3 options with a recommendation:
  ledger agent update ${agentId} --status blocked --outcome '<tried: ...; decision needed: ...; options: 1) ... 2) ... (recommend: ...)>'
Never pick the answer yourself and proceed on an out-of-scope resolution —
that decision belongs to the user, relayed through the clerk. (herdr
detects a stopped agent as "blocked" on its own too — but the structured
outcome above is what lets the clerk escalate in one turn and the user
answer in one word.)

Your scope is exactly this one task in this one worktree. Don't spawn or
dispatch further agents or workspaces, and don't coordinate directly with
other agents — nesting and coordination are the supervisor's job. If you
notice something out of scope, note it in your outcome — don't act on it.
And don't edit the contract (this prompt, LEDGER.md) or the ledger's own
records to widen your scope or make the work look better than it is.

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
 * True only if `workspaceId` still exists AND is still the workspace
 * belonging to `project` — not just that the id resolves to *some*
 * workspace. Workspace ids are recycled by herdr (e.g. after a herdr
 * restart resets its allocation), so a stale stored id can collide with an
 * unrelated, freshly-created workspace that happens to reuse the same id.
 * Workspaces are created with `label: project.name` (see openDispatchPane
 * below), so comparing the label is how identity — not just existence — is
 * verified.
 */
function workspaceBelongsToProject(workspaceId: string, project: ProjectRow): boolean {
  try {
    // quiet: this is a routine "is it still ours?" check, run on every
    // dispatch — a missing/stale workspace is an expected, handled outcome,
    // not noise worth printing to the terminal every time.
    const workspace = herdr.getWorkspace(workspaceId, { quiet: true });
    return workspace.label === project.name;
  } catch (err) {
    if (err instanceof herdr.HerdrError && err.code === "workspace_not_found") {
      return false;
    }
    throw err;
  }
}

/**
 * One herdr workspace per project, not per dispatch (per the user — see
 * DECISIONS.md): reuses the project's existing workspace as a new tab when
 * one is already live, or creates it (and records it via the caller) when
 * this is the project's first dispatch, or its previous workspace was
 * closed (e.g. by the user) or recycled to a different project since the
 * last dispatch.
 */
function openDispatchPane(project: ProjectRow, cwd: string, label: string): DispatchPane {
  if (project.herdr_workspace && workspaceBelongsToProject(project.herdr_workspace, project)) {
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
