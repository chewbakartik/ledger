#!/usr/bin/env node
/**
 * herdr event-hook entrypoint, registered in herdr-plugin.toml against the
 * `pane.agent_status_changed` event hook. Not a daemon: herdr invokes this
 * once per event and it exits. If herdr isn't running, this never fires —
 * which is correct, since no agents can be running either (see DESIGN.md).
 *
 * Payload shape confirmed empirically (not documented): herdr wraps the
 * event as `{ event: "pane_agent_status_changed", data: {...} }` — an
 * underscored `event` name even though the manifest's `on` field is dotted
 * (`pane.agent_status_changed`), with the actual fields nested under `data`,
 * not flat. See DECISIONS.md.
 */
import { getDb } from "../db/client.js";
import type { AgentRow, AgentStatus, FirstClerkRow } from "../db/types.js";
import {
  claimMatchingWatches,
  deliverWake,
  flushablePendingWakes,
  recordDelivery,
  wakeMessage,
  wakeStateOf,
} from "../lib/watches.js";

interface PaneAgentStatusChangedData {
  type: "pane_agent_status_changed";
  pane_id: string;
  workspace_id: string;
  agent: string | null;
  agent_status: AgentStatus | "unknown";
}

interface HerdrPluginEventEnvelope {
  event: string;
  data: PaneAgentStatusChangedData;
}

function main(): void {
  const raw = process.env["HERDR_PLUGIN_EVENT_JSON"];
  if (!raw) {
    // Not invoked as an event hook (e.g. run manually without the env var).
    process.exit(0);
  }

  const envelope = JSON.parse(raw) as HerdrPluginEventEnvelope;
  const event = envelope.data;
  if (!event?.pane_id || !event.agent_status) {
    process.exit(0);
  }

  const db = getDb();
  const agentRow = db
    .prepare(
      "SELECT * FROM agents WHERE herdr_pane = ? ORDER BY id DESC LIMIT 1",
    )
    .get(event.pane_id) as unknown as AgentRow | undefined;

  if (!agentRow) {
    // This pane isn't one ledger dispatched (e.g. the clerk's own pane).
    // Roadmap #89: but if it IS the clerk's pane settling to idle/done, any
    // wake that couldn't land earlier because the clerk was mid-turn can
    // now be delivered -- still event-driven, nothing polls.
    flushPendingWakesIfClerkSettled(event);
    process.exit(0);
  }

  db.prepare(
    `INSERT INTO events (agent_id, event_type, payload) VALUES (?, 'state_change', ?)`,
  ).run(agentRow.id, JSON.stringify(event));

  // herdr's AgentStatus includes "unknown", which ledger's durable status
  // field does not — an unknown reading is usually transient detection
  // noise, so it's logged above but doesn't overwrite the last known status.
  //
  // `done` and `blocked` are terminal for this row while the row sits in
  // them. Confirmed live (see DECISIONS.md): herdr keeps reporting pane
  // activity after a self-reported `done` — e.g. the `agent update`
  // command itself finishing causes the pane to settle back to `idle` a
  // moment later — which would otherwise silently clobber a just-recorded
  // completion back to `idle`. A self-reported `blocked` needs the same
  // protection (A3): the agent is meaningfully waiting on a decision, and
  // a late blip — often the very `agent update` that recorded the block
  // settling the pane — must not decay it to `idle` on the board. A
  // dispatch's row/pane/tab is never reused for a different task, so
  // there's no real "back to working" transition this could be losing:
  // leaving either state is always an explicit act (a fresh `agent
  // update`), never a watcher blip.
  const terminal: AgentStatus[] = ["done", "blocked"];
  if (event.agent_status !== "unknown" && !terminal.includes(agentRow.status)) {
    db.prepare(
      `UPDATE agents SET status = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(event.agent_status, agentRow.id);
  }

  wakeClerkForWatches(agentRow.id);
}

function loadClerk(): FirstClerkRow | undefined {
  return getDb().prepare("SELECT * FROM first_clerk WHERE id = 1").get() as unknown as
    | FirstClerkRow
    | undefined;
}

/**
 * Roadmap #89: if the agent is now in a wake-worthy durable state
 * (done / blocked / done-with-a-failure-outcome), claim every matching open
 * watch and wake the clerk pane once for the batch -- or leave a pending
 * wake for `ledger catchup` when the clerk can't take it. This only reads
 * and updates watches; it never creates one, never dispatches an agent and
 * never merges anything -- the woken clerk decides what happens next.
 */
function wakeClerkForWatches(agentId: number): void {
  const db = getDb();
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as unknown as AgentRow;
  const state = wakeStateOf(agent);
  if (!state) return;

  const claimed = claimMatchingWatches(db, agent, state);
  if (claimed.length === 0) return;

  recordDelivery(db, claimed, deliverWake(loadClerk(), wakeMessage(claimed, db)));
}

function flushPendingWakesIfClerkSettled(event: PaneAgentStatusChangedData): void {
  if (event.agent_status !== "idle" && event.agent_status !== "done") return;
  const clerk = loadClerk();
  if (!clerk || clerk.herdr_pane !== event.pane_id) return;

  const db = getDb();
  const pending = flushablePendingWakes(db);
  if (pending.length === 0) return;
  recordDelivery(db, pending, deliverWake(clerk, wakeMessage(pending, db)));
}

try {
  main();
} catch (err) {
  console.error(`ledger watcher error: ${(err as Error).message}`);
  process.exit(1);
}
