import type { Migration } from "./types.js";

export const migration0004RoadmapPriority: Migration = {
  version: 4,
  name: "roadmap_priority",
  sql: `
    -- Roadmap item priority (DECISIONS.md, 2026-08-23, user-directed):
    -- a coarse triage rank for ordering the not-done queue at catch-up.
    -- The captain chose a coarse enum over integer rank (rank values
    -- rot as items are added and completed) and over dependency edges
    -- (readiness is already carried by status = 'blocked' + description;
    -- auto-unblock is a separate future feature). When stale, a wrong
    -- priority only mis-sorts the queue -- visible at catch-up --
    -- never silently blocking ready work the way a stale dependency
    -- edge would. NOT NULL with a default so pre-existing rows get
    -- backfilled to 'normal' by the ALTER itself.
    ALTER TABLE roadmap ADD COLUMN priority TEXT NOT NULL
      DEFAULT 'normal'
      CHECK (priority IN ('high', 'normal', 'low'));
  `,
};
