import { Command } from "commander";
import { getDb } from "../../db/client.js";
import type { AgentRow, EventRow, FirstClerkRow, RoadmapRow } from "../../db/types.js";
import { HerdrError, readPane } from "../../lib/herdr.js";
import { printJson } from "../format.js";
import { getProjectByName } from "./projects.js";

/** Default tail length for each idle agent's pane read (A8 liveness triage). */
const IDLE_PANE_TAIL_DEFAULT_LINES = 25;

interface IdleEntry {
  agent: AgentRow;
  pane_tail: string | null;
  pane_read_error: string | null;
}

/**
 * Reads the tail of every idle agent's pane, in one shot. Never throws —
 * per C7, an observation failure is not evidence, so a pane read failing
 * must never fail catch-up itself. A structured HerdrError (pane/tab gone)
 * is per-agent: recorded on that entry only. Anything else (couldn't even
 * get a herdr response — socket down) is systemic: recorded once as a
 * global note, and no further pane reads are attempted (they'd all fail the
 * same way) — every remaining idle agent gets that same note instead of
 * repeating the failure per pane.
 */
function readIdlePanes(
  agents: AgentRow[],
  lines: number,
): { entries: IdleEntry[]; globalNote: string | null } {
  const entries: IdleEntry[] = [];
  let globalNote: string | null = null;

  for (const agent of agents) {
    if (globalNote) {
      entries.push({ agent, pane_tail: null, pane_read_error: globalNote });
      continue;
    }
    try {
      const tail = readPane(agent.herdr_pane, { source: "recent", lines, quiet: true });
      entries.push({ agent, pane_tail: tail, pane_read_error: null });
    } catch (err) {
      if (err instanceof HerdrError) {
        entries.push({
          agent,
          pane_tail: null,
          pane_read_error: `${err.code}: ${err.message}`,
        });
      } else {
        // Not even a structured herdr error — treat as the whole socket
        // being unreachable rather than this one pane being gone.
        const message = err instanceof Error ? err.message : String(err);
        globalNote = `herdr pane reads unavailable: ${message}`;
        entries.push({ agent, pane_tail: null, pane_read_error: globalNote });
      }
    }
  }

  return { entries, globalNote };
}

const IDLE_LABEL_MAX_LENGTH = 80;

/** First line of a (possibly long, multi-paragraph) task description, truncated. */
function shortLabel(taskDescription: string): string {
  const firstLine = taskDescription.split("\n")[0] ?? "";
  return firstLine.length > IDLE_LABEL_MAX_LENGTH
    ? `${firstLine.slice(0, IDLE_LABEL_MAX_LENGTH - 1)}…`
    : firstLine;
}

function parseIdlePaneLinesOpt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`--idle-pane-lines must be a non-negative integer: ${value}`);
  }
  return n;
}

/**
 * The entire "what's going on" operation from DESIGN.md's session-start
 * flow: blocked agents needing a decision, events since the last time a
 * clerk looked, and the shape of what's still active on the roadmap.
 * Costs a handful of rows, not a document to re-parse.
 */
