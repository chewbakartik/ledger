import { Command } from "commander";
import type { SQLInputValue } from "node:sqlite";
import { getDb } from "../../db/client.js";
import type { AgentRow, EventRow, FirstClerkRow, RoadmapRow, WatchRow } from "../../db/types.js";
import { ROADMAP_TERMINAL_STATUSES } from "../../db/types.js";
import { getPane, HerdrError, readPane } from "../../lib/herdr.js";
import { presentAgent, presentRoadmap, provisionalCodesNotice, provisionalProjects } from "../../lib/roadmap-keys.js";
import { packageVersion } from "../../lib/package-info.js";
import { checkForUpdate, formatUpdateNotice, type UpdateInfo } from "../../lib/update-check.js";
import { expireDueWatches, parseSteps, presentWatch } from "../../lib/watches.js";
import { printJson } from "../format.js";
import { getProjectByName } from "./projects.js";

/** Default tail length for each idle agent's pane read (A8 liveness triage). */
const IDLE_PANE_TAIL_DEFAULT_LINES = 25;

interface IdleEntry {
  agent: AgentRow;
  pane_tail: string | null;
  pane_read_error: string | null;
}

/**
 * Reads the tail of every idle agent's pane, in one shot. Never throws —
 * per C7, an observation failure is not evidence, so a pane read failing
 * must never fail catch-up itself. A structured HerdrError (pane/tab gone)
 * is per-agent: recorded on that entry only. Anything else (couldn't even
 * get a herdr response — socket down) is systemic: recorded once as a
 * global note, and no further pane reads are attempted (they'd all fail the
 * same way) — every remaining idle agent gets that same note instead of
 * repeating the failure per pane.
 */
function readIdlePanes(
  agents: AgentRow[],
  lines: number,
): { entries: IdleEntry[]; globalNote: string | null } {
  const entries: IdleEntry[] = [];
  let globalNote: string | null = null;

  for (const agent of agents) {
    if (globalNote) {
      entries.push({ agent, pane_tail: null, pane_read_error: globalNote });
      continue;
    }
    try {
      const tail = readPane(agent.herdr_pane, { source: "recent", lines, quiet: true });
      entries.push({ agent, pane_tail: tail, pane_read_error: null });
    } catch (err) {
      if (err instanceof HerdrError) {
        entries.push({
          agent,
          pane_tail: null,
          pane_read_error: `${err.code}: ${err.message}`,
        });
      } else {
        // Not even a structured herdr error — treat as the whole socket
        // being unreachable rather than this one pane being gone.
        const message = err instanceof Error ? err.message : String(err);
        globalNote = `herdr pane reads unavailable: ${message}`;
        entries.push({ agent, pane_tail: null, pane_read_error: globalNote });
      }
    }
  }

  return { entries, globalNote };
}

interface DoneLiveEntry {
  agent: AgentRow;
  /** The pane's actual, freshly-observed herdr agent_status (item 88: a `done` agents row's own status is frozen — see watcher.ts — so this is the only way to tell "genuinely finished, pane/worktree gone" from "reported done, but the pane is still sitting there idle"). */
  herdr_agent_status: string;
}

/**
 * Item 88: a dispatched agent reaching `done` doesn't mean its herdr pane
 * actually exited — it often just went idle, still holding all the context
 * it built up, and a follow-up (`ledger agent followup`) can pick up there
 * instead of leasing a whole new worktree. Rather than a new schema status
 * to track this (a real migration, and another state every consumer of
 * `agents.status` — dispatch's duplicate-live check, the watcher's terminal
 * guard, `agent release` — would need to learn about), this does the fresh
 * per-agent check catch-up already does for idle panes' tails, and surfaces
 * only the ones that are actually still alive.
 *
 * Never throws — same C7 rationale as `readIdlePanes`: a `pane_not_found`
 * (or any other structured HerdrError) just means this particular done
 * agent's pane is genuinely gone, which isn't newsworthy — it's excluded,
 * not reported as an error. Only a non-HerdrError failure (herdr socket
 * itself unreachable) is systemic: recorded once as a global note, and no
 * further pane reads are attempted.
 */
