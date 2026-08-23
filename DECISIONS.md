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

## Claude agents dispatch in bypass-permissions mode, not auto

User: dispatched Claude agents should run in `bypass` permission mode, not
`auto` — makes sense on its own (a dispatched agent has nobody present in
its pane to answer a permission prompt; `auto` mode still prompts for some
actions, which would just stall it forever). Scoped to `claude` only, per
the user, not every coding-agent kind.

Implementation needed two things, both verified live:

1. **The actual flag.** `herdr agent start` passes anything after `--`
   straight through to the launched binary's own argv (confirmed via the
   `argv` field in its own response). Used `--permission-mode
   bypassPermissions` — Claude Code's own documented mode enum (`auto`,
   `bypassPermissions`, etc. — the user's "bypass not auto" language maps
   directly onto it), added to `startAgent`'s existing pattern of a generic
   `extraArgs` passthrough rather than a claude-specific parameter, kept in
   `agents.ts`'s dispatch orchestration (`CLAUDE_BYPASS_ARGS`) rather than
   in the herdr wrapper, since it's ledger's policy choice, not a herdr
   concern.

2. **A real, separate blocker found while verifying this: Claude Code's
   "do you trust this folder?" dialog.** Neither `--permission-mode
   bypassPermissions` nor `--dangerously-skip-permissions` skips it —
   tested both live, dialog appeared either way. Every treehouse worktree
   is, from Claude Code's point of view, a folder it's never seen, so a
   dispatched agent would sit at this dialog forever with nobody there to
   answer it. Considered pre-writing `hasTrustDialogAccepted: true` into
   `~/.claude.json`'s `projects[path]` entry (confirmed that's where the
   "yes" answer persists) but rejected it: that file is Claude Code's
   entire global state across every session on the machine, not just
   ledger's — full read-modify-write of something that large and sensitive
   for this is a real corruption/race risk for a narrow gain. Went with
   the much smaller-blast-radius fix instead: send Enter after start
   (accepts the dialog's default, "1. Yes, I trust this folder"), same
   pattern as the earlier paste-submit fix. Verified live both that it
   correctly dismisses the dialog on a genuinely fresh directory, and that
   it's a harmless no-op when the directory was already trusted (sending
   Enter into an already-ready, dialog-free session did nothing observable)
   — meaning it's safe to send unconditionally rather than needing to
   detect whether the dialog is actually showing.

