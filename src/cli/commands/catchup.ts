import { Command } from "commander";
import { getDb } from "../../db/client.js";
import type { AgentRow, EventRow, FirstClerkRow, RoadmapRow } from "../../db/types.js";
import { printJson } from "../format.js";
import { getProjectByName } from "./projects.js";

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
    .option("--json", "output as JSON (default: human-readable)")
    .action((opts: { project?: string; json?: boolean }) => {
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

      const summary = { since, blocked, events, roadmap };

      if (opts.json) {
        printJson(summary);
        return;
      }

      console.log(`Since: ${since ?? "(no prior catchup — showing full roadmap only)"}`);
      console.log(`\nBlocked (${blocked.length}):`);
      for (const a of blocked) {
        console.log(`  #${a.id} [${a.project_id}] ${a.task_description}`);
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
