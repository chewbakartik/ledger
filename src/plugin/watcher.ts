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
import type { AgentRow, AgentStatus } from "../db/types.js";

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
    .get(event.pane_id) as AgentRow | undefined;

  if (!agentRow) {
    // This pane isn't one ledger dispatched (e.g. the clerk's own pane).
    process.exit(0);
  }

  db.prepare(
    `INSERT INTO events (agent_id, event_type, payload) VALUES (?, 'state_change', ?)`,
  ).run(agentRow.id, JSON.stringify(event));

  // herdr's AgentStatus includes "unknown", which ledger's durable status
  // field does not — an unknown reading is usually transient detection
  // noise, so it's logged above but doesn't overwrite the last known status.
  if (event.agent_status !== "unknown") {
    db.prepare(
      `UPDATE agents SET status = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(event.agent_status, agentRow.id);
  }
}

try {
  main();
} catch (err) {
  console.error(`ledger watcher error: ${(err as Error).message}`);
  process.exit(1);
}
