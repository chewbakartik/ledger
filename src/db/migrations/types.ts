import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  /** Forward DDL/DML, run first, inside the migration's transaction. */
  sql: string;
  /**
   * Optional procedural step run after `sql`, in the same transaction — for
   * backfills that need real code (e.g. deriving values SQL can't).
   */
  apply?: (db: DatabaseSync) => void;
  /**
   * Optional post-condition check, run after `sql`/`apply` and still inside
   * the transaction: throwing rolls the whole migration back, so a bad
   * backfill can never be committed (and recorded in schema_migrations).
   */
  verify?: (db: DatabaseSync) => void;
  /**
   * Optional reverse DDL/DML (see `rollbackTo` in src/db/client.ts). A
   * migration without one is forward-only and refuses to be rolled back.
   */
  down?: string;
}
