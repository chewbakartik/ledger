import { Command } from "commander";
import type { SQLInputValue } from "node:sqlite";
import { getDb } from "../../db/client.js";
import type { RoadmapRow, WatchRow, WatchStatus } from "../../db/types.js";
import { WATCH_STATUSES } from "../../db/types.js";
import { expireDueWatches, parseSteps, parseTriggers, presentWatch } from "../../lib/watches.js";
import { printJson, printTable } from "../format.js";
import { getAgentById } from "./agents.js";
import { getProjectByName } from "./projects.js";

const DEFAULT_EXPIRY_HOURS = 24;

/**
 * Roadmap #89 (clerk follow-through). A watch is DB-stored next-step intent:
 * the herdr watcher plugin wakes the clerk pane when a watched agent/item
 * finishes, and the woken clerk reads the watch to learn what to do next.
 * Nothing here dispatches an agent or merges anything.
 */
export function registerWatchCommands(program: Command): void {
  const watch = program
    .command("watch")
    .description("follow-through watches: DB-stored next steps that wake the clerk");

  watch
    .command("add")
    .description(
      "add a watch. When the agent (and/or an agent on the roadmap item) " +
        "reaches done/blocked/failed, the watcher wakes the clerk pane with " +
        "the next-step instruction (or leaves a pending wake for catchup). " +
        "A chain is repeated --next; its length caps the wakes.",
    )
    .option("--agent <id>", "agent whose completion triggers a wake", parseIntOpt)
    .option(
      "--roadmap-item <id>",
      "roadmap item: any agent dispatched for it triggers a wake",
      parseIntOpt,
    )
    .requiredOption(
      "--next <instruction>",
      "exact next-step instruction for the woken clerk (repeat for an ordered chain)",
      collect,
      [] as string[],
    )
    .option("--on <states>", "comma list of done|blocked|failed (blocked/failed always wake)", "done,blocked,failed")
    .option(
      "--expires-in <hours>",
      `hours until the watch stops waking (default ${DEFAULT_EXPIRY_HOURS})`,
      parsePositiveNumber,
      DEFAULT_EXPIRY_HOURS,
    )
    .option(
      "--pre-authorized",
      "the human approved this whole series up front (C6): the woken clerk " +
        "may dispatch later steps with --authorization pre-authorized",
    )
    .action(
      (opts: {
        agent?: number;
        roadmapItem?: number;
        next: string[];
        on: string;
        expiresIn: number;
        preAuthorized?: boolean;
      }) => {
        const db = getDb();
        if (opts.agent === undefined && opts.roadmapItem === undefined) {
          throw new Error("give --agent and/or --roadmap-item");
        }
        const triggers = parseTriggers(opts.on);
        const steps = opts.next.map((s) => s.trim()).filter(Boolean);
        if (steps.length === 0) throw new Error("--next must not be empty");

        let projectId: number | undefined;
        if (opts.agent !== undefined) {
          const agent = getAgentById(opts.agent);
          projectId = agent.project_id;
          if (agent.status === "done" || agent.status === "blocked") {
            console.error(
              `Warning: agent #${agent.id} is already '${agent.status}' -- no further ` +
                `state-change event may arrive to wake the clerk. Check it directly.`,
            );
          }
        }
        if (opts.roadmapItem !== undefined) {
          const item = db
            .prepare("SELECT * FROM roadmap WHERE id = ?")
            .get(opts.roadmapItem) as unknown as RoadmapRow | undefined;
          if (!item) throw new Error(`no roadmap item #${opts.roadmapItem}`);
          if (projectId !== undefined && projectId !== item.project_id) {
            throw new Error("--agent and --roadmap-item belong to different projects");
          }
          projectId = item.project_id;
        }

        const row = db
          .prepare(
            `INSERT INTO watches
               (project_id, agent_id, roadmap_item_id, on_states, steps,
                authorization_basis, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))
             RETURNING *`,
          )
          .get(
            projectId as number,
            opts.agent ?? null,
            opts.roadmapItem ?? null,
            triggers.join(","),
            JSON.stringify(steps),
            opts.preAuthorized ? "pre-authorized" : null,
            `+${Math.round(opts.expiresIn * 3600)} seconds`,
          ) as unknown as WatchRow;
        printJson(presentWatch(row));
      },
    );

  watch
    .command("list")
    .description("list watches (default: open ones)")
    .option("--status <status>", `filter by status (${WATCH_STATUSES.join("|")})`)
    .option("--all", "include every status")
    .option("--project <name>", "filter by project name")
    .option("--json", "output as JSON")
    .action((opts: { status?: string; all?: boolean; project?: string; json?: boolean }) => {
      const db = getDb();
      expireDueWatches(db);
      let sql = "SELECT * FROM watches WHERE 1=1";
      const params: SQLInputValue[] = [];
      if (opts.status) {
        assertValidStatus(opts.status);
        sql += " AND status = ?";
        params.push(opts.status);
      } else if (!opts.all) {
        sql += " AND status = 'open'";
      }
      if (opts.project) {
        sql += " AND project_id = ?";
        params.push(getProjectByName(opts.project).id);
      }
      sql += " ORDER BY id";
      const rows = db.prepare(sql).all(...params) as unknown as WatchRow[];
      if (opts.json) {
        printJson(rows.map(presentWatch));
        return;
      }
      printTable(
        rows.map((w) => ({
          id: w.id,
          status: w.status,
          agent: w.agent_id ?? "",
          item: w.roadmap_item_id ?? "",
          step: `${w.step_index + 1}/${parseSteps(w).length}`,
          wake: w.pending_wake ? `pending(${w.wake_reason ?? "?"})` : w.wake_sent_at ? "sent" : "",
          expires_at: w.expires_at,
        })),
      );
    });

  watch
    .command("get <id>")
    .description("show a watch, including its step list and the current next step")
    .action((id: string) => {
      const db = getDb();
      expireDueWatches(db);
      printJson(presentWatch(getWatchById(Number(id))));
    });

  watch
    .command("cancel <id>")
    .description("cancel an open watch; it never wakes the clerk again")
    .action((id: string) => {
      printJson(presentWatch(finish(Number(id), "cancelled")));
    });

  watch
    .command("fire <id>")
    .description(
      "mark a watch fired: the woken clerk has handled it and nothing further " +
        "is pending (the last step of a chain, or a single watch)",
    )
    .action((id: string) => {
      printJson(presentWatch(finish(Number(id), "fired")));
    });

  watch
    .command("advance <id>")
    .description(
      "chain: move to the next step and retarget at the agent/roadmap item " +
        "you just dispatched for it, clearing the wake state. Refuses past " +
        "the last step (use 'watch fire').",
    )
    .option("--agent <id>", "the agent now running this step", parseIntOpt)
    .option("--roadmap-item <id>", "the roadmap item for this step", parseIntOpt)
    .action((id: string, opts: { agent?: number; roadmapItem?: number }) => {
      if (opts.agent === undefined && opts.roadmapItem === undefined) {
        throw new Error(
          "give --agent and/or --roadmap-item for the next step (otherwise the " +
            "watch would re-match the agent that already finished)",
        );
      }
      const db = getDb();
      const w = openWatch(Number(id));
      if (w.step_index + 1 >= parseSteps(w).length) {
        throw new Error(
          `watch #${w.id} is on its last step (${w.step_index + 1}/${parseSteps(w).length}) -- ` +
            `use 'ledger watch fire ${w.id}'`,
        );
      }
      const agentId = opts.agent ?? null;
      if (agentId !== null) getAgentById(agentId);
      const row = db
        .prepare(
          `UPDATE watches
           SET step_index = step_index + 1, agent_id = ?,
               roadmap_item_id = COALESCE(?, roadmap_item_id),
               pending_wake = 0, wake_agent_id = NULL, wake_state = NULL,
               wake_outcome = NULL, wake_reason = NULL, wake_at = NULL,
               wake_sent_at = NULL, pending_surfaced_at = NULL,
               updated_at = datetime('now')
           WHERE id = ? RETURNING *`,
        )
        .get(agentId, opts.roadmapItem ?? null, w.id) as unknown as WatchRow;
      printJson(presentWatch(row));
    });

  watch
    .command("rearm <id>")
    .description(
      "keep the same step and agent but clear the wake state, so the watch can " +
        "wake again (e.g. after you unblocked the agent and it continues)",
    )
    .action((id: string) => {
      const w = openWatch(Number(id));
      const row = getDb()
        .prepare(
          `UPDATE watches
           SET pending_wake = 0, wake_agent_id = NULL, wake_state = NULL,
               wake_outcome = NULL, wake_reason = NULL, wake_at = NULL,
               wake_sent_at = NULL, pending_surfaced_at = NULL,
               updated_at = datetime('now')
           WHERE id = ? RETURNING *`,
        )
        .get(w.id) as unknown as WatchRow;
      printJson(presentWatch(row));
    });
}

function getWatchById(id: number): WatchRow {
  const row = getDb().prepare("SELECT * FROM watches WHERE id = ?").get(id) as unknown as
    | WatchRow
    | undefined;
  if (!row) throw new Error(`no watch #${id}`);
  return row;
}

function openWatch(id: number): WatchRow {
  expireDueWatches(getDb());
  const w = getWatchById(id);
  if (w.status !== "open") throw new Error(`watch #${id} is ${w.status}, not open`);
  return w;
}

function finish(id: number, status: "fired" | "cancelled"): WatchRow {
  const w = openWatch(id);
  return getDb()
    .prepare(
      `UPDATE watches
       SET status = ?, pending_wake = 0, fired_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? RETURNING *`,
    )
    .get(status, w.id) as unknown as WatchRow;
}

function assertValidStatus(status: string): asserts status is WatchStatus {
  if (!WATCH_STATUSES.includes(status as WatchStatus)) {
    throw new Error(`--status must be one of: ${WATCH_STATUSES.join(", ")}`);
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseIntOpt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`not a valid integer: ${value}`);
  return n;
}

function parsePositiveNumber(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`not a positive number: ${value}`);
  return n;
}