function findDoneAgentsWithLivePane(
  agents: AgentRow[],
): { entries: DoneLiveEntry[]; globalNote: string | null } {
  const entries: DoneLiveEntry[] = [];
  let globalNote: string | null = null;

  for (const agent of agents) {
    if (globalNote) break;
    try {
      const pane = getPane(agent.herdr_pane, { quiet: true });
      entries.push({ agent, herdr_agent_status: pane.agent_status });
    } catch (err) {
      if (err instanceof HerdrError) {
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      globalNote = `herdr pane reads unavailable: ${message}`;
    }
  }

  return { entries, globalNote };
}

const IDLE_LABEL_MAX_LENGTH = 80;

/** First line of a (possibly long, multi-paragraph) task description, truncated. */
function shortLabel(taskDescription: string): string {
  const firstLine = taskDescription.split("\n")[0] ?? "";
  return firstLine.length > IDLE_LABEL_MAX_LENGTH
    ? `${firstLine.slice(0, IDLE_LABEL_MAX_LENGTH - 1)}…`
    : firstLine;
}

function describeWatch(w: WatchRow): string {
  const steps = parseSteps(w);
  const target = [
    w.agent_id !== null ? `agent#${w.agent_id}` : null,
    w.roadmap_item_id !== null ? `item#${w.roadmap_item_id}` : null,
  ]
    .filter(Boolean)
    .join("+");
  const sent = w.wake_sent_at ? " [woken, awaiting clerk]" : "";
  return (
    `watch #${w.id} on ${target} step ${w.step_index + 1}/${steps.length}${sent}: ` +
    `${shortLabel(steps[w.step_index] ?? "")} (expires ${w.expires_at})`
  );
}

function parseIdlePaneLinesOpt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`--idle-pane-lines must be a non-negative integer: ${value}`);
  }
  return n;
}

/**
 * The entire "what's going on" operation from DESIGN.md's session-start
 * flow: blocked agents needing a decision, events since the last time a
 * clerk looked, and the shape of what's still active on the roadmap.
 * Costs a handful of rows, not a document to re-parse.
 */
