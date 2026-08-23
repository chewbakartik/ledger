import { migration0001Init } from "./0001_init.js";
import { migration0002ProjectHerdrWorkspace } from "./0002_project_herdr_workspace.js";
import type { Migration } from "./types.js";

export const migrations: Migration[] = [
  migration0001Init,
  migration0002ProjectHerdrWorkspace,
].sort((a, b) => a.version - b.version);
