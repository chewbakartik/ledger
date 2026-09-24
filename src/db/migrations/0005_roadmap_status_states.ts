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

    -- Backfill (2026-09-24, second revision -- supersedes an interim
    -- 'always completed' version): every existing 'done' row becomes
    -- 'in_review', not a terminal state at all, and NOT auto-classified
    -- into 'merged'/'completed'/'discarded' by any heuristic -- not from
    -- agent outcome text (superseded: a URL-shaped outcome can't tell a
    -- merged PR from an abandoned one), and, it turns out, not even from
    -- checking real git state. David ran an independent audit of ~50
    -- pre-existing 'done' items against actual git ancestry (merge-base
    -- of the branch tip against the default branch) and found it
    -- produces real false negatives on squash-merge workflows: a
    -- squash-merge lands the content as a brand-new commit on the
    -- default branch, so the original branch-tip commit never shows up
    -- as an ancestor even though the work genuinely merged. So there is
    -- no reliable automated way to tell merged / completed / still-open
    -- apart for historical 'done' rows -- not from text, not from git.
    -- 'in_review' (non-terminal) is the honest holding state: a
    -- backfilled row stays visible in roadmap list/catchup's default
    -- (non-terminal) view rather than silently landing in a terminal
    -- bucket that might be wrong, until a human reviews it and picks its
    -- real final status by hand -- the only reliable source of truth
    -- here. Every OTHER pre-existing status (planned/in_progress/
    -- blocked/dropped) passes through completely unchanged; only rows
    -- literally labeled 'done' are remapped.
    INSERT INTO roadmap_new
      (id, project_id, parent_id, title, description, status, priority, created_at, updated_at)
    SELECT
      r.id, r.project_id, r.parent_id, r.title, r.description,
      CASE WHEN r.status = 'done' THEN 'in_review' ELSE r.status END,
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
