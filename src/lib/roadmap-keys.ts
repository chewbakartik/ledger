import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db/client.js";
import type { AgentRow, ProjectRow, RoadmapRow } from "../db/types.js";

/** Roadmap #80 decision (a): A-Z0-9, 2-10 chars. */
export const PROJECT_CODE_RE = /^[A-Z0-9]{2,10}$/;
const KEY_RE = /^[A-Z0-9]{2,10}-\d+$/;
const NUMERIC_ALIAS_RE = /^#?(\d+)$/;

/** Upper-cases and validates a project short code; throws a user-facing error. */
export function normalizeProjectCode(input: string): string {
  const code = input.trim().toUpperCase();
  if (!PROJECT_CODE_RE.test(code)) {
    throw new Error(`--code must be 2-10 characters, A-Z and 0-9 only (got "${input}")`);
  }
  return code;
}

/** Throws unless `code` is free (`ownProjectId` = the project being updated, if any). */
export function assertProjectCodeAvailable(
  code: string,
  ownProjectId?: number,
  db: DatabaseSync = getDb(),
): void {
  const holder = db
    .prepare("SELECT name FROM projects WHERE code = ? AND id IS NOT ?")
    .get(code, ownProjectId ?? null) as unknown as { name: string } | undefined;
  if (holder) throw new Error(`code ${code} is already used by project "${holder.name}"`);
}

export type CodeChange = {
  project: string;
  from: string | null;
  to: string;
  keys_rewritten: number;
  confirmed: true;
};

/**
 * Sets (and thereby CONFIRMS) a project's code, in one transaction.
 *
 *  - provisional project (code_confirmed = 0): its existing keys are
 *    rewritten to the new code (numbers unchanged); same code = just confirm.
 *  - confirmed project: the code is frozen — refused, since issued keys are
 *    immutable and a second prefix would split the project's keys.
 *  - project with no code at all (inserted by an older binary after the
 *    migration): assigns it and keys any unkeyed items in id order.
 */
