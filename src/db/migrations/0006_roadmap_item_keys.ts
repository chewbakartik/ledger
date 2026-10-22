import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

/**
 * Roadmap item #80: per-project item keys (`<CODE>-<n>`).
 *
 * Expand-only: adds columns, indexes and triggers; rebuilds no table and
 * touches no existing column, so every `roadmap.id` (and so every
 * `agents.roadmap_item_id` / `parent_id` FK) is byte-for-byte unchanged.
 *
 *  - projects.code                  short code, A-Z0-9, 2-10 chars, unique
 *  - projects.code_confirmed        0 = provisional (derived by this migration
 *                                   from the project name), 1 = confirmed
 *  - projects.roadmap_items_issued  monotonic counter: keys ever issued
 *  - roadmap.item_number / key      per-project number and `<CODE>-<n>`
 *
 * Keys are assigned by an AFTER INSERT trigger, not by CLI code, so a
 * roadmap row inserted by an OLDER ledger binary (mixed-version overlap
 * during an upgrade, or an agent mid-flight) still gets a key. Another
 * trigger makes an issued key/number immutable — EXCEPT that while a
 * project's code is still provisional (code_confirmed = 0) its keys may be
 * rewritten, which is how `project update --code` / `project codes`
 * confirm a code. Once confirmed, the code is frozen and keys are final.
 *
 * The migration is non-interactive by design (it runs on any DB open,
 * including agents and hooks): existing projects get a provisional code
 * derived from their name; the user confirms them afterwards.
 */

const SCHEMA_SQL = `
  ALTER TABLE projects ADD COLUMN code TEXT
    CHECK (code IS NULL OR (length(code) BETWEEN 2 AND 10 AND code NOT GLOB '*[^A-Z0-9]*'));
  ALTER TABLE projects ADD COLUMN code_confirmed INTEGER NOT NULL DEFAULT 1
    CHECK (code_confirmed IN (0, 1));
  ALTER TABLE projects ADD COLUMN roadmap_items_issued INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE roadmap ADD COLUMN item_number INTEGER;
  ALTER TABLE roadmap ADD COLUMN key TEXT;
`;

// Created AFTER the backfill so the backfill itself isn't fighting them.
const GUARDS_SQL = `
  CREATE UNIQUE INDEX idx_projects_code ON projects(code);
  CREATE UNIQUE INDEX idx_roadmap_key ON roadmap(key);
  CREATE UNIQUE INDEX idx_roadmap_project_item_number ON roadmap(project_id, item_number);

  CREATE TRIGGER trg_roadmap_assign_key
  AFTER INSERT ON roadmap
  WHEN NEW.key IS NULL AND (SELECT code FROM projects WHERE id = NEW.project_id) IS NOT NULL
  BEGIN
    UPDATE projects SET roadmap_items_issued = roadmap_items_issued + 1
      WHERE id = NEW.project_id;
    UPDATE roadmap SET
      item_number = (SELECT roadmap_items_issued FROM projects WHERE id = NEW.project_id),
      key = (SELECT code || '-' || roadmap_items_issued FROM projects WHERE id = NEW.project_id)
      WHERE id = NEW.id;
  END;

  CREATE TRIGGER trg_roadmap_key_immutable
  BEFORE UPDATE OF key, item_number, project_id ON roadmap
  WHEN OLD.key IS NOT NULL
   AND (NEW.item_number IS NOT OLD.item_number
        OR NEW.project_id IS NOT OLD.project_id
        OR (NEW.key IS NOT OLD.key
            AND (SELECT code_confirmed FROM projects WHERE id = OLD.project_id) = 1))
  BEGIN
    SELECT RAISE(ABORT, 'roadmap item keys are immutable once issued (only a provisional project code can be rewritten)');
  END;

  CREATE TRIGGER trg_projects_counter_monotonic
  BEFORE UPDATE OF roadmap_items_issued ON projects
  WHEN NEW.roadmap_items_issued < OLD.roadmap_items_issued
  BEGIN
    SELECT RAISE(ABORT, 'roadmap_items_issued is monotonic and never decreases');
  END;
`;

const DOWN_SQL = `
  DROP TRIGGER IF EXISTS trg_projects_counter_monotonic;
  DROP TRIGGER IF EXISTS trg_roadmap_key_immutable;
  DROP TRIGGER IF EXISTS trg_roadmap_assign_key;
  DROP INDEX IF EXISTS idx_roadmap_project_item_number;
  DROP INDEX IF EXISTS idx_roadmap_key;
  DROP INDEX IF EXISTS idx_projects_code;
  ALTER TABLE roadmap DROP COLUMN key;
  ALTER TABLE roadmap DROP COLUMN item_number;
  ALTER TABLE projects DROP COLUMN roadmap_items_issued;
  ALTER TABLE projects DROP COLUMN code_confirmed;
  ALTER TABLE projects DROP COLUMN code;
`;

/**
 * Backfill default for EXISTING projects only (new projects must pass an
 * explicit --code): the project name upper-cased, non-alphanumerics
 * stripped, clamped to 10 chars, made unique with a numeric suffix.
 * Frozen here (not imported) so the migration never drifts with the CLI.
 */