export function registerCatchupCommand(program: Command): void {
  program
    .command("catchup")
    .description("session-start summary: blocked agents, new events, active roadmap")
    .option("--project <name>", "scope roadmap (and optionally agents) to one project")
    .option(
      "--idle-pane-lines <n>",
      "lines of pane tail to show per idle agent (A8 liveness triage); 0 disables " +
        "all pane reads, including idle tails and the done-agent liveness check (item 88)",
      parseIdlePaneLinesOpt,
      IDLE_PANE_TAIL_DEFAULT_LINES,
    )
    .option("--json", "output as JSON (default: human-readable)")
    .action(async (opts: { project?: string; idlePaneLines: number; json?: boolean }) => {
      const db = getDb();
      const project = opts.project ? getProjectByName(opts.project) : undefined;

      const firstClerk = db
        .prepare("SELECT * FROM first_clerk WHERE id = 1")
        .get() as unknown as FirstClerkRow | undefined;
      const since = firstClerk?.last_seen ?? firstClerk?.claimed_at ?? null;

      let blockedSql = "SELECT * FROM agents WHERE status = 'blocked'";
      const blockedParams: SQLInputValue[] = [];
      if (project) {
        blockedSql += " AND project_id = ?";
        blockedParams.push(project.id);
      }
      const blocked = db.prepare(blockedSql).all(...blockedParams) as unknown as AgentRow[];

      // A8 (DECISIONS.md): an idle agent with unfinished work is suspect —
      // it may have died on a usage limit. Surface every idle agent plus
      // the tail of what it last showed, so that check doesn't require
      // going to read the pane by hand.
      let idleSql = "SELECT * FROM agents WHERE status = 'idle'";
      const idleParams: SQLInputValue[] = [];
      if (project) {
        idleSql += " AND project_id = ?";
        idleParams.push(project.id);
      }
      const idleAgents = db.prepare(idleSql).all(...idleParams) as unknown as AgentRow[];
      const { entries: idle, globalNote: idlePaneGlobalNote } =
        opts.idlePaneLines > 0
          ? readIdlePanes(idleAgents, opts.idlePaneLines)
          : {
              entries: idleAgents.map((agent) => ({
                agent,
                pane_tail: null,
                pane_read_error: null,
              })),
              globalNote: null,
            };

      // Item 88: surface `done` agents whose pane is still actually alive —
      // a real follow-up candidate via `ledger agent followup`, distinct
      // from a `done` agent whose worktree/pane is genuinely gone. Gated on
      // the same flag as idle pane tails, for a single "no herdr socket
      // calls" opt-out.
      let doneSql = "SELECT * FROM agents WHERE status = 'done'";
      const doneParams: SQLInputValue[] = [];
      if (project) {
        doneSql += " AND project_id = ?";
        doneParams.push(project.id);
      }
      const doneAgents = db.prepare(doneSql).all(...doneParams) as unknown as AgentRow[];
      const { entries: doneWithLivePane, globalNote: donePaneGlobalNote } =
        opts.idlePaneLines > 0
          ? findDoneAgentsWithLivePane(doneAgents)
          : { entries: [], globalNote: null };

      let events: EventRow[] = [];
      if (since) {
        let eventsSql = "SELECT * FROM events WHERE created_at > ?";
        const eventsParams: SQLInputValue[] = [since];
        if (project) {
          eventsSql +=
            " AND agent_id IN (SELECT id FROM agents WHERE project_id = ?)";
          eventsParams.push(project.id);
        }
        eventsSql += " ORDER BY created_at";
        events = db.prepare(eventsSql).all(...eventsParams) as unknown as EventRow[];
      }

      let roadmapSql = `SELECT * FROM roadmap WHERE status NOT IN (${ROADMAP_TERMINAL_STATUSES.map(() => "?").join(", ")})`;
      const roadmapParams: SQLInputValue[] = [...ROADMAP_TERMINAL_STATUSES];
      if (project) {
        roadmapSql += " AND project_id = ?";
        roadmapParams.push(project.id);
      }
      // Coarse triage order (DECISIONS.md, 2026-08-23): priority
      // high -> normal -> low, ties by id. Stale priorities mis-sort
      // this list (visible here) without blocking anything.
      roadmapSql +=
        " ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, id";
      const roadmap = db.prepare(roadmapSql).all(...roadmapParams) as unknown as RoadmapRow[];

      // Roadmap #89: what happens next lives in the DB. Open watches,
      // pending (undelivered) wakes, and watches that expired since the last
      // catchup -- so a post-compaction or fresh clerk re-learns it here.
      expireDueWatches(db);
      const watchScope = project ? " AND project_id = ?" : "";
      const watchParams: SQLInputValue[] = project ? [project.id] : [];
      const openWatches = db
        .prepare(
          `SELECT * FROM watches WHERE status = 'open' AND pending_wake = 0${watchScope} ORDER BY id`,
        )
        .all(...watchParams) as unknown as WatchRow[];
      const pendingWakes = db
        .prepare(
          `SELECT * FROM watches WHERE status = 'open' AND pending_wake = 1${watchScope} ORDER BY id`,
        )
        .all(...watchParams) as unknown as WatchRow[];
      const expiredWatches = db
        .prepare(
          `SELECT * FROM watches WHERE status = 'expired' AND expiry_surfaced_at IS NULL${watchScope} ORDER BY id`,
        )
        .all(...watchParams) as unknown as WatchRow[];
      // Surfacing marks them seen: a pending wake the clerk has now read is
      // not re-prompted when the clerk pane next settles, and an expiry is
      // reported once.
      for (const w of pendingWakes) {
        db.prepare("UPDATE watches SET pending_surfaced_at = datetime('now') WHERE id = ?").run(w.id);
      }
      for (const w of expiredWatches) {
        db.prepare("UPDATE watches SET expiry_surfaced_at = datetime('now') WHERE id = ?").run(w.id);
      }

      if (firstClerk) {
        db.prepare(
          "UPDATE first_clerk SET last_seen = datetime('now') WHERE id = 1",
        ).run();
      }

      // Item 42: cached (6h), silent-on-failure update-availability check.
      // Added as an explicit top-level key (`update_available`, null when
      // there's nothing to report) rather than mixed into plain text, so
      // --json stays valid JSON in both cases.
      const updateAvailable: UpdateInfo | null = await checkForUpdate(packageVersion());

      // Roadmap #80: user-facing output carries item keys, never the global
      // numeric ids — present agents/roadmap rows before they're emitted.
      const summary = {
        since,
        blocked: blocked.map((a) => presentAgent(a, db)),
        idle: idle.map((e) => ({ ...e, agent: presentAgent(e.agent, db) })),
        idle_pane_read_note: idlePaneGlobalNote,
        done_with_live_pane: doneWithLivePane.map((e) => ({ ...e, agent: presentAgent(e.agent, db) })),
        done_pane_read_note: donePaneGlobalNote,
        events,
        roadmap: roadmap.map((r) => presentRoadmap(r, db)),
        watches: {
          open: openWatches.map((w) => presentWatch(w, db)),
          pending_wakes: pendingWakes.map((w) => presentWatch(w, db)),
          expired_since_last_catchup: expiredWatches.map((w) => presentWatch(w, db)),
        },
        update_available: updateAvailable,
        provisional_project_codes: provisionalProjects(db),
      };

      if (opts.json) {
        printJson(summary);
        return;
      }

      const projectNames = new Map(
        (db.prepare("SELECT id, name FROM projects").all() as unknown as { id: number; name: string }[]).map(
          (p) => [p.id, p.name] as const,
        ),
      );
      const projectLabel = (id: number) => projectNames.get(id) ?? String(id);

      console.log(`Since: ${since ?? "(no prior catchup — showing full roadmap only)"}`);
      console.log(`\nBlocked (${blocked.length}):`);
      for (const a of blocked) {
        console.log(`  #${a.id} [${projectLabel(a.project_id)}] ${a.task_description}`);
      }
      console.log(`\nIdle (${idle.length}):`);
      if (idlePaneGlobalNote) {
        console.log(`  (${idlePaneGlobalNote} — pane tails skipped below)`);
      }
      for (const { agent, pane_tail, pane_read_error } of idle) {
        console.log(
          `  #${agent.id} [${projectLabel(agent.project_id)}] pane=${agent.herdr_pane} ` +
            shortLabel(agent.task_description),
        );
        if (pane_tail !== null) {
          for (const line of pane_tail.split("\n")) {
            console.log(`      ${line}`);
          }
        } else if (pane_read_error && !idlePaneGlobalNote) {
          console.log(`      pane unreadable: ${pane_read_error}`);
        }
      }
      console.log(`\nDone agents with a live pane (${doneWithLivePane.length}):`);
      if (donePaneGlobalNote) {
        console.log(`  (${donePaneGlobalNote})`);
      }
      for (const { agent, herdr_agent_status } of doneWithLivePane) {
        console.log(
          `  #${agent.id} [${projectLabel(agent.project_id)}] pane=${agent.herdr_pane} ` +
            `herdr_status=${herdr_agent_status} — ${shortLabel(agent.task_description)} ` +
            `(follow-up candidate: ledger agent followup ${agent.id} --task ... --authorization ...)`,
        );
      }
      console.log(`\nEvents (${events.length}):`);
      for (const e of events) {
        console.log(`  ${e.created_at} agent#${e.agent_id} ${e.event_type}`);
      }
      console.log(`\nRoadmap in flight (${roadmap.length}):`);
      for (const r of summary.roadmap) {
        const indent = r.parent_key ? "    " : "  ";
        console.log(`${indent}${r.key} [${projectLabel(r.project_id)}] [${r.status}] ${r.title}`);
      }

      console.log(`\nWatches open (${openWatches.length}):`);
      for (const w of openWatches) console.log(`  ${describeWatch(w)}`);
      console.log(`\nPending wakes (${pendingWakes.length}) -- the clerk pane couldn't take these:`);
      for (const w of pendingWakes) {
        console.log(`  ${describeWatch(w)}`);
        console.log(
          `      agent #${w.wake_agent_id} is ${w.wake_state} (outcome: ${w.wake_outcome ?? "none reported"}); ` +
            `undelivered because ${w.wake_reason ?? "unknown"}`,
        );
      }
      console.log(`\nWatches expired since last catchup (${expiredWatches.length}):`);
      for (const w of expiredWatches) console.log(`  ${describeWatch(w)} (expired ${w.expires_at})`);

      if (updateAvailable) console.log(`\n${formatUpdateNotice(updateAvailable)}`);
      const codesNotice = provisionalCodesNotice(db);
      if (codesNotice) console.log(`\n${codesNotice}`);
    });
}