export function registerCatchupCommand(program: Command): void {
  program
    .command("catchup")
    .description("session-start summary: blocked agents, new events, active roadmap")
    .option("--project <name>", "scope roadmap (and optionally agents) to one project")
    .option(
      "--idle-pane-lines <n>",
      "lines of pane tail to show per idle agent (A8 liveness triage); 0 disables pane reads",
      parseIdlePaneLinesOpt,
      IDLE_PANE_TAIL_DEFAULT_LINES,
    )
    .option("--json", "output as JSON (default: human-readable)")
    .action((opts: { project?: string; idlePaneLines: number; json?: boolean }) => {
      const db = getDb();
      const project = opts.project ? getProjectByName(opts.project) : undefined;

      const firstClerk = db
        .prepare("SELECT * FROM first_clerk WHERE id = 1")
        .get() as FirstClerkRow | undefined;
      const since = firstClerk?.last_seen ?? firstClerk?.claimed_at ?? null;

      let blockedSql = "SELECT * FROM agents WHERE status = 'blocked'";
      const blockedParams: unknown[] = [];
      if (project) {
        blockedSql += " AND project_id = ?";
        blockedParams.push(project.id);
      }
      const blocked = db.prepare(blockedSql).all(...blockedParams) as AgentRow[];

      // A8 (DECISIONS.md): an idle agent with unfinished work is suspect —
      // it may have died on a usage limit. Surface every idle agent plus
      // the tail of what it last showed, so that check doesn't require
      // going to read the pane by hand.
      let idleSql = "SELECT * FROM agents WHERE status = 'idle'";
      const idleParams: unknown[] = [];
      if (project) {
        idleSql += " AND project_id = ?";
        idleParams.push(project.id);
      }
      const idleAgents = db.prepare(idleSql).all(...idleParams) as AgentRow[];
      const { entries: idle, globalNote: idlePaneGlobalNote } =
        opts.idlePaneLines > 0
          ? readIdlePanes(idleAgents, opts.idlePaneLines)
          : {
              entries: idleAgents.map((agent) => ({
                agent,
                pane_tail: null,
                pane_read_error: null,
              })),
              globalNote: null,
            };

      let events: EventRow[] = [];
      if (since) {
        let eventsSql = "SELECT * FROM events WHERE created_at > ?";
        const eventsParams: unknown[] = [since];
        if (project) {
          eventsSql +=
            " AND agent_id IN (SELECT id FROM agents WHERE project_id = ?)";
          eventsParams.push(project.id);
        }
        eventsSql += " ORDER BY created_at";
        events = db.prepare(eventsSql).all(...eventsParams) as EventRow[];
      }

      let roadmapSql =
        "SELECT * FROM roadmap WHERE status NOT IN ('done', 'dropped')";
      const roadmapParams: unknown[] = [];
      if (project) {
        roadmapSql += " AND project_id = ?";
        roadmapParams.push(project.id);
      }
      // Coarse triage order (DECISIONS.md, 2026-08-23): priority
      // high -> normal -> low, ties by id. Stale priorities mis-sort
      // this list (visible here) without blocking anything.
      roadmapSql +=
        " ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, id";
      const roadmap = db.prepare(roadmapSql).all(...roadmapParams) as RoadmapRow[];

      if (firstClerk) {
        db.prepare(
          "UPDATE first_clerk SET last_seen = datetime('now') WHERE id = 1",
        ).run();
      }

      const summary = { since, blocked, idle, idle_pane_read_note: idlePaneGlobalNote, events, roadmap };

      if (opts.json) {
        printJson(summary);
        return;
      }

      console.log(`Since: ${since ?? "(no prior catchup — showing full roadmap only)"}`);
      console.log(`\nBlocked (${blocked.length}):`);
      for (const a of blocked) {
        console.log(`  #${a.id} [${a.project_id}] ${a.task_description}`);
      }
      console.log(`\nIdle (${idle.length}):`);
      if (idlePaneGlobalNote) {
        console.log(`  (${idlePaneGlobalNote} — pane tails skipped below)`);
      }
      for (const { agent, pane_tail, pane_read_error } of idle) {
        console.log(
          `  #${agent.id} [${agent.project_id}] pane=${agent.herdr_pane} ` +
            shortLabel(agent.task_description),
        );
        if (pane_tail !== null) {
          for (const line of pane_tail.split("\n")) {
            console.log(`      ${line}`);
          }
        } else if (pane_read_error && !idlePaneGlobalNote) {
          console.log(`      pane unreadable: ${pane_read_error}`);
        }
      }
      console.log(`\nEvents (${events.length}):`);
      for (const e of events) {
        console.log(`  ${e.created_at} agent#${e.agent_id} ${e.event_type}`);
      }
      console.log(`\nRoadmap in flight (${roadmap.length}):`);
      for (const r of roadmap) {
        const indent = r.parent_id ? "    " : "  ";
        console.log(`${indent}#${r.id} [${r.status}] ${r.title}`);
      }
    });
}
