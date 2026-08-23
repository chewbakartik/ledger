import type { Migration } from "./types.js";

export const migration0002ProjectHerdrWorkspace: Migration = {
  version: 2,
  name: "project_herdr_workspace",
  sql: `
    -- One herdr workspace per project, not per dispatch (per the user):
    -- the first dispatch to a project creates its workspace and records
    -- the id here; every later dispatch to the same project reuses it,
    -- adding a new tab rather than a new workspace. NULL until a first
    -- dispatch happens, and re-nulled/replaced if that workspace is found
    -- closed (see src/lib/herdr.ts workspaceExists).
    ALTER TABLE projects ADD COLUMN herdr_workspace TEXT;
  `,
};
