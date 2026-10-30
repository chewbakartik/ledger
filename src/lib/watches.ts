/**
 * Roadmap #89: shared watch logic, used by the watcher plugin (matching +
 * wake delivery), `ledger watch`, and `ledger catchup`. Everything here is
 * event-driven and one-shot: no timers, no standing process. It never
 * creates a watch, never dispatches an agent, never merges anything.
 */
import type { DatabaseSync } from "node:sqlite";
import type { AgentRow, FirstClerkRow, WatchRow, WatchTrigger } from "../db/types.js";
import { WATCH_TRIGGERS } from "../db/types.js";
import * as herdr from "./herdr.js";

/** Tries for a transient `agent_pane_busy` before giving up to a pending wake. */
const WAKE_BUSY_RETRIES = 3;
const WAKE_BUSY_RETRY_INTERVAL_MS = 500;

const MESSAGE_FIELD_MAX = 300;

export function parseSteps(watch: WatchRow): string[] {
  return JSON.parse(watch.steps) as string[];
}

export function currentStep(watch: WatchRow): string {
  return parseSteps(watch)[watch.step_index] ?? "";
}

/** A watch row plus its decoded step list, for CLI/JSON output. */
export function presentWatch(watch: WatchRow): WatchRow & {
  steps_list: string[];
  next_step: string;
} {
  return { ...watch, steps_list: parseSteps(watch), next_step: currentStep(watch) };
}

export function parseTriggers(text: string): WatchTrigger[] {
  const parts = text
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const bad = parts.filter((p) => !WATCH_TRIGGERS.includes(p as WatchTrigger));
  if (parts.length === 0 || bad.length > 0) {
    throw new Error(`--on must be a comma list of: ${WATCH_TRIGGERS.join(" | ")}`);
  }
  return [...new Set(parts)] as WatchTrigger[];
}

/**
 * Heuristic: did a `done` agent report a failure? Errs towards flagging —
 * a false positive just labels a wake "failed" so the clerk reads the
 * outcome carefully; a false negative would let a failure look routine.
 * A bare URL (the usual PR outcome) is never a failure report.
 */
export function outcomeLooksFailed(outcome: string | null): boolean {
  if (!outcome) return false;
  if (/^https?:\/\/\S+$/.test(outcome.trim())) return false;
  return /\b(fail(ed|ure|ing|s)?|error(s|ed)?|partial(ly)?|incomplete|unable|could not|couldn't|did not|didn't|not done|aborted|crash(ed)?)\b/i.test(
    outcome,
  );
}

/**
 * The wake-worthy state an agent row is in, or null. Only the durable,
 * self-reported terminal statuses count (a transient pane blip is not a
 * finished step).
 */
export function wakeStateOf(agent: AgentRow): WatchTrigger | null {
  if (agent.status === "blocked") return "blocked";
  if (agent.status === "done") return outcomeLooksFailed(agent.outcome) ? "failed" : "done";
  return null;
}

/** Lazily expire due watches; every entry point calls this instead of a timer. */
export function expireDueWatches(db: DatabaseSync): void {
  db.prepare(
    `UPDATE watches SET status = 'expired', updated_at = datetime('now')
     WHERE status = 'open' AND expires_at <= datetime('now')`,
  ).run();
}

/**
 * Claims (atomically, via pending_wake = 1) every open, un-woken, unexpired
 * watch matching this agent and state. blocked/failed always match; `done`
 * only if the watch lists it. Concurrent watcher processes can't both claim
 * the same watch.
 */