export function deriveBackfillCode(name: string, taken: ReadonlySet<string>): string {
  let base = name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  if (base.length < 2) base = (base + "PRJ").slice(0, 3);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const candidate = base.slice(0, 10 - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

function backfill(db: DatabaseSync): void {
  const projects = db.prepare("SELECT id, name, code FROM projects ORDER BY id").all() as unknown as {
    id: number;
    name: string;
    code: string | null;
  }[];
  const taken = new Set<string>(projects.flatMap((p) => (p.code ? [p.code] : [])));

  const setCode = db.prepare("UPDATE projects SET code = ?, code_confirmed = 0 WHERE id = ?");
  const setKey = db.prepare("UPDATE roadmap SET item_number = ?, key = ? WHERE id = ?");
  const setCounter = db.prepare("UPDATE projects SET roadmap_items_issued = ? WHERE id = ?");

  for (const p of projects) {
    const code = p.code ?? deriveBackfillCode(p.name, taken);
    if (!p.code) {
      taken.add(code);
      // Provisional: derived, not chosen. Rewritable until confirmed.
      setCode.run(code, p.id);
    }
    // Current id order == creation order; this is the decided numbering.
    const items = db
      .prepare("SELECT id FROM roadmap WHERE project_id = ? AND key IS NULL ORDER BY id")
      .all(p.id) as unknown as { id: number }[];
    let n = (
      db.prepare("SELECT COALESCE(MAX(item_number), 0) AS n FROM roadmap WHERE project_id = ?").get(p.id) as unknown as {
        n: number;
      }
    ).n;
    for (const item of items) {
      n += 1;
      setKey.run(n, `${code}-${n}`, item.id);
    }
    setCounter.run(n, p.id);
  }
}

/**
 * Backfill verification: throws (rolling the migration back) unless every
 * item has a well-formed, unique key numbered 1..n in id order per project,
 * every counter equals the item count, and no relationship was disturbed.
 * Also exported for `ledger db verify` (safe to re-run any time).
 */
export function verifyRoadmapKeys(db: DatabaseSync): void {
  const problems: string[] = [];
  const one = (sql: string): number => (db.prepare(sql).get() as unknown as { n: number }).n;

  const unkeyed = one("SELECT COUNT(*) AS n FROM roadmap WHERE key IS NULL OR item_number IS NULL");
  if (unkeyed) problems.push(`${unkeyed} roadmap row(s) without a key`);

  const noCode = one("SELECT COUNT(*) AS n FROM projects WHERE code IS NULL");
  if (noCode) problems.push(`${noCode} project(s) without a code`);

  // Keys are immutable, so the CURRENT project code may differ from an old
  // key's prefix; only the shape and the trailing number are invariant.
  const badKey = one(
    `SELECT COUNT(*) AS n FROM roadmap
     WHERE key IS NOT NULL AND (key NOT LIKE '%-' || item_number OR key GLOB '*[^A-Z0-9-]*')`,
  );
  if (badKey) problems.push(`${badKey} key(s) are malformed or don't end in their item_number`);

  // Per project: numbers are exactly 1..n in id order, counter >= n.
  const rows = db
    .prepare("SELECT project_id, id, item_number FROM roadmap WHERE item_number IS NOT NULL ORDER BY project_id, id")
    .all() as unknown as { project_id: number; id: number; item_number: number }[];
  const seen = new Map<number, number>();
  for (const r of rows) {
    const expected = (seen.get(r.project_id) ?? 0) + 1;
    seen.set(r.project_id, expected);
    if (r.item_number !== expected) {
      problems.push(`project ${r.project_id}: item row ${r.id} has number ${r.item_number}, expected ${expected} (id order)`);
      break;
    }
  }
  const counters = db.prepare("SELECT id, roadmap_items_issued AS c FROM projects").all() as unknown as {
    id: number;
    c: number;
  }[];
  for (const p of counters) {
    const n = seen.get(p.id) ?? 0;
    if (p.c < n) problems.push(`project ${p.id}: counter ${p.c} is below its ${n} issued item(s)`);
  }

  const dangling =
    one("SELECT COUNT(*) AS n FROM agents WHERE roadmap_item_id IS NOT NULL AND roadmap_item_id NOT IN (SELECT id FROM roadmap)") +
    one("SELECT COUNT(*) AS n FROM roadmap WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM roadmap)");
  if (dangling) problems.push(`${dangling} dangling item reference(s) (agents.roadmap_item_id / parent_id)`);

  if (problems.length > 0) {
    throw new Error(`roadmap key verification failed: ${problems.join("; ")}`);
  }
}

export const migration0006RoadmapItemKeys: Migration = {
  version: 6,
  name: "roadmap_item_keys",
  sql: SCHEMA_SQL,
  apply: (db) => {
    backfill(db);
    db.exec(GUARDS_SQL);
  },
  verify: verifyRoadmapKeys,
  down: DOWN_SQL,
};
