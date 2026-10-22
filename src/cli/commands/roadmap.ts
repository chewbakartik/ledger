import { Command } from "commander";
import type { SQLInputValue } from "node:sqlite";
import { getDb } from "../../db/client.js";
import type { RoadmapPriority, RoadmapRow, RoadmapStatus } from "../../db/types.js";
import { ROADMAP_PRIORITIES, ROADMAP_STATUSES, ROADMAP_TERMINAL_STATUSES } from "../../db/types.js";
import { presentRoadmap, resolveRoadmapRef } from "../../lib/roadmap-keys.js";
import { printJson, printTable } from "../format.js";
import { getProjectByName } from "./projects.js";

const VALID_STATUSES: RoadmapStatus[] = ROADMAP_STATUSES;

export function registerRoadmapCommands(program: Command): void {
  const roadmap = program
    .command("roadmap")
    .description("manage the hierarchical feature breakdown for a project");

  roadmap
    .command("add")
    .description("add a roadmap item (top-level, or a sub-item via --parent)")
    .requiredOption("--project <name>", "project name")
    .requiredOption("--title <title>", "item title")
    .option("--description <text>", "longer description")
    .option("--parent <key>", "parent roadmap item key (e.g. LEDGER-12), for a sub-item")
    .option(
      "--priority <priority>",
      `item priority (${ROADMAP_PRIORITIES.join("|")}, default normal)`,
    )
    .action(
      (opts: {
        project: string;
        title: string;
        description?: string;
        parent?: string;
        priority?: string;
      }) => {
        const project = getProjectByName(opts.project);
        const db = getDb();
        if (project.code === null) {
          throw new Error(
            `project "${project.name}" has no roadmap-key code yet — run ` +
              `'ledger project update ${project.name} --code <CODE>' first`,
          );
        }
        // Note: assertValidPriority() is an assertion function (returns
        // void) — it validates/narrows, it must not be used as the value.
        let priority: RoadmapPriority = "normal";
        if (opts.priority !== undefined) {
          assertValidPriority(opts.priority);
          priority = opts.priority;
        }

        let parentId: number | null = null;
        if (opts.parent !== undefined) {
          const parent = resolveRoadmapRef(opts.parent, db);
          if (parent.project_id !== project.id) {
            throw new Error(
              `roadmap item ${parent.key} belongs to a different project`,
            );
          }
          parentId = parent.id;
        }

        // The item's key is assigned by a DB trigger (migration 0006), and
        // RETURNING doesn't see trigger effects — so re-read the row.
        const inserted = db
          .prepare(
            `INSERT INTO roadmap (project_id, parent_id, title, description, priority)
             VALUES (?, ?, ?, ?, ?)
             RETURNING id`,
          )
          .get(
            project.id,
            parentId,
            opts.title,
            opts.description ?? null,
            priority,
          ) as unknown as { id: number };
        const row = db
          .prepare("SELECT * FROM roadmap WHERE id = ?")
          .get(inserted.id) as unknown as RoadmapRow;

        printJson(presentRoadmap(row, db));
      },
    );

  roadmap
    .command("list")
    .description("list roadmap items for a project")
    .requiredOption("--project <name>", "project name")
    .option("--status <status>", `filter by status (${VALID_STATUSES.join("|")})`)
    .option(
      "--all",
      "include terminal items (merged/completed/discarded/dropped; default: exclude them)",
    )
    .option("--json", "output as JSON")
    .action(
      (opts: { project: string; status?: string; all?: boolean; json?: boolean }) => {
        const project = getProjectByName(opts.project);
        const db = getDb();

        let sql = "SELECT * FROM roadmap WHERE project_id = ?";
        const params: SQLInputValue[] = [project.id];

        if (opts.status) {
          assertValidStatus(opts.status);
          sql += " AND status = ?";
          params.push(opts.status);
        } else if (!opts.all) {
          sql += ` AND status NOT IN (${ROADMAP_TERMINAL_STATUSES.map(() => "?").join(", ")})`;
          params.push(...ROADMAP_TERMINAL_STATUSES);
        }
        sql += " ORDER BY parent_id IS NOT NULL, id";

        const rows = db.prepare(sql).all(...params) as unknown as RoadmapRow[];
        const presented = rows.map((r) => presentRoadmap(r, db));
        if (opts.json) printJson(presented);
        else printTable(presented);
      },
    );

  roadmap
    .command("update <key>")
    .description("update a roadmap item's status/title/description/priority")
    .option("--status <status>", `new status (${VALID_STATUSES.join("|")})`)
    .option("--title <title>", "new title")
    .option("--description <text>", "new description")
    .option("--priority <priority>", `new priority (${ROADMAP_PRIORITIES.join("|")})`)
    .action(
      (ref: string, opts: { status?: string; title?: string; description?: string; priority?: string }) => {
        if (opts.status) assertValidStatus(opts.status);
        if (opts.priority) assertValidPriority(opts.priority);
        const db = getDb();
        const existing = resolveRoadmapRef(ref, db);

        const row = db
          .prepare(
            `UPDATE roadmap
             SET status = ?, title = ?, description = ?, priority = ?, updated_at = datetime('now')
             WHERE id = ?
             RETURNING *`,
          )
          .get(
            opts.status ?? existing.status,
            opts.title ?? existing.title,
            opts.description ?? existing.description,
            opts.priority ?? existing.priority,
            existing.id,
          ) as unknown as RoadmapRow;

        printJson(presentRoadmap(row, db));
      },
    );
}

function assertValidStatus(status: string): asserts status is RoadmapStatus {
  if (!VALID_STATUSES.includes(status as RoadmapStatus)) {
    throw new Error(`--status must be one of: ${VALID_STATUSES.join(", ")}`);
  }
}

function assertValidPriority(priority: string): asserts priority is RoadmapPriority {
  if (!ROADMAP_PRIORITIES.includes(priority as RoadmapPriority)) {
    throw new Error(`--priority must be one of: ${ROADMAP_PRIORITIES.join(", ")}`);
  }
}
