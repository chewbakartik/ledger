# Implementation decisions log

Running log of forks encountered while implementing `ledger` from DESIGN.md,
made autonomously per the user's instruction (session of 2026-08-22, user
stepping away). Format: question, options considered, decision, why.

## Pre-implementation clarifications (asked directly, not autonomous)

**Q: Language/runtime for the CLI and herdr watcher plugin?**
Options: Node.js/TypeScript, Python, Bash+sqlite3.
Decided: TypeScript, strongly typed throughout. (User's explicit answer.)

**Q: treehouse vs herdr's own worktree management — who owns leasing?**
Options: (a) treehouse leases + `herdr worktree open` attaches a pane to the
leased path, (b) drop treehouse, use `herdr worktree create` directly.
Decided: (a) — treehouse leases, herdr opens. (User's explicit answer,
matches DESIGN.md's stated dependency on treehouse.)

**Q: Scope of this pass?**
Decided: everything — schema, CLI, herdr plugin, project registration,
clerk reference doc. (User's explicit answer.)

---

## Autonomous decisions (made during implementation)

<!-- Append entries below as they come up, newest at bottom. -->

**Build: compile TS to `dist/` via `tsc`, no runtime transpiler.**
Options: (a) `tsc` build step, plain-JS output the CLI/plugin actually run;
(b) zero-build via `tsx`/`ts-node` at runtime.
Decided: (a). DESIGN.md's "no compiled binary to trust blindly" is about not
shipping an opaque compiled Go/Rust binary — plain `tsc` output is still
fully readable JS, and avoids depending on a transpiler being present when
herdr invokes the plugin non-interactively.

**SQLite binding: `better-sqlite3`, not Node's built-in `node:sqlite`.**
Node 24 ships `node:sqlite` with zero extra dependency, which appealed to
the "trust every moving part" ethos, but it's still flagged experimental
(API can change). `better-sqlite3` is a mature, widely-trusted, synchronous,
well-typed binding — better fit for a tool meant to be a reliable daily
driver. Logged since it's a real dependency add, not because it was close.

**CLI framework: `commander`.**
Minimal, well-typed, avoids hand-rolling arg parsing/help text. In keeping
with Pi-style minimalism this is the *only* CLI-scaffolding dependency.

**Ledger home directory: `~/.ledger` (override via `LEDGER_HOME`).**
Holds `ledger.db` and `projects/<name>` clones side by side. DESIGN.md
specifies `projects/<name>` under "its own home directory" but never names
the directory itself.

**Schema evolution: numbered SQL migrations + `schema_migrations` table,
applied automatically on every DB open.**
DESIGN.md's schema is explicitly "a starting point, not final." A tiny
migrations runner (see `src/db/migrations/`) is the least amount of
machinery that still makes future column/table additions safe, without
building a heavier framework than a single-user local SQLite file needs.

**Added `first_clerk.last_seen TEXT` (not in DESIGN.md's schema).**
The "catch me up" flow (`SELECT * FROM events WHERE created_at > :last_seen`)
names a `:last_seen` parameter but never says where it's stored. Storing it
on the single-row `first_clerk` table (updated each time `ledger catchup`
runs) gives it one obvious home, consistent with "every new column should
have a clear reason."

**Dispatch does NOT use herdr's own `herdr worktree create|open` subcommands.**
Empirically verified live (see transcript): `herdr worktree create`/`open`
take `--workspace ID | --cwd PATH` to locate a *source* repo, and always
open the result in a brand-new workspace they create themselves — there is
no way to point them at a path already leased by treehouse and attach it to
a workspace/pane you control. That subsystem is herdr's own **alternative**
worktree pool, not a generic "open a pane at this directory" primitive.
Decided: skip it entirely. Dispatch instead runs
`herdr workspace create --cwd <treehouse-leased-path> --label <task> --no-focus`,
which atomically creates a workspace + tab + root pane at that cwd and
returns all three ids in one JSON response — exactly `agents.herdr_workspace`
/ `herdr_tab` / `herdr_pane`. Then `herdr agent start <name> --kind <agent>
--pane <pane_id>` starts the coding agent, and `herdr agent prompt <pane_id>
"<task>"` delivers the initial instruction.

**treehouse lease-holder label: `ledger:<project-name>`.**
For traceability in `treehouse status`. Release (`treehouse return <path>`)
is a manual/explicit action (`ledger agent release <id>`), not automatic on
`done` — an agent reaching `done` doesn't always mean its worktree is safe
to recycle (e.g. PR not yet merged, still want to inspect it locally).

**Watcher plugin: `agent_status: "unknown"` events are logged but don't
overwrite `agents.status`.**
herdr's `AgentStatus` enum includes `unknown`; ledger's `agents.status` does
not (it's `blocked|working|done|idle` per DESIGN.md). An `unknown` reading
is usually transient (e.g. mid-detection) — recording it as an `events` row
preserves the audit trail without corrupting the durable status field.

**Clerk reference doc: single file, `LEDGER.md`.**
Per DESIGN.md's own stated lean ("Lean toward the single-file approach
initially"). Revisit if it grows unwieldy, per the same note.

**`herdr-plugin.toml`: `id = "ledger"`, `min_herdr_version = "0.7.0"`.**
The installed herdr is 0.7.5; pinned the floor to 0.7.0 rather than the
exact running version, since DESIGN.md flags herdr as pre-1.0 with a high
release cadence and this plugin only depends on the `pane.agent_status_changed`
event hook + `HERDR_PLUGIN_EVENT_JSON`, both present since at least that line.

**Corrected the event-hook name: `pane.agent_status_changed`, not
`pane_agent_status_changed`.**
`herdr api schema --json` exposes an internal `EventData` enum using
underscored discriminators (`pane_agent_status_changed`, matching the
socket-API subscription event `type` field) — that's what I initially wrote
into `herdr-plugin.toml`. Linking the plugin for real
(`herdr plugin link .`) surfaced a `warning: unknown event
'pane_agent_status_changed'` — the *plugin manifest's* `on` field uses a
separate, dotted registry (`pane.agent_status_changed`, found via `strings`
on the herdr binary: `workspace.created`, `tab.created`, `pane.created`,
`pane.agent_status_changed`, `pane.agent_detected`, etc. — a curated subset
of the internal event catalog, not identical to it). Fixed and confirmed
the warning disappeared on re-link. Also made `src/plugin/watcher.ts` not
hard-require an exact `type` string in the delivered payload (only that
`pane_id`/`agent_status` are present) — since this hook is only ever wired
to one event, and the exact `type` spelling actually delivered to the
command (dotted vs underscored) wasn't confirmed empirically before this
shipped. **Follow-up in progress**: a debug capture of the first live
`pane.agent_status_changed` invocation was started this session (see below)
to confirm the real payload shape and, if needed, tighten the check back up.

**First-clerk claim staleness: 12 hours.**
DESIGN.md says a clerk "may claim authority if unclaimed or the prior claim
is stale" but doesn't define stale. Picked 12h as a reasonable "probably a
dead/abandoned session" threshold for a tool used within single days of
work; `--force` always available to override regardless of age.

**Dispatch cleanup fix, found live during testing: close the herdr
workspace *before* returning the treehouse worktree, and do so whenever a
workspace was created even if a later step (`agent start`/`agent prompt`)
fails.**
Initial version only returned the treehouse lease on failure, leaving a
dangling herdr pane pointed at a worktree already back in the pool.
Reordering to close-then-return ends the pane's shell process cleanly
instead of relying on treehouse's own "terminate lingering processes"
fallback. Verified live: induced a failing dispatch (bad `--kind`), confirmed
no leftover herdr workspace, no reused/stuck treehouse lease, and no
phantom `agents` row.

**Dispatch label doubles as both the herdr workspace label and the herdr
agent name.**
herdr agent names must be lowercase, `[a-z0-9_-]`, 1-32 chars — stricter
than the workspace label's free-text field. Derived one slug satisfying the
stricter rule and reused it for both, rather than maintaining two separate
naming schemes for what is, day to day, the same human-facing label.

**Dispatch reordered: insert the `agents` row before sending the initial
task prompt, not after.**
Prompted by the user's question about clerk-vs-agent instructions: a
dispatched agent needs its own row id to report back
(`ledger agent update <id> --status done --outcome ...`), but the id didn't
exist yet at the point the task text was sent. Reordered to insert right
after `createWorkspace`/`startAgent` succeed (the agent process is running
and worth tracking by then) and build the actual prompt — task text plus a
short reporting-contract addendum — after that. A failure in the prompt
call itself no longer tears anything down (the process exists and is
tracked; deleting the row would be worse than leaving it for the clerk to
investigate via `agent get`/`agent release`) — it logs a
`dispatch_prompt_failed` event and re-raises. Re-verified the still-relevant
pre-insert failure path live (`--kind grok`, a valid kind with no local
executable — fails inside `herdr agent start`): no leftover workspace,
worktree correctly returned, no phantom row.
Not live-tested: the new post-insert "row exists, prompt itself fails"
branch specifically — inducing that safely would require a real coding
agent to actually start successfully and then fail only at the prompt step,
which isn't reproducible without spawning a real billed session (same
category of caveat as `startAgent`/`promptAgent` generally, see below).

## Clerk bootstrapping: a cross-agent skill, not a global always-loaded file

Raised by the user: how does a clerk session actually discover `LEDGER.md`?
First proposal was a short conditional stanza in `~/.claude/CLAUDE.md` and
`~/.pi/agent/AGENTS.md` (both global, always-loaded-every-session files).
User explicitly rejected that — didn't want ledger context in *every*
session, only when asked for. They asked specifically about portable
"AI agent skills" instead.

This machine already has exactly that, live and working: a shared
`~/.agents/skills/<name>/SKILL.md` tree (YAML frontmatter `name` +
`description`, body = instructions), with `~/.claude/skills/<name>` and
`~/.pi/agent/skills/<name>` as symlinks into it per skill — that's how
`caveman`, `lean-build`, `axi`, etc. are already available across both
tools on this machine. `~/.agents/.skill-lock.json` tracks *GitHub-sourced*
skills only; a hand-authored local one doesn't need a lock entry, just the
directory.

Created `~/.agents/skills/ledger/SKILL.md` — deliberately just a pointer
("read `LEDGER.md` at `<path>` before doing anything else"), not a copy of
its content, so it can't drift out of sync with the real CLI. Symlinked
into `~/.claude/skills/ledger` and `~/.pi/agent/skills/ledger`, matching
the exact relative-path pattern every other skill in that tree already
uses. Result: a one-line description sits in context cheaply and always;
the full `LEDGER.md` only loads when the skill actually fires (invoked by
name, or a session's own judgment that it's relevant to what's being
asked) — not on every unrelated session, which was the whole point.

## `ledger project init`: a real gap in DESIGN.md's own spec

User caught this trying to pick a trial dispatch target: they wanted to
dispatch the very first `ledger-notify` extension build (see
`EXTENSION-EXAMPLE-BRIEF.md`), but that project doesn't exist anywhere yet
— no local directory, no git repo, no remote URL. DESIGN.md's "Project
registration" section only ever considered registering from something that
*already exists* ("either a remote URL or a local filesystem path");
starting a project from nothing wasn't anticipated.

Added `ledger project init --name <name> [--delivery-mode ...]`
(`src/lib/git.ts` `initProject`, alongside the existing `cloneProject`):
`git init` + one empty initial commit directly in
`$LEDGER_HOME/projects/<name>` — the empty commit isn't decorative, it's
required: treehouse needs a real ref to lease a worktree from, verified
live (`treehouse get --lease` against a freshly-`init`'d repo with only
that empty commit — works). Deliberately no other scaffolding — a from-
scratch project should be exactly as blank as the dispatched agent expects,
not ledger's opinion of a starting template.

This forced a real schema change: `projects.repo_url` was `NOT NULL`,
which doesn't fit a from-scratch project (there genuinely is no origin,
not even a placeholder — storing the local path in that column would be
inaccurate about what it *is*, not just permissive). Made it nullable.
**Edited `0001_init.ts` directly** rather than adding a `0002` migration —
normally a hard rule not to (see `LEDGER.md`'s extension guidance: "never
hand-edit `0001_init.ts` after it's shipped"), but justified here only
because `~/.ledger/ledger.db` was confirmed to still have zero real rows in
every table (this whole tool is pre-first-trial) before touching it —
deleted and let it regenerate rather than risk a fiddly SQLite
NOT-NULL-drop-via-table-rebuild migration for a database with nothing in
it to lose. This exception closes the moment there's real data in it,
which — given this session's trial — is about to be true.

Also defaulted `project init`'s `--delivery-mode` to `local-only` (vs.
`add`'s `direct-pr` default) — a project with no remote yet has nowhere to
open a PR against.

## Skill portability: `ledger docs` command, not a hardcoded path in the skill

User caught a real bug in the first version of `~/.agents/skills/ledger/SKILL.md`:
it hardcoded `/home/david/Development/llm/ledger/LEDGER.md`, an absolute
path specific to this machine — useless on a fresh install elsewhere, even
though the skill file itself is otherwise fully portable (synced via the
shared `~/.agents/skills/` convention).

Fixed at the right layer: rather than have the *skill* guess/hardcode a
repo path, gave the **CLI itself** a `ledger docs` command
(`src/cli/commands/docs.ts`) that prints `LEDGER.md` by resolving it
relative to `import.meta.url` of the running compiled code — i.e. relative
to wherever `ledger` actually is on disk, computed at runtime, never a
literal path baked in anywhere. The skill now just says "run `ledger docs`".

Verified this survives the one case that could plausibly break path
resolution — an `npm link` global symlink — live: `npm link`, then ran
`ledger docs` from `/tmp` (an unrelated cwd), got the correct full
`LEDGER.md` content. ESM's `import.meta.url` resolves through the symlink
to the real file location, so this works regardless of where the repo was
cloned or what machine it's on, with zero machine-specific configuration —
the only per-machine step is the ordinary install (`git clone` + `npm run
build` + link `ledger` onto PATH), already covered in `README.md`.

## Deferred decisions (explicitly parked, not autonomous)

**`LEDGER.md` size/trim.** Grew substantially this session (two-audience
split + extension guidance). Whether to trim it, or split it into an
always-loaded core + on-demand extension guidance, is explicitly deferred
until there's real usage data — user's call: "it would be naive to make
determinations and put in effort if there's not a real need." Nothing has
actually been trialed yet. Revisit once the clerk has run for real sessions
and it's clear whether the size is actually a problem in practice.

## Verification performed this session

- `npm run build` (tsc, strict mode) — clean.
- Full CLI smoke test against a scratch `LEDGER_HOME`: `project add` (real
  `git clone` of a local repo), `project list`, `roadmap add` (including a
  `--parent` sub-item), `roadmap list`, `clerk claim`, `catchup`.
- Live dispatch orchestration against the real `treehouse`/`herdr` binaries
  (scratch project, never the user's real `~/.ledger`): confirmed
  `treehouse get --lease` + `herdr workspace create --cwd` together produce
  exactly the ids the `agents` row needs, and confirmed the failure-cleanup
  path (see fix above) with an intentionally-invalid dispatch.
- Did **not** exercise a real `herdr agent start --kind claude` (or any
  other real kind) end-to-end — that would spawn an actual live, billed
  coding-agent session as a side effect of testing. Validated `startAgent`/
  `promptAgent` against herdr's documented contract and the same JSON
  envelope/error-handling behavior already proven correct by the other
  live herdr calls in this session. Worth a real end-to-end dispatch by
  hand before relying on it unattended.
- All scratch state (test treehouse pool, test project clone, probe herdr
  workspaces) cleaned up; confirmed the user's own existing treehouse pools
  (`dwd`, `firstmate`, `laravel-doctrine-inertia-starter`, `ledger`) were
  left untouched throughout.
- Linked the plugin for real (`herdr plugin link .`) against the user's live
  herdr install to validate `herdr-plugin.toml` itself — this is a local,
  reversible, machine-only side effect (`herdr plugin unlink ledger` to
  undo), and is required for the watcher to actually be live. Caught and
  fixed the wrong-event-name bug this way (see above). Left it linked and
  enabled, since that's what "implement the watcher" means functionally —
  unlink it if you'd rather review before it's live against your real
  session.
- **Captured and fixed a second real bug this way.** Temporarily had
  `src/plugin/watcher.ts` append every raw `HERDR_PLUGIN_EVENT_JSON` it
  received to a debug file, then waited for this session's own pane
  (running this very Claude Code session) to naturally transition
  idle → working → idle. The captured payload:
  `{"event":"pane_agent_status_changed","data":{"type":"pane_agent_status_changed","pane_id":"w3:p1","workspace_id":"w3","agent_status":"idle","agent":"claude"}}`
  — **wrapped** in an `{event, data}` envelope, with an underscored `event`
  name (`pane_agent_status_changed`) even though the manifest's `on` field
  is dotted (`pane.agent_status_changed`), and the actual fields nested
  under `data`, not flat at the top level. The watcher had been reading
  `pane_id` off the top level, which would have silently no-op'd on every
  real invocation forever (no crash, no log — the "no matching agents row"
  branch would've swallowed it, since a flat-parsed object has no
  `pane_id`). Fixed to read `envelope.data.pane_id` etc., removed the debug
  logging, rebuilt. Re-verified end-to-end against a scratch DB seeded with
  a fake `agents` row at `herdr_pane = 'w3:p1'`: replaying the exact
  captured payload through the rebuilt watcher correctly flipped
  `agents.status` and wrote the `events` row. This is now the one part of
  the system that's been proven against a real herdr-delivered payload,
  not just against the documented/inferred contract.
