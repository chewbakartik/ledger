import type { Migration } from "./types.js";

export const migration0005RoadmapStatusStates: Migration = {
  version: 5,
  name: "roadmap_status_states",
  sql: `
    -- Roadmap #89 (2026-09-24): split the old, overloaded bare 'done'
    -- into precise terminal states, plus a non-terminal 'in_review'
    -- (code up, PR/MR open, waiting on a human). See RoadmapStatus in
    -- src/db/types.ts for the full status vocabulary and the
    -- observation-required constraint on 'merged'/'discarded'.
    --
    -- SQLite has no ALTER ... DROP/ADD CONSTRAINT for a CHECK, so
    -- widening the status enum means rebuilding the table under its old
    -- name (sqlite.org/lang_altertable.html's documented recreate
    -- pattern) -- safe here because the migration runner (src/db/
    -- client.ts) disables foreign_keys around the whole batch of pending
    -- migrations specifically so a drop+rename like this one doesn't
    -- trip over agents.roadmap_item_id's live references to this table.

    CREATE TABLE roadmap_new (
      id            INTEGER PRIMARY KEY,
      project_id    INTEGER NOT NULL REFERENCES projects(id),
      parent_id     INTEGER REFERENCES roadmap(id),
      title         TEXT NOT NULL,
      description   TEXT,
      status        TEXT NOT NULL DEFAULT 'planned'
                      CHECK (status IN (
                        'planned', 'in_progress', 'blocked', 'in_review',
                        'merged', 'completed', 'discarded', 'dropped'
                      )),
      priority      TEXT NOT NULL DEFAULT 'normal'
                      CHECK (priority IN ('high', 'normal', 'low')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Backfill: every existing 'done' row must land on one of the two new
    -- terminal states that actually replace it, never fall through as an
    -- invalid/orphaned value. Heuristic (roadmap #89's spec): a 'done'
    -- item becomes 'merged' if any agent dispatched against it recorded
    -- an outcome that looks like a PR/MR URL -- the shape LEDGER.md's own
    -- dispatch contract asks agents to report (ledger agent update <id>
    -- --status done --outcome '<pr-url>').
    -- Everything else -- including items with no agent at all, e.g. a
    -- decision or investigation that never produced a git artifact --
    -- falls back to 'completed', per the item's explicit "fall back to
    -- completed if genuinely ambiguous" instruction. This is a one-time,
    -- best-effort backfill, not a durable observation under the new
    -- observation-required rule; a clerk who has reason to doubt a
    -- specific backfilled row should re-verify and correct it by hand.
    INSERT INTO roadmap_new
      (id, project_id, parent_id, title, description, status, priority, created_at, updated_at)
    SELECT
      r.id, r.project_id, r.parent_id, r.title, r.description,
      CASE
        WHEN r.status = 'done' AND EXISTS (
          SELECT 1 FROM agents a
          WHERE a.roadmap_item_id = r.id
            AND a.outcome IS NOT NULL
            AND (
              a.outcome LIKE '%/pull/%'
              OR a.outcome LIKE '%/pulls/%'
              OR a.outcome LIKE '%/merge_requests/%'
              OR a.outcome LIKE '%/pr/%'
            )
        ) THEN 'merged'
        WHEN r.status = 'done' THEN 'completed'
        ELSE r.status
      END,
      r.priority, r.created_at, r.updated_at
    FROM roadmap r;

    DROP TABLE roadmap;
    ALTER TABLE roadmap_new RENAME TO roadmap;

    -- DROP TABLE roadmap took the original indexes with it; recreate them
    -- on the rebuilt table (migration 0001).
    CREATE INDEX idx_roadmap_project ON roadmap(project_id);
    CREATE INDEX idx_roadmap_parent ON roadmap(parent_id);
  `,
};
