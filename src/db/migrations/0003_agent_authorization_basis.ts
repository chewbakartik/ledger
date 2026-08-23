import type { Migration } from "./types.js";

export const migration0003AgentAuthorizationBasis: Migration = {
  version: 3,
  name: "agent_authorization_basis",
  sql: `
    -- Clerk gate C6 (DECISIONS.md, 2026-08-23): every dispatch must record
    -- who authorized it. 'user-explicit' = an in-the-moment green light
    -- from the user; 'pre-authorized' = a previously granted, per-item,
    -- revocable standing latitude the clerk requested. The value is
    -- clerk-attested -- the CLI cannot know whether the user actually
    -- said yes, it only enforces that a basis is declared and recorded so
    -- every dispatch is auditable (the default is no longer "allowed").
    -- NULL only for rows predating this column; the dispatch command
    -- refuses any new row without one.
    ALTER TABLE agents ADD COLUMN authorization_basis TEXT
      CHECK (authorization_basis IS NULL
        OR authorization_basis IN ('user-explicit', 'pre-authorized'));
  `,
};