**A third bug found in the course of verifying this, unrelated to bypass
mode itself:** `herdr pane send-keys` returns *empty stdout on success*,
not herdr's usual JSON envelope — confirmed live. `runHerdr`'s generic
"every herdr command returns JSON" assumption was wrong for this one
specific command, and `sendKeys` (added for the earlier paste-submit fix)
inherited that assumption, so it threw `could not parse JSON output` on
every actual success. This means **the paste-submit fix from the previous
session was never actually exercised through the real TypeScript code
path** — it was verified only by running the equivalent `herdr` command
by hand in bash at the time, not through `promptAgent` itself, so the bug
in `sendKeys` went unnoticed until this dispatch (the first real one to
exercise that exact code path) hit it and its own failure-cleanup tore the
whole attempt down. Fixed by splitting `runHerdr` into two: the original
(requires a parseable JSON envelope) and a new `runHerdrAction` (tolerant
of empty stdout — success is "didn't throw," not "returned JSON"), sharing
the same error-extraction logic so failure handling didn't fork. `agent
prompt` itself was separately confirmed live to reliably return JSON, so
it stays on the strict path — this wasn't a systemic issue with every
herdr command, just this one.

Full chain verified together in one real dispatch (`bypass-verify`, a
throwaway project, cleaned up after): trust dialog dismissed automatically,
`bypass permissions on` visible in the pane, full task text delivered and
submitted (not stuck as an unsent paste), agent actively processed it, and
self-reported `done` via the injected reporting contract — the complete
path, for real, all three fixes working together.

## One herdr workspace per project, not per dispatch

User feedback after watching the trial run live: they expected the
dispatched agent to land as a new *tab* in their existing ledger workspace,
not a whole new workspace. Generalized: one herdr workspace per **project**
(created lazily, on that project's first dispatch), with every agent
working that project as a **tab** within it — not one workspace per
dispatch, which was an arbitrary choice on the implementer's part, not
something DESIGN.md specified.

This needed a real schema change (`projects.herdr_workspace`, migration
`0002_project_herdr_workspace.ts` — a plain `ALTER TABLE ... ADD COLUMN`,
no rebuild needed since it's just a new nullable column, unlike the
`repo_url` NOT NULL removal earlier). **This is the first migration
written and applied for real** — by this point `~/.ledger/ledger.db` has
real rows (the `ledger-notify` project and its agent from the trial), so
the "edit `0001_init.ts` directly" shortcut used earlier is no longer
available, exactly as flagged when that shortcut was taken. Verified the
migration against a **copy** of the real database before letting it touch
the real one automatically on next use — applied cleanly, existing rows
preserved, new column defaulted to NULL.

Dispatch logic (`openDispatchPane` in `src/cli/commands/agents.ts`): if
`project.herdr_workspace` is set and `herdr.workspaceExists()` confirms
it's still alive, add a new tab to it (`herdr tab create`); otherwise
create a fresh workspace (`herdr workspace create`, labeled with the
*project* name now, not a per-dispatch label) and persist its id onto the
project row — but only *after* `agent start` actually succeeds, same
reasoning as the `agents` row itself: a failed first-dispatch shouldn't
leave the project pointing at a workspace that just got torn down as part
of that failure's cleanup.

This also meant the failure-cleanup path had to branch: tearing down a
workspace this dispatch just created is still correct (nothing else lives
in it yet), but tearing down a *reused* workspace on failure would kill
every other agent's tab in that project — so on failure, only close the
one tab this dispatch opened (`herdr.closeTab`), never the shared
workspace. `deriveLabel` dropped its project-name prefix (task text only)
since it's now redundant — the project name lives on the workspace itself.

Verified live, without spawning any real agents (simulated "project
already has a workspace" by creating one directly via `herdr workspace
create` and hand-setting `projects.herdr_workspace` in a scratch DB, since
real data now exists and it'd be wasteful to spawn a real Claude session
just to test this): (1) reuse path — a failed second dispatch (`--kind
grok`, valid enum value, no local binary) added a tab to the existing
workspace, failed at `agent start`, and correctly closed only that tab —
confirmed via `herdr workspace get` afterward that the workspace survived
with its original tab intact (`tab_count` back to 1). (2) fresh-workspace
path — same failure mode against a project with no prior workspace:
confirmed the created workspace was fully closed, `herdr_workspace` stayed
NULL, no phantom `agents` row.

## First real trial dispatch: three real bugs found, all fixed

User dispatched the actual `ledger-notify` build (using `project init` and
the trial itself as the proof the earlier "known gap" section called out).
This is exactly what live testing is for — every one of these was
invisible to the `--kind bogus`/`--kind grok` failure-path tests run during
implementation, because those never got far enough to hit them.

**Bug 1 — `herdr agent start` fails immediately (`agent_pane_busy`) when
called right after `createWorkspace`, with zero delay.** `agent dispatch`
calls `createWorkspace` then `startAgent` back-to-back in the same
process — milliseconds apart. A pane that young isn't always at rest yet.
First hypothesis (herdr's own `--timeout` flag documents a 30000ms default
"wait for interactive readiness" that's skipped when the flag is omitted)
was tested and **wrong** — passing `--timeout 10000` explicitly changed
nothing, reproduced the identical immediate failure. What actually
resolved it in manual testing was real elapsed wall-clock time between the
two calls. Fixed properly in `startAgent` (`src/lib/herdr.ts`): retry
specifically on the `agent_pane_busy` error code with a synchronous
backoff (`Atomics.wait` on a throwaway `SharedArrayBuffer` — the standard
technique for a blocking sleep in synchronous Node code, no new
dependency), 300ms interval, 10s total budget. Any other error still fails
immediately, not retried. Confirmed live: the real dispatch that had
failed twice at this exact point succeeded on the third attempt (~3.3s
total, meaning the retry loop genuinely engaged and needed a couple of
rounds).

**Bug 2 — `herdr agent prompt` doesn't submit long/multi-line text, only
pastes it.** Confirmed by reading the actual pane content after a
"successful" dispatch: the task text sat in Claude Code's input box as
`[Pasted text #1 +12 lines]` — Claude Code's own TUI collapses a
long/multi-line paste into that placeholder and needs a separate Enter to
actually send it, and `herdr agent prompt` doesn't send that follow-up
itself. This isn't an edge case for this tool — `buildTaskPrompt` *always*
appends a multi-paragraph reporting contract, so every real dispatch hits
it. Manually confirmed the fix (`herdr pane send-keys <pane> enter`) makes
the agent immediately start working. Fixed in `promptAgent`
(`src/lib/herdr.ts`): always send the follow-up Enter. Also restructured
`--wait` handling while in there — the original code passed `--wait`
straight through to the `agent prompt` call itself, which would have
**deadlocked**: it blocks waiting for a state change that can't happen
until *after* the follow-up Enter is sent. Waiting (when requested) is now
a separate `agent wait` call issued after the Enter, not baked into the
prompt call. (Not live-tested with `--wait` specifically — the real
dispatch used the default, `--wait` not passed — but the deadlock in the
old code was structural/certain, not a maybe.)

**Live production confirmation, not just the manual repro:** once
unstuck, the real dispatch ran for real — `npm install`, writing
`watcher.ts`, running its own scratch tests — and the watcher plugin fired
for real too: `agents.status` flipped `working`→ (idle blip during
startup, not persisted since only non-`unknown` overwrites matter for the
column, but recorded) →`working` again as `ledger event list --agent 1`
shows, with `updated_at` changing on its own with zero manual DB writes
from me. This is the first time the watcher has been proven against a
real dispatch rather than a replayed/simulated payload.

## `ledger project update`: a second real gap, found while setting up the trial

User needed to register `ledger-notify` (the trial's own dispatch target)
before it existed anywhere — no repo, local or remote — which is what
motivated `project init` below. That immediately raised the natural
follow-up: once a from-scratch project's code exists and gets pushed
somewhere, there was no way to record that. Added
`ledger project update <name> [--repo-url <url>] [--delivery-mode <mode>]`
(`src/cli/commands/projects.ts`).

Found and fixed a real bug in my own first version of this while testing
it: if a git `origin` remote already existed, the command correctly left
git alone (never overwrite an existing remote) but still wrote the
*requested* `--repo-url` into the DB regardless — meaning `repo_url` could
silently diverge from the actual git remote after a second `project
update` call with a different URL. Fixed: `repo_url` is now always read
back from git itself when a remote already exists (never trusted from the
flag in that case), and a mismatch between the requested URL and the
existing remote surfaces as an explicit `warning` in the output instead of
being silently swallowed. Also suppressed git's own "No such remote"
stderr for the routine (non-error) "does origin exist yet" check in
`getRemoteUrl` — that stderr line was alarming noise for an expected,
handled outcome, not a real error.

## Deferred: scope of what dispatched agents are expected/allowed to do

Raised by the user, no specifics yet — explicitly parked as a topic to
expand later, not a decision made now. Current behavior (from DESIGN.md's
v1 default, `LEDGER.md`'s "For dispatched agents" contract, and what
`buildTaskPrompt` actually injects) is: an agent executes its one scoped
task, reports outcome via `agent update --status done --outcome ...`, and
escalates only by going idle mid-question (herdr's own `blocked`
detection, picked up automatically) — no roadmap/project/dispatch access,
no peer coordination. Whether that's the right boundary in practice —
e.g. should an agent be allowed to file a `ledger event add` note itself,
should it ever be allowed to dispatch a narrowly-scoped sub-task — is
open. Revisit once there's real experience (including from this very
trial) to reason from, same spirit as the deferred `LEDGER.md`-size
question above.

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
