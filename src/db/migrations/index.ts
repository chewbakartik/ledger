import { migration0001Init } from "./0001_init.js";
import type { Migration } from "./types.js";

export const migrations: Migration[] = [migration0001Init].sort(
  (a, b) => a.version - b.version,
);
