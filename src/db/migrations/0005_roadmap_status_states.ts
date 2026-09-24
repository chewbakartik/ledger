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

    -- Backfill: every existing 'done' row must land on one of the new
    -- terminal states, never fall through as an invalid/orphaned value.
    -- All of them become 'completed', with no exceptions -- not 'merged'
    -- (2026-09-24 review decision, roadmap #89 PR #21): an outcome that
    -- merely *looks like* a PR/MR URL (the shape LEDGER.md's dispatch
    -- contract asks agents to report -- ledger agent update <id>
    -- --status done --outcome '<pr-url>') is not evidence the PR was
    -- actually merged rather than opened-then-abandoned or opened-then-
    -- closed unmerged -- there is no way to check that from historical
    -- data alone. Claiming 'merged' for any backfilled row would
    -- overclaim something unverified, which is exactly what the
    -- observation-required constraint on 'merged'/'discarded' exists to
    -- prevent. 'completed' makes no git-landed claim either way -- just
    -- that the item is done and no longer active -- so it's the honest
    -- default when the historical data can't actually be checked. A
    -- clerk who has reason to believe a specific backfilled row really
    -- did merge should re-verify it against git/the PR host and correct
    -- it by hand, per that same observation-required rule.
    INSERT INTO roadmap_new
      (id, project_id, parent_id, title, description, status, priority, created_at, updated_at)
    SELECT
      r.id, r.project_id, r.parent_id, r.title, r.description,
      CASE
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
