import type { Migration } from "./types.js";

export const migration0007Watches: Migration = {
  version: 7,
  name: "watches",
  sql: `
    -- Roadmap #89 (clerk follow-through): the database, not the clerk's
    -- memory, holds "what happens next" for a series of tasks. A watch names
    -- an agent and/or roadmap item, the states that should wake the clerk,
    -- and the ordered step list (a chain's length is the cap on wakes).
    -- The herdr watcher plugin matches open watches on each pane event and
    -- wakes the clerk pane, or records pending_wake=1 for the next catchup.
    -- Nothing here dispatches agents or merges anything -- see DECISIONS.md.
    CREATE TABLE watches (
      id                  INTEGER PRIMARY KEY,
      project_id          INTEGER NOT NULL REFERENCES projects(id),
      agent_id            INTEGER REFERENCES agents(id),
      roadmap_item_id     INTEGER REFERENCES roadmap(id),
      -- comma-separated subset of done|blocked|failed. blocked and failed
      -- wake the clerk regardless of this list (never proceed mechanically).
      on_states           TEXT NOT NULL DEFAULT 'done,blocked,failed',
      -- JSON array of step instructions, in order; steps[step_index] is the
      -- instruction carried by the next wake.
      steps               TEXT NOT NULL,
      step_index          INTEGER NOT NULL DEFAULT 0,
      -- 'pre-authorized' only if the human approved the whole series up
      -- front (clerk gate C6); NULL means each dispatch needs its own
      -- user-explicit green light.
      authorization_basis TEXT
        CHECK (authorization_basis IS NULL OR authorization_basis = 'pre-authorized'),
      status              TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'fired', 'expired', 'cancelled')),
      -- 1 = the trigger fired but could not be delivered to the clerk pane
      -- (see wake_reason); surfaced by 'ledger catchup'.
      pending_wake        INTEGER NOT NULL DEFAULT 0 CHECK (pending_wake IN (0, 1)),
      wake_agent_id       INTEGER REFERENCES agents(id),
      wake_state          TEXT,
      wake_outcome        TEXT,
      wake_reason         TEXT,
      wake_at             TEXT,
      -- set once the wake prompt was actually delivered to the clerk pane;
      -- the current step is then waiting on the clerk (fire/advance/rearm).
      wake_sent_at        TEXT,
      wake_count          INTEGER NOT NULL DEFAULT 0,
      pending_surfaced_at TEXT,
      expiry_surfaced_at  TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at          TEXT NOT NULL,
      fired_at            TEXT,
      updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (agent_id IS NOT NULL OR roadmap_item_id IS NOT NULL)
    );
    CREATE INDEX idx_watches_status ON watches(status);
  `,
};
