import { Command } from "commander";
import { getDb } from "../../db/client.js";
import type { FirstClerkRow } from "../../db/types.js";
import * as herdr from "../../lib/herdr.js";
import { printJson } from "../format.js";

const STALE_AFTER_HOURS = 12;

export function registerClerkCommands(program: Command): void {
  const clerk = program.command("clerk").description("first-clerk authority (single row)");

  clerk
    .command("claim")
    .description(
      "claim first-clerk authority. Fails if another claim is active and not " +
        "stale, unless --force is given",
    )
    .requiredOption("--session-id <id>", "this clerk session's id")
    .requiredOption("--herdr-pane <id>", "this clerk's own herdr pane id")
    .option("--force", "claim even if the existing claim is not stale")
    .action((opts: { sessionId: string; herdrPane: string; force?: boolean }) => {
      const db = getDb();
      const existing = db
        .prepare("SELECT * FROM first_clerk WHERE id = 1")
        .get() as FirstClerkRow | undefined;

      if (existing && !opts.force && !isStale(existing)) {
        throw new Error(
          `first_clerk is already claimed by session ${existing.session_id} ` +
            `(pane ${existing.herdr_pane}, claimed ${existing.claimed_at}). ` +
            `Pass --force to override.`,
        );
      }

      const row = db
        .prepare(
          `INSERT INTO first_clerk (id, session_id, herdr_pane, claimed_at)
           VALUES (1, ?, ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET
             session_id = excluded.session_id,
             herdr_pane = excluded.herdr_pane,
             claimed_at = excluded.claimed_at,
             last_seen = NULL
           RETURNING *`,
        )
        .get(opts.sessionId, opts.herdrPane) as FirstClerkRow;

      // The claim is durable now; the rename below is cosmetic only.
      renameClaimantWorkspace(opts.herdrPane);

      printJson(row);
    });

  clerk
    .command("status")
    .description("show the current first-clerk claim, if any")
    .action(() => {
      const row = getDb()
        .prepare("SELECT * FROM first_clerk WHERE id = 1")
        .get() as FirstClerkRow | undefined;
      printJson(row ?? null);
    });
}

function isStale(row: FirstClerkRow): boolean {
  const claimedAt = new Date(row.claimed_at + "Z").getTime();
  const ageHours = (Date.now() - claimedAt) / (1000 * 60 * 60);
  return ageHours > STALE_AFTER_HOURS;
}

const CLERK_WORKSPACE_LABEL = "clerk";

/**
 * Renames the claimant's own herdr workspace to "clerk" (roadmap item 17):
 * a clerk session started in a project folder otherwise gets a workspace
 * label identical to that project's agent workspaces, and the user can't
 * tell at a glance which workspace is the clerk. Pane ids look like
 * "w3:p1", so the workspace id is the part before the colon.
 *
 * Idempotent: a no-op if the label is already "clerk". Only the
 * claimant's own workspace is ever addressed — its id comes solely from
 * the claimant's own --herdr-pane. Never fails the claim: on any error
 * (workspace gone, herdr unreachable, ...) a warning goes to stderr and
 * the claim stands. Known limitation (accepted for now): during a --force
 * handover the previous claimant's workspace keeps the "clerk" label until
 * it is renamed again; this function never touches workspaces it wasn't
 * given.
 */
function renameClaimantWorkspace(herdrPane: string): void {
  const sep = herdrPane.indexOf(":");
  const workspaceId = sep > 0 ? herdrPane.slice(0, sep) : undefined;
  if (!workspaceId) {
    console.error(
      `Warning: clerk claim succeeded, but the herdr pane "${herdrPane}" ` +
        `has no "<workspace>:" prefix, so its workspace cannot be renamed ` +
        `to "${CLERK_WORKSPACE_LABEL}".`,
    );
    return;
  }
  try {
    const ws = herdr.getWorkspace(workspaceId, { quiet: true });
    if (ws.label === CLERK_WORKSPACE_LABEL) return; // idempotent
    herdr.renameWorkspace(ws.workspace_id, CLERK_WORKSPACE_LABEL);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `Warning: clerk claim succeeded, but renaming workspace ` +
        `"${workspaceId}" to "${CLERK_WORKSPACE_LABEL}" failed: ${msg}`,
    );
  }
}
