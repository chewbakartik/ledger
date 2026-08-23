import type { Migration } from "./types.js";

export const migration0001Init: Migration = {
  version: 1,
  name: "init",
  sql: `
    CREATE TABLE projects (
      id                INTEGER PRIMARY KEY,
      name              TEXT NOT NULL UNIQUE,
      repo_url          TEXT,  -- NULL for a from-scratch project (ledger project init): no origin exists yet
      local_clone_path  TEXT NOT NULL,
      default_branch    TEXT NOT NULL,
      delivery_mode     TEXT NOT NULL DEFAULT 'direct-pr'
                          CHECK (delivery_mode IN ('direct-pr', 'local-only')),
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE roadmap (
      id            INTEGER PRIMARY KEY,
      project_id    INTEGER NOT NULL REFERENCES projects(id),
      parent_id     INTEGER REFERENCES roadmap(id),
      title         TEXT NOT NULL,
      description   TEXT,
      status        TEXT NOT NULL DEFAULT 'planned'
                      CHECK (status IN ('planned', 'in_progress', 'blocked', 'done', 'dropped')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_roadmap_project ON roadmap(project_id);
    CREATE INDEX idx_roadmap_parent ON roadmap(parent_id);

    CREATE TABLE agents (
      id                INTEGER PRIMARY KEY,
      project_id        INTEGER NOT NULL REFERENCES projects(id),
      roadmap_item_id   INTEGER REFERENCES roadmap(id),
      task_description  TEXT NOT NULL,
      worktree_path     TEXT NOT NULL,
      herdr_workspace   TEXT NOT NULL,
      herdr_tab         TEXT NOT NULL,
      herdr_pane        TEXT NOT NULL,
      coding_agent      TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'working'
                          CHECK (status IN ('blocked', 'working', 'done', 'idle')),
      outcome           TEXT,
      spawned_by        INTEGER REFERENCES agents(id),
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_agents_project ON agents(project_id);
    CREATE INDEX idx_agents_status ON agents(status);
    CREATE INDEX idx_agents_herdr_pane ON agents(herdr_pane);

    CREATE TABLE events (
      id          INTEGER PRIMARY KEY,
      agent_id    INTEGER NOT NULL REFERENCES agents(id),
      event_type  TEXT NOT NULL,
      payload     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_events_agent ON events(agent_id);
    CREATE INDEX idx_events_created_at ON events(created_at);

    CREATE TABLE first_clerk (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      session_id    TEXT NOT NULL,
      herdr_pane    TEXT NOT NULL,
      claimed_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen     TEXT
    );
  `,
};