export function setProjectCode(
  project: ProjectRow,
  rawCode: string,
  db: DatabaseSync = getDb(),
): CodeChange {
  const code = normalizeProjectCode(rawCode);
  if (project.code !== null && project.code_confirmed === 1) {
    if (code === project.code) {
      return { project: project.name, from: code, to: code, keys_rewritten: 0, confirmed: true };
    }
    throw new Error(
      `project "${project.name}"'s code ${project.code} is confirmed and frozen — ` +
        `issued keys are immutable, so it can't change to ${code}`,
    );
  }
  assertProjectCodeAvailable(code, project.id, db);

  let rewritten = 0;
  db.exec("BEGIN");
  try {
    if (project.code !== null && code !== project.code) {
      rewritten = Number(
        db
          .prepare("UPDATE roadmap SET key = ? || '-' || item_number WHERE project_id = ? AND key IS NOT NULL")
          .run(code, project.id).changes,
      );
    }
    db.prepare("UPDATE projects SET code = ?, code_confirmed = 1 WHERE id = ?").run(code, project.id);
    if (project.code === null) {
      const unkeyed = db
        .prepare("SELECT id FROM roadmap WHERE project_id = ? AND key IS NULL ORDER BY id")
        .all(project.id) as unknown as { id: number }[];
      for (const item of unkeyed) {
        db.prepare("UPDATE projects SET roadmap_items_issued = roadmap_items_issued + 1 WHERE id = ?").run(project.id);
        db.prepare(
          `UPDATE roadmap SET item_number = (SELECT roadmap_items_issued FROM projects WHERE id = ?),
             key = ? || '-' || (SELECT roadmap_items_issued FROM projects WHERE id = ?) WHERE id = ?`,
        ).run(project.id, code, project.id, item.id);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { project: project.name, from: project.code, to: code, keys_rewritten: rewritten, confirmed: true };
}

export interface ProvisionalProject {
  name: string;
  code: string;
  items: number;
}

/** Projects whose short code is still provisional (migration-derived, unconfirmed). */
export function provisionalProjects(db: DatabaseSync = getDb()): ProvisionalProject[] {
  return db
    .prepare(
      `SELECT p.name, p.code, (SELECT COUNT(*) FROM roadmap r WHERE r.project_id = p.id) AS items
       FROM projects p WHERE p.code IS NOT NULL AND p.code_confirmed = 0 ORDER BY p.id`,
    )
    .all() as unknown as ProvisionalProject[];
}

/** One-line nudge for catchup/update, or null when nothing is provisional. */
export function provisionalCodesNotice(db: DatabaseSync = getDb()): string | null {
  const n = provisionalProjects(db).length;
  if (n === 0) return null;
  return (
    `Notice: ${n} project${n === 1 ? " has a" : "s have"} provisional roadmap-key code${n === 1 ? "" : "s"} ` +
    `(derived from the project name; changing one still rewrites that project's keys). ` +
    `Run 'ledger project codes' to confirm them, or 'ledger project update <name> --code X'.`
  );
}

let noticeShown = false;

function numericAliasNotice(id: number, key: string | null): void {
  if (process.env["LEDGER_STRICT_ITEM_KEYS"] === "1") {
    throw new Error(
      `bare numeric roadmap ids are no longer accepted (LEDGER_STRICT_ITEM_KEYS=1)` +
        (key ? ` — use ${key}` : ""),
    );
  }
  if (noticeShown) return;
  noticeShown = true;
  console.error(
    `Deprecated: bare numeric roadmap item ids are being phased out` +
      (key ? ` — use the item key ${key} instead of ${id}.` : ".") +
      ` (stderr only; stdout is unaffected.)`,
  );
}

/**
 * Resolves a user-supplied roadmap item reference to its row: a key
 * (`LEDGER-80`, case-insensitive) — or, as a DEPRECATED alias during the
 * transition, a bare numeric id (`80` / `#80`), which still works but prints
 * a one-line notice to stderr naming the key to use. Keys resolve by their
 * stored value, so an old key keeps working after its project's code is
 * changed.
 */
export function resolveRoadmapRef(ref: string, db: DatabaseSync = getDb()): RoadmapRow {
  const trimmed = ref.trim();
  const upper = trimmed.toUpperCase();

  if (KEY_RE.test(upper)) {
    const row = db.prepare("SELECT * FROM roadmap WHERE key = ?").get(upper) as unknown as
      | RoadmapRow
      | undefined;
    if (!row) throw new Error(`no roadmap item ${upper}`);
    return row;
  }

  const numeric = NUMERIC_ALIAS_RE.exec(trimmed);
  if (numeric) {
    const id = Number(numeric[1]);
    const row = db.prepare("SELECT * FROM roadmap WHERE id = ?").get(id) as unknown as
      | RoadmapRow
      | undefined;
    // Note the deliberate asymmetry: a missing numeric id is reported
    // without echoing a global number back as if it were a handle.
    if (!row) throw new Error(`no roadmap item "${ref}" (expected a key like LEDGER-12)`);
    numericAliasNotice(id, row.key);
    return row;
  }

  throw new Error(`"${ref}" is not a roadmap item key (expected e.g. LEDGER-12)`);
}

export function keyForItemId(id: number | null, db: DatabaseSync = getDb()): string | null {
  if (id === null) return null;
  const row = db.prepare("SELECT key FROM roadmap WHERE id = ?").get(id) as unknown as
    | { key: string | null }
    | undefined;
  return row?.key ?? null;
}

export interface PresentedRoadmapItem {
  key: string | null;
  parent_key: string | null;
  project_id: number;
  title: string;
  description: string | null;
  status: RoadmapRow["status"];
  priority: RoadmapRow["priority"];
  created_at: string;
  updated_at: string;
}

/** User-facing shape of a roadmap row: key-first, with the internal `id`/`parent_id` PKs withheld. */
export function presentRoadmap(row: RoadmapRow, db: DatabaseSync = getDb()): PresentedRoadmapItem {
  return {
    key: row.key,
    parent_key: keyForItemId(row.parent_id, db),
    project_id: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export type PresentedAgent = Omit<AgentRow, "roadmap_item_id"> & { roadmap_item: string | null };

/** User-facing shape of an agents row: `roadmap_item_id` (a global number) becomes `roadmap_item` (its key). */
export function presentAgent(row: AgentRow, db: DatabaseSync = getDb()): PresentedAgent {
  const { roadmap_item_id, ...rest } = row;
  return { ...rest, roadmap_item: keyForItemId(roadmap_item_id, db) };
}
