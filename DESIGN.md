# `ledger` — Project Brief

## What this is

A personal agent-orchestration tool for delegating coding tasks to multiple AI
coding agents in parallel, from inside a single conversational entry point.

You talk to **the clerk** — a coding agent (Claude Code or Pi) running inside
[herdr](https://herdr.dev). The clerk dispatches work to other agents, each
running in its own isolated git worktree and its own herdr pane. All durable
state — what's running, what's blocked, what happened — lives in a local
SQLite database called **the ledger**. herdr owns terminal/process
management, [treehouse](https://github.com/kunchenguid/treehouse) owns git
worktree isolation, the ledger owns the record of what's going on.

This is being built for one person's actual daily workflow, not as a general
product. Prefer decisions that are simple and legible over decisions that are
flexible and general.

## Why this exists (context for whoever's implementing this)

This project is a direct reaction to two existing tools, both open source:

- **[firstmate](https://github.com/kunchenguid/firstmate)** — "Talk to one
  agent. Ship with a crew." An agent *distro*: no binary, just an `AGENTS.md`
  + skills directory that any terminal coding agent reads. Its supervision
  watcher is genuinely good (an event-driven bash process that wakes the
  agent only when needed, at zero LLM-token cost). Its problem is that
  ongoing state — backlog, "bearings," stow notes — is kept as growing plain
  text files that the supervising agent has to re-read and re-reason over
  each session. That's what burns tokens and usage caps in practice, not the
  watcher itself.

- **[hand](https://github.com/atqamz/hand)** (aka Secondhand) — "You lead.
  `hand` runs the crew." A rewrite of the same idea as a compiled Go binary
  with SQLite-backed state, plus hard dependencies on
  [herdr](https://github.com/ogulcancelik/herdr) and
  [treehouse](https://github.com/kunchenguid/treehouse). The SQLite state
  store is the right call — durable, transactional, queryable, cheap to read
  from. But `hand` itself is a black-box binary you have to trust wholesale,
  and it owns a lot of surface area (lifecycle, reconciliation, delivery
  modes, notifications) inside that binary.

`ledger` takes the state-store idea from `hand` and the cheap event-driven
supervision idea from `firstmate`, but tries to avoid both of their
downsides: no compiled binary of its own to trust blindly, and no
accumulating pile of prose the clerk has to re-read every session.

### Design philosophy: build it like Pi

This project should follow the design philosophy of
[Pi](https://pi.dev) (Mario Zechner's minimal coding agent): a small,
legible core, with almost everything else implemented as an optional,
removable extension. Pi's core is four tools and a system prompt of a few
hundred words; everything else — MCP, sub-agents, plan mode, permissions —
is left out on purpose, with the philosophy that if you need it, you build
it as an extension rather than expecting it to be baked in.

Apply the same discipline here:

- The **core** of `ledger` should be: the SQLite schema, a minimal CLI/API
  for reading and writing it, and the herdr plugin that keeps it in sync.
  That's it.
- Everything else — agent-to-agent coordination, notification channels,
  delivery-mode gates (PR vs local-only), reporting/dashboards — should be
  designed as an **optional extension or skill**, not core functionality.
  A good test before adding something to the core: *"could this instead be
  a skill the clerk loads, or a plugin herdr invokes?"* If yes, it doesn't
  belong in core.
- Prefer the tool teaching the clerk *how to extend it* over the tool
  trying to anticipate every future need itself. Concretely: ship a short,
  precise reference doc (schema + safe-extension patterns) that the clerk
  always has available, so "add a new capability" is something the clerk
  can reason about and do correctly, not something that requires you to
  hand-edit code yourself every time.

## Vocabulary

- **ledger** — the project as a whole, and specifically the SQLite database
  that holds all durable state.
- **clerk** — the coding agent (Claude Code or Pi) you talk to directly,
  running inside a herdr pane. Reads and writes the ledger, dispatches work,
  reports back to you.
- **first clerk** — whichever clerk session currently holds authority to
  make decisions and write to the ledger. There is exactly one at a time.
  This exists so dispatched agents and the watcher plugin have one
  unambiguous authority, even across restarts or multiple open sessions.
- **agents** — dispatched units of work. No further personification needed
  — just "agents." Each one runs in its own git worktree (leased via
  treehouse) inside its own herdr pane, running Claude Code, Pi, or whatever
  coding agent was specified for that task.

## Core dependencies

- **[herdr](https://herdr.dev)** — terminal workspace manager for AI coding
  agents. Organizes work into workspaces → tabs → panes, natively detects
  agent state (blocked / working / done / idle) per pane, exposes a local
  socket API and CLI, and supports plugins that hook into its event system.
  herdr is the process/session layer. If herdr is down, no agents are
  running — this is expected and fine. All durable state survives in the
  git worktrees and the SQLite ledger regardless.
- **[treehouse](https://github.com/kunchenguid/treehouse)** — isolated git
  worktree pools. Every dispatched agent gets its own leased worktree; no
  agent ever touches a project's shared clone directly.
- **SQLite** — the ledger's storage. No server process, single file, fully
  inspectable with any SQLite client at any time — this is a deliberate part
  of the "trust every moving part" goal.

`ledger` itself should have **no independent daemon or long-running
process**. It is not a binary that runs in the background. It's a schema, a
thin CLI/library for reading and writing it, and a herdr plugin manifest
that herdr invokes on relevant events. When there's no herdr pane event
happening, nothing belonging to `ledger` is executing at all.

## Roadmap items: breaking work down to keep context small

Beyond individual dispatched tasks, each project should be able to hold a
**roadmap** — a durable, hierarchical breakdown of the features or bodies of
work planned for that project. This is a core concept, not an extension:
it exists specifically to serve the same goals that motivate `ledger` in
the first place — small, scoped context per agent, and cheap, structured
catch-up instead of re-reading prose.

The idea: a large feature is a `roadmap` row. It can be broken down
into smaller sub-items (via `parent_id`, self-referencing, arbitrary
depth). Each dispatched `agents` row can optionally point at the roadmap
item it's implementing (`agents.roadmap_item_id`).

This buys two things:

- **Smaller, better-scoped dispatches.** Instead of one agent being handed
  an entire feature and having to hold all of it in context, a feature can
  be broken into sub-items up front, each dispatched separately with only
  the context it actually needs. This directly addresses the token-waste
  problem that motivated moving away from firstmate in the first place.
- **A rollup view for free.** "What roadmap items are done, in progress,
  or blocked for this project" is a cheap, structured query — the same
  cheap-catch-up principle that applies to individual agents now applies
  at the feature level too, so the clerk (or you) can see the shape of a
  whole project's progress without reading anything.

Whether the clerk is allowed to propose breaking a roadmap item into
sub-items on its own judgment, or whether that's something you always
author yourself, is a behavioral decision for the clerk's instructions —
not a schema decision. Default to the clerk proposing a breakdown and you
approving it, rather than either fully-automatic or fully-manual.

## Project registration: isolated clone, not your working directory

Following the same pattern independently converged on by both firstmate and
hand: when a project is registered, `ledger` should create its own clone
under its own home directory (`projects/<name>`, mirroring `local_clone_path`
in the schema) and dispatch all agent worktrees from that clone via
treehouse — never from the user's actual local checkout.

This matters for reasons beyond politeness: adding a git worktree registers
metadata in the source repo's `.git/worktrees`, so pointing treehouse at a
person's actively-open working copy would mean agent activity modifies that
repo's metadata even without touching working-tree files. A dedicated clone
avoids this entirely, and gives every dispatched agent a clean, predictable
starting point regardless of what state the user's own checkout happens to
be in (dirty, mid-rebase, on some other branch, etc.). This also matters if
`ledger` is ever released for others to use — a tool-owned clone is
something the tool fully controls; another person's working directory is
not.

`hand project add <url>` only supports registering from a remote URL. For a
single-developer tool this is a real limitation: it means only pushed
commits are visible to dispatched agents, and this developer frequently
wants to hand off work still on a local, unpushed branch. `ledger` should
support registering a project from **either a remote URL or a local
filesystem path** — `git clone` works against a local path just as it does
a URL, is fast (can hardlink on a shared filesystem), and picks up every
local commit and branch, including unpushed ones. The one thing neither
form of registration can ever capture is uncommitted, dirty working-tree
state — that's an inherent git limitation, not a gap in `ledger` — so if a
user wants an agent working from something not yet committed, the
expectation should be: commit it first (a throwaway branch is fine), then
dispatch.

## Core schema (starting point, not final)

```sql
CREATE TABLE projects (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  repo_url        TEXT NOT NULL,
  local_clone_path TEXT NOT NULL,
  default_branch  TEXT NOT NULL,
  delivery_mode   TEXT NOT NULL DEFAULT 'direct-pr', -- direct-pr | local-only
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE roadmap (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  parent_id     INTEGER REFERENCES roadmap(id), -- null = top-level item
  title         TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'planned', -- planned|in_progress|blocked|done|dropped
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE agents (
  id                INTEGER PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id),
  roadmap_item_id   INTEGER REFERENCES roadmap(id), -- null = not tied to a roadmap item
  task_description  TEXT NOT NULL,
  worktree_path     TEXT NOT NULL,      -- leased from treehouse
  herdr_workspace   TEXT NOT NULL,
  herdr_tab         TEXT NOT NULL,
  herdr_pane        TEXT NOT NULL,
  coding_agent      TEXT NOT NULL,      -- e.g. "claude", "pi"
  status            TEXT NOT NULL DEFAULT 'working', -- blocked|working|done|idle
  outcome           TEXT,               -- null | pr_url | branch name | report path
  spawned_by        INTEGER REFERENCES agents(id), -- null = spawned by the clerk directly
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE events (
  id          INTEGER PRIMARY KEY,
  agent_id    INTEGER NOT NULL REFERENCES agents(id),
  event_type  TEXT NOT NULL,   -- e.g. state_change, dispatched, note
  payload     TEXT,            -- free-form JSON
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE first_clerk (
  id            INTEGER PRIMARY KEY CHECK (id = 1), -- single row
  session_id    TEXT NOT NULL,
  herdr_pane    TEXT NOT NULL,
  claimed_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Treat this as a strong starting point, not gospel. It should evolve as real
usage reveals what's actually needed, but keep changes disciplined — every
new column or table should have a clear reason tied to something the clerk
or the watcher actually needs to do.

`spawned_by` exists specifically to keep the audit trail intact if
agent-to-agent coordination is ever added later as an extension (see below)
— cheap to include now, expensive to retrofit.

## The watcher: a herdr plugin, not a daemon

herdr plugins declare event hooks in a manifest
(`herdr-plugin.toml`); herdr itself invokes the plugin's command when a
declared event fires, and the plugin can be written in anything (bash is
fine). This means the ledger's "watcher" is not a polling loop and not a
standing process — it's a small script that:

1. Is registered against herdr's pane/agent state-change event.
2. On invocation, receives the event payload from herdr (which pane, what
   new state).
3. Looks up the corresponding `agents` row (matched by
   workspace/tab/pane), writes an `events` row, updates `agents.status`
   and `updated_at`.
4. Exits.

No independent uptime story, no polling interval to tune. If herdr isn't
running, this plugin simply never fires — which is the correct behavior,
since no agents can be running either.

## Dispatch flow

1. You tell the clerk what you want done, in which project. If it's a
   sizable feature, the clerk should consider (or you should direct)
   whether it belongs in `roadmap` and whether it should be broken
   into smaller sub-items before anything is dispatched.
2. Clerk asks treehouse for a leased worktree against that project.
3. Clerk uses herdr's CLI/socket API to open a new pane (in the
   appropriate workspace/tab) running the specified coding agent, pointed
   at that worktree, with the task as its initial instruction — scoped to
   a single roadmap sub-item where one exists, rather than a whole feature
   at once.
4. Clerk inserts a row into `agents` linking project, worktree, the herdr
   workspace/tab/pane identifiers, and `roadmap_item_id` if this task
   implements a roadmap item (null otherwise). `spawned_by` is null
   (dispatched directly by the clerk).
5. From here, the herdr plugin keeps `agents.status` and `events` current
   automatically as that pane's agent state changes, with zero further
   involvement from the clerk.

## Session start / "catch me up" flow

When a new clerk session begins (or resumes), it should not read any
growing document. Its opening move is two cheap, structured queries:

- `SELECT * FROM agents WHERE status = 'blocked'` — what needs a decision
  right now.
- `SELECT * FROM events WHERE created_at > :last_seen` — what happened
  since the last session looked.
- `SELECT * FROM roadmap WHERE project_id = :p AND status != 'done'`
  (as needed, per active project) — the shape of what's planned and in
  flight at the feature level, not just the task level.

That's the entire "what's going on" operation. This is the core mechanism
by which `ledger` should avoid the token-inefficiency problem that
motivated this whole project: catching up costs a handful of rows, not a
document to re-parse.

## First clerk claiming

On session start, a clerk should check the single-row `first_clerk` table.
If unclaimed or the prior claim is stale, it may claim authority by writing
its own session id and herdr pane reference. This prevents ambiguity if
you ever have more than one clerk-capable session open at once — dispatched
agents and the watcher plugin always have one unambiguous authority to
report to.

## Explicitly deferred: agent-to-agent coordination

herdr's socket API allows any agent in a pane — not just the clerk — to
spawn other panes, send prompts to other agents, and wait on their state.
`ledger` does not need to build or restrict this capability itself; it
already exists at the herdr layer.

**Default behavior for v1: dispatched agents do not use this.** Agents
work their own assigned task and report status through normal herdr state
transitions (which the watcher plugin picks up); they do not spawn peers
or coordinate with each other directly. All coordination routes through
the clerk, so the ledger remains a complete, auditable record of every
decision.

If peer-to-peer coordination is wanted later, it should be added as **an
optional skill/instruction set given to dispatched agents** (e.g. "you may
spawn a peer via herdr for X situation, and must report what you did") —
not as a change to `ledger`'s schema, CLI, or watcher plugin. The
`spawned_by` column already accommodates this: a peer-spawned agent just
records the spawning agent's id instead of null. This should be treated as
a clean extension point, not a v1 requirement.

## Non-goals for v1

- No compiled binary. No independent daemon.
- No remote/SSH fleet support (herdr already handles remote access on its
  own if ever needed — no reason to duplicate that).
- No notification integrations (Slack, X, Discord, etc.) — could be a
  later plugin, not core.
- No built-in delivery-gate system beyond a simple `delivery_mode` field
  per project (`direct-pr` / `local-only`). Anything more elaborate (like
  firstmate's `no-mistakes` gate) is a later extension if ever wanted.
- No agent-to-agent coordination (see above).
- No dashboards or UI beyond what the clerk reports conversationally and
  what's directly queryable from the SQLite file.

## Open questions for the implementer

- Exact herdr CLI/socket calls for pane creation, targeting a specific
  workspace/tab, and reading agent state — pull these from herdr's current
  docs (`herdr.dev/docs`) rather than assuming syntax, since herdr is
  pre-1.0 with a high release cadence.
- Exact treehouse invocation for worktree leasing and release — confirm
  current CLI against the treehouse repo.
- Whether the clerk's reference doc (schema + extension guidance) should
  live as a single markdown file the clerk always loads, or be broken into
  the equivalent of Pi-style skills loaded on demand. Lean toward the
  single-file approach initially given the emphasis on a minimal core, but
  revisit if it grows unwieldy.
- Confirm the least-friction way to install the herdr plugin (plugin
  manifest format, whether it should be part of this repo or published
  separately).
