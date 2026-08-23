import { Command } from "commander";
import { getDb } from "../../db/client.js";
import type { RoadmapRow, RoadmapStatus } from "../../db/types.js";
import { printJson, printTable } from "../format.js";
import { getProjectByName } from "./projects.js";

const VALID_STATUSES: RoadmapStatus[] = [
  "planned",
  "in_progress",
  "blocked",
  "done",
  "dropped",
];

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
    .option("--parent <id>", "parent roadmap item id, for a sub-item", parseIntOpt)
    .action(
      (opts: {
        project: string;
        title: string;
        description?: string;
        parent?: number;
      }) => {
        const project = getProjectByName(opts.project);
        const db = getDb();

        if (opts.parent !== undefined) {
          const parent = db
            .prepare("SELECT id, project_id FROM roadmap WHERE id = ?")
            .get(opts.parent) as { id: number; project_id: number } | undefined;
          if (!parent) throw new Error(`no roadmap item #${opts.parent}`);
          if (parent.project_id !== project.id) {
            throw new Error(
              `roadmap item #${opts.parent} belongs to a different project`,
            );
          }
        }

        const row = db
          .prepare(
            `INSERT INTO roadmap (project_id, parent_id, title, description)
             VALUES (?, ?, ?, ?)
             RETURNING *`,
          )
          .get(
            project.id,
            opts.parent ?? null,
            opts.title,
            opts.description ?? null,
          ) as RoadmapRow;

        printJson(row);
      },
    );

  roadmap
    .command("list")
    .description("list roadmap items for a project")
    .requiredOption("--project <name>", "project name")
    .option("--status <status>", `filter by status (${VALID_STATUSES.join("|")})`)
    .option("--all", "include done/dropped items (default: exclude them)")
    .option("--json", "output as JSON")
    .action(
      (opts: { project: string; status?: string; all?: boolean; json?: boolean }) => {
        const project = getProjectByName(opts.project);
        const db = getDb();

        let sql = "SELECT * FROM roadmap WHERE project_id = ?";
        const params: unknown[] = [project.id];

        if (opts.status) {
          assertValidStatus(opts.status);
          sql += " AND status = ?";
          params.push(opts.status);
        } else if (!opts.all) {
          sql += " AND status NOT IN ('done', 'dropped')";
        }
        sql += " ORDER BY parent_id IS NOT NULL, id";

        const rows = db.prepare(sql).all(...params) as RoadmapRow[];
        if (opts.json) printJson(rows);
        else printTable(rows);
      },
    );

  roadmap
    .command("update <id>")
    .description("update a roadmap item's status/title/description")
    .option("--status <status>", `new status (${VALID_STATUSES.join("|")})`)
    .option("--title <title>", "new title")
    .option("--description <text>", "new description")
    .action(
      (id: string, opts: { status?: string; title?: string; description?: string }) => {
        if (opts.status) assertValidStatus(opts.status);
        const db = getDb();
        const existing = db
          .prepare("SELECT * FROM roadmap WHERE id = ?")
          .get(Number(id)) as RoadmapRow | undefined;
        if (!existing) throw new Error(`no roadmap item #${id}`);

        const row = db
          .prepare(
            `UPDATE roadmap
             SET status = ?, title = ?, description = ?, updated_at = datetime('now')
             WHERE id = ?
             RETURNING *`,
          )
          .get(
            opts.status ?? existing.status,
            opts.title ?? existing.title,
            opts.description ?? existing.description,
            Number(id),
          ) as RoadmapRow;

        printJson(row);
      },
    );
}

function assertValidStatus(status: string): asserts status is RoadmapStatus {
  if (!VALID_STATUSES.includes(status as RoadmapStatus)) {
    throw new Error(`--status must be one of: ${VALID_STATUSES.join(", ")}`);
  }
}

function parseIntOpt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`not a valid integer: ${value}`);
  return n;
}