export function claimMatchingWatches(
  db: DatabaseSync,
  agent: AgentRow,
  state: WatchTrigger,
): WatchRow[] {
  expireDueWatches(db);
  const candidates = db
    .prepare(
      `SELECT * FROM watches
       WHERE status = 'open' AND pending_wake = 0 AND wake_sent_at IS NULL
         AND expires_at > datetime('now')
         AND (agent_id = ? OR (agent_id IS NULL AND roadmap_item_id = ?))`,
    )
    .all(agent.id, agent.roadmap_item_id ?? -1) as unknown as WatchRow[];

  const claimed: WatchRow[] = [];
  for (const w of candidates) {
    const wants = state !== "done" || w.on_states.split(",").includes("done");
    if (!wants) continue;
    const row = db
      .prepare(
        `UPDATE watches
         SET pending_wake = 1, wake_agent_id = ?, wake_state = ?, wake_outcome = ?,
             wake_at = datetime('now'), wake_reason = NULL, updated_at = datetime('now')
         WHERE id = ? AND status = 'open' AND pending_wake = 0 AND wake_sent_at IS NULL
         RETURNING *`,
      )
      .get(agent.id, state, agent.outcome, w.id) as unknown as WatchRow | undefined;
    if (row) claimed.push(row);
  }
  return claimed;
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** One short line per watch; several are joined into a single prompt. */
export function wakeMessage(watches: WatchRow[]): string {
  const parts = watches.map((w) => {
    const steps = parseSteps(w);
    const policy =
      w.wake_state === "done"
        ? ""
        : ` Step ${w.wake_state}: do NOT proceed mechanically; read it and escalate or decide.`;
    const auth = w.authorization_basis ? " [series pre-authorized by the human]" : "";
    return (
      `watch #${w.id}: agent #${w.wake_agent_id} is ${w.wake_state}` +
      ` (outcome: ${clip(w.wake_outcome ?? "none reported", MESSAGE_FIELD_MAX)}).` +
      ` Step ${w.step_index + 1}/${steps.length}: ${clip(steps[w.step_index] ?? "", MESSAGE_FIELD_MAX)}${auth}.${policy}` +
      ` Run: ledger watch get ${w.id}`
    );
  });
  return `[ledger wake] ${parts.join(" | ")}`;
}

export type WakeFailureReason =
  | "clerk_unclaimed"
  | "clerk_pane_gone"
  | "clerk_not_claude"
  | "clerk_busy"
  | "herdr_unreachable"
  | "prompt_failed";

/**
 * Tries to deliver a wake prompt to the first clerk's pane. Returns null on
 * success, or the reason it could not be delivered (the caller records a
 * pending wake). Never sends anything unless the pane is verifiably a live
 * Claude agent that is idle/done — never into a bare shell, never into a
 * clerk that is mid-turn.
 */
export function deliverWake(
  clerk: FirstClerkRow | undefined,
  text: string,
): WakeFailureReason | null {
  if (!clerk) return "clerk_unclaimed";

  let pane: herdr.HerdrPaneInfo;
  try {
    pane = herdr.getPane(clerk.herdr_pane, { quiet: true });
  } catch (err) {
    return err instanceof herdr.HerdrError ? "clerk_pane_gone" : "herdr_unreachable";
  }
  if (pane.agent !== "claude") return "clerk_not_claude";
  if (pane.agent_status !== "idle" && pane.agent_status !== "done") return "clerk_busy";

  for (let attempt = 1; ; attempt++) {
    try {
      herdr.promptAgent({ target: clerk.herdr_pane, text });
      return null;
    } catch (err) {
      const code = err instanceof herdr.HerdrError ? err.code : undefined;
      if (code === "agent_pane_busy" && attempt < WAKE_BUSY_RETRIES) {
        herdr.sleepSync(WAKE_BUSY_RETRY_INTERVAL_MS);
        continue;
      }
      if (code === "agent_pane_busy" || code === "agent_blocked") return "clerk_busy";
      return code ? "prompt_failed" : "herdr_unreachable";
    }
  }
}

/** Records the outcome of a delivery attempt on every watch in the batch. */
export function recordDelivery(
  db: DatabaseSync,
  watches: WatchRow[],
  failure: WakeFailureReason | null,
): void {
  for (const w of watches) {
    if (failure === null) {
      db.prepare(
        `UPDATE watches
         SET pending_wake = 0, wake_reason = NULL, wake_sent_at = datetime('now'),
             wake_count = wake_count + 1, updated_at = datetime('now')
         WHERE id = ?`,
      ).run(w.id);
    } else {
      db.prepare(
        `UPDATE watches SET pending_wake = 1, wake_reason = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).run(failure, w.id);
    }
    if (w.wake_agent_id !== null) {
      db.prepare(
        `INSERT INTO events (agent_id, event_type, payload) VALUES (?, 'watch_wake', ?)`,
      ).run(
        w.wake_agent_id,
        JSON.stringify({
          watch_id: w.id,
          state: w.wake_state,
          delivered: failure === null,
          pending_reason: failure,
        }),
      );
    }
  }
}

/** Pending wakes not yet surfaced by a catchup (candidates for flush-on-clerk-idle). */
export function flushablePendingWakes(db: DatabaseSync): WatchRow[] {
  expireDueWatches(db);
  return db
    .prepare(
      `SELECT * FROM watches
       WHERE status = 'open' AND pending_wake = 1 AND pending_surfaced_at IS NULL
         AND expires_at > datetime('now')
       ORDER BY id`,
    )
    .all() as unknown as WatchRow[];
}
