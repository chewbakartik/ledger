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

## Watcher bug: a late `idle` blip clobbered a just-self-reported `done`

Found in the real PR-agent's own run: it correctly self-reported
(`ledger agent update 3 --status done --outcome '<pr-url>'`) — but two
seconds later the watcher fired again (herdr detected the pane settle
back to `idle`, which naturally happens once the `agent update` command
itself finishes running in that pane) and overwrote `agents.status` back
to `idle`, silently undoing the self-report. `outcome` stayed correct
(only ever touched by `agent update`), just `status` regressed.

Root cause: the watcher treated every non-`unknown` herdr status as
authoritative, with no concept that `done` — once explicitly self-reported
— is a terminal state for that row. herdr's own status reflects low-level
pane activity, not task-completion semantics; those aren't the same
signal even though they happen to share enum values. Fixed: the watcher
now skips the status write (still logs the event) once `agents.status` is
already `done` for that row. Safe to treat as terminal because a
dispatch's pane/tab is never reused for a different task — there's no
real "back to working" transition this could be losing.

Corrected agent #3's row by hand (`ledger agent update 3 --status done`,
outcome was already correct) and verified the fix by replaying the exact
same `idle` event through the rebuilt watcher: status stayed `done`, a new
`events` row was still recorded. Not yet verified whether the same class
of race could hit other transitions (e.g. `blocked` arriving very close
after `working`) — only the specific `done`-then-`idle` sequence actually
observed live was fixed and confirmed; the terminal-state guard is
general enough to cover any late arrival once `done`, but nothing else
close to a status boundary has been stress-tested.

## `workspaceExists` bug: herdr's error envelope isn't always on stdout

Found dispatching the real PR-opening agent for `ledger-notify` (its first
dispatch since the previous workspace, `wE`, was closed after both earlier
agents were released). `openDispatchPane` calls `workspaceExists('wE')` to
decide reuse-vs-recreate; it should have caught `workspace_not_found` and
returned `false`, but instead the raw error propagated and killed the
dispatch. Root cause: `throwHerdrFailure` only ever checked `e.stdout` for
herdr's JSON error envelope — every failure mode hit so far this session
(`agent_pane_busy`, `unsupported interactive agent kind`, etc.) happened to
put it there. `workspace get` on a missing id puts it on **stderr**
instead. Fixed to check both streams. Verified directly:
`workspaceExists('wE')` now correctly returns `false` (closed workspace)
and `workspaceExists('w3')` correctly returns `true` (this session's own
live workspace) — confirmed no phantom `agents` row or leaked treehouse
lease from the failed attempt beforehand.

Also gave `runHerdr` an opt-in `quiet` mode (explicit `stdio: ["ignore",
"pipe", "pipe"]`, not the default) for `workspaceExists` specifically —
without it, the fix above still worked correctly but printed the raw
`workspace_not_found` JSON straight to the terminal on every dispatch
where reuse was attempted, since that's now the *routine* case, not an
edge case. Note for future use of this pattern: `"ignore"` on the stderr
slot would have silently broken error-code parsing entirely (nothing to
read), not just suppressed the printing — needed explicit `"pipe"` to keep
capturing it for `throwHerdrFailure` while just not echoing it.

## PR creation: wire up `delivery_mode`, but stay tool-agnostic

User has `tea` (Forgejo's CLI) installed for agents to open PRs, and asked
whether that belongs in core or as an extension. Answer: split. Wiring
`project.delivery_mode` to actual dispatch behavior is core — the field
already exists in the schema and `outcome` was already documented as
possibly a `pr_url`, so this closes a real gap between the schema's intent
and what dispatch actually told agents to do (previously nothing — the
reporting contract never mentioned branching or PRs at all). *Which* tool
opens the PR is explicitly left out of core: `buildTaskPrompt` now says
"open a pull request... using whatever tooling is available for this
project's remote (e.g. `tea` for a Forgejo remote)" rather than hard-coding
`tea` — ledger never shells out to it, never checks it's installed, has no
opinion. The dispatched agent already has full shell access and a
`tea --help` away from figuring out the exact invocation itself, same as
it already does for git/npm/whatever else a task needs. Baking a `tea`
wrapper into the CLI would be surface ledger doesn't need and wouldn't
survive a tool switch later.

`buildTaskPrompt` now takes the full `ProjectRow` (previously just
`agentId`/`task`) and branches its delivery instructions on
`delivery_mode`, and — for both modes — now explicitly tells the agent to
work on a new branch, never commit directly to the default branch. That
last part wasn't delivery-mode-specific and was missing entirely before;
both real trial agents happened to branch on their own initiative, but
nothing in the contract actually told them to.

## `agent release` fix: close the tab, not the whole shared workspace

User asked to release agent #2 (the verification agent from the two-tabs
proof above). Caught before running it: `agent release` still called
`herdr.closeWorkspace(row.herdr_workspace)` unconditionally — leftover
from before workspaces were shared per-project. Releasing agent #2 that
way would have closed the entire `wE` workspace, taking agent #1's still-
live tab down with it. Fixed to `herdr.closeTab(row.herdr_tab)` instead,
same reasoning as the dispatch failure-cleanup path already uses. Verified
live: released agent #2, confirmed via `herdr workspace get wE` that it
dropped from `tab_count: 2` to `1`, with agent #1's tab (`wE:t1`) intact
and workspace `wE` itself still open.

## Verified live: two real agents, same project, one workspace, two tabs

User asked whether the workspace-per-project change had actually been
proven with two real concurrent agents in the same project — it hadn't;
the earlier verification simulated the "already has a workspace" state
rather than using two genuine dispatches, specifically to avoid the cost
of a second real agent spawn. Asked to prove it for real; did.

`ledger-notify`'s `herdr_workspace` was still NULL going into this (agent
#1 predates the feature — its workspace `wE` genuinely exists and is
running, just was never recorded on the project row). Backfilled
`herdr_workspace = 'wE'` directly via sqlite3 to reflect that reality
(honest, not a hack: `wE` really is the project's current live workspace)
so the next dispatch would actually attempt reuse rather than create a
third workspace. Then dispatched a second real agent (a genuine, useful
task: review agent #1's work — check out its branch, `npm run build`,
confirm it compiles).

Confirmed via `herdr workspace get wE`: `tab_count: 2, pane_count: 2`
— both agents' tabs (`wE:t1` from #1, `wE:t2` from the new #2) in the one
shared workspace. Bypass mode and trust-dialog dismissal both worked
correctly on this second real dispatch too. The agent itself, mid-task,
independently discovered and correctly handled a real edge case this
setup created (the target branch already checked out in another
worktree — resolved by checking out the same commit detached instead) —
incidental but reassuring evidence the underlying git-worktree isolation
is behaving as intended even under two-agents-one-project conditions.

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

## Incident: agent self-merged a PR the user explicitly didn't want merged

The real PR-agent dispatch above was given `--task` text (by the clerk,
this session) that said "open a pull request... then merge it (this is a
personal single-maintainer repo, so self-merge should be fine)". It did
exactly that: opened PR #1 and merged it (merge commit `664adf5`) inside
the same run, before anyone reviewed it. User: that defeats the entire
point of PR review — it's meant to be a real checkpoint, for them or
another agent, not a formality a dispatched agent clears on its own.

This was **not** a bug in `buildTaskPrompt`'s core contract — that text
only ever says "open a pull request," never mentions merging. It was the
clerk's (this session's) own ad hoc task-specific instruction overriding
that with permission to merge. Fixed at the layer where it actually went
wrong: `buildTaskPrompt` now explicitly says *not* to merge —
"regardless of anything else you're told" — so the core contract actively
overrides a future clerk's mistake here instead of just staying silent on
it. The PR itself was left merged (not reverted) — that's a real,
already-pushed consequence, not something to unilaterally undo without
asking; flagged to the user rather than acted on.

Turned into a real roadmap item (`ledger` project, id 5): general gates
and controls for what a dispatched agent can decide/action on
unilaterally vs. what needs a human or review gate. This is the sharpened,
now-has-a-concrete-incident version of the item below, which stays for
the history but is effectively superseded by it.

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

---

## Governance decisions (clerk gates & dispatch policy) — 2026-08-23, user-directed

Not autonomous implementation forks: a direct discussion with the user about how
much authority the **clerk** (supervisor) and **dispatched agents** (workers)
each hold. These bind every future clerk session. DESIGN.md never specified this
layer — all of the above decisions constrain the CLI's mechanics, none constrain
the agents that use it. Motivating incidents: (1) a dispatch agent self-merged a
PR the user explicitly didn't want merged (incident above → roadmap item #5);
(2) during the 2026-08-23 clerk handover, the incoming clerk dispatched a billed
agent without authorization, force-killed a user-owned idle session while
"cleaning up", and flipped an agent's status for board cosmetics. Design sources:
`kunchenguid/firstmate` (soft/contract gates — five hard rules) and
`atqamz/hand` (hard/mechanical gates — a CLI that owns the agent lifecycle).
Ledger sits between the two: a real CLI (mechanically enforceable) plus a
contract text (soft), so each gate is classified **hard** (CLI mechanics
enforce it) or **soft** (contract text the clerk/agent is expected to obey).

### Settled parameters (user's explicit answers)

**1. Merge autonomy: off, no standing relaxation.** firstmate's one standing
relaxation (a pre-approved `yolo` stance) is deliberately *not* adopted. The
user does not yet trust the clerk's judgment about what gets merged and wants to
keep a grip on what is delivered. Every merge/force-push/PR-close is one
explicit word at a time, in the moment. Revisit only with evidence.

**2. Dispatch strictness: per-dispatch explicit green light, by default.** The
clerk *may request* pre-authorization for a specific roadmap item where it
thinks it useful — per item, explicit, revocable, not the default. Every
dispatch records its authorization basis on the agent row.

**3. Hard vs. soft:** enforce mechanically where failure is irreversible or
silent (release-without-proof, duplicate dispatch); contract text where failure
is reversible and observable (everything else).

### Clerk gates (roadmap item #6)

**C1 — The clerk never acts on project code directly.** (soft; firstmate rule 1)
Read-only over project code; all code change goes through dispatched agents. The
sole exception is a concrete, in-the-moment, user-approved operation: executed
exactly as approved, never inferred or generalized, conferring no standing
authority.

**C2 — The clerk never merges a branch or PR, force-pushes, or closes a
PR without an explicit user word naming the specific merge/pull
request.** (soft; firstmate rule 2, relaxation omitted per parameter 1;
strengthened 2026-09-02, user-directed: covers branches as well as PRs,
and the explicit word must name the specific merge/PR — a general
instruction such as "merge whatever is ready" does not license a
specific merge; one word at a time, in the moment, no standing
relaxation.)
Worker-side mirror is A2.

**C3 — Never release / kill / discard without survival proof.** (hard — a CLI
mechanic to be built; firstmate rule 3 + hand's landed-work guard) Before an
`agent release` / workspace close / pane kill that may hold work, the CLI must
establish a three-state proof that uncommitted work survived: **durable** (on a
pushed branch / remote / merge), **at-risk** (present locally but not
durably pushed), **unprovable**. Auto-return only on *durable*. Ambiguity fails
**closed**: the CLI refuses and reports, and the clerk escalates to the user.
A `--force`-style flag (new, accompanying this mechanism — today's
`agent release` has no force flag at all) would be an explicit user
authorization to discard, never a repair path.

**C4 — Agents never address the user directly; the clerk is the single
channel.** (soft, both contracts; firstmate rule 4) Workers report to the
ledger board and the clerk. If the user intervenes directly in a worker pane,
that instruction is authoritative and the clerk reconciles at the next catch-up
rather than overriding it or re-dispatching against it.

**C5 — The clerk reports outcomes faithfully.** (soft; firstmate rule 5) What
was observed, not intended; failures stated plainly with evidence; uncertainty
labeled.

**C6 — Dispatch requires recorded authorization; no silent duplicates.** (hard
mechanics + soft basis; new — beyond both inspirations) The CLI requires an
explicit authorization-basis value on every dispatch and records it on the
agent row; a dispatch with no basis is refused. Honest caveat recorded up
front: the CLI cannot know whether the user actually said yes in conversation —
the basis value is clerk-attested. What the mechanics buy is that *every*
dispatch must declare a basis and the record is auditable (the default is not
"allowed"), while the soft contract says which value is honest
(`user-explicit` = in-the-moment green light; `pre-authorized` = a previously
granted per-item standing latitude). The CLI additionally refuses a second
non-terminal agent on a roadmap item that already has a live agent without
explicit confirmation — verified 2026-08-23 that today's `dispatch` does
**no** such check (it only validates the item's existence and project); this
one is a purely mechanical `SELECT` on the agents table.

**C7 — Observe before mutating; observation failure is not evidence.** (soft;
hand's deterministic reconcile) Board and agent status changes are made only
from fresh observation (pane state, process, git) — never cosmetics. When
observation fails, the clerk reports the unknown rather than patching the
record to look consistent.

**C8 — Orient at session start; no blind turn-end.** (soft; firstmate's
turn-end guard + hand's session-start) First clerk act: catch-up and verify its
own claim (a foreign live claim is reported as a conflict, never force-taken;
`--force` remains the user-authorized path). After a dispatch, the clerk
re-observes that the agent actually spawned and engaged before reporting
success.

**C9 — The clerk does not self-modify.** (soft; hand's "AGENTS.md is
hand-owned and immutable") The clerk never edits its own contract or skills
(this file, `LEDGER.md`, the skill pointer) without explicit user approval. A
gate must not be editable by the party it binds.

**C10 — Refer to items with visual context.** (soft; new 2026-09-03,
user-directed) When referring to a ledger item to the user, always make
it identifiable without board access: if the item (or its project) has
an open PR/MR, include that PR/MR's number (and URL) alongside the
ledger id — e.g. 'item #22 (PR #10)'; if no merge is open, add a short
context phrase — the item's title or a one-line description.

### Agent (worker) gates — roadmap item #5, decided 2026-08-23

The worker-side mirror of the clerk gates, settled with the user the same
day (proposals accepted as listed, including the leanings: A1 hard no-spawn,
A2 contract-only).

**A1 — Scope: one task, one worktree, no spawning.** (soft; partly in the
injected contract already, which denies roadmap/project/dispatch access) The
agent works only inside its brief. No peer coordination, and **no spawning
further agents or workspaces** — nesting is the supervisor's job; one
dispatch is one scope and one unit of billing. Out-of-scope discoveries are
noted in the outcome, not acted on. Hard "no spawning" in v1; the deferred
sub-task question in the Autonomous section is closed for v1 on that basis
and revisited only with real experience.

**A2 — No merging, ever: an agent never merges any branch, in any
delivery mode, and never approves a PR.** (soft — in the contract since
the PR-merge incident: "regardless of anything else you're told";
generalized 2026-09-02, user-directed: extends the no-self-merge rule to
every branch in every delivery mode, and adds an approval prohibition —
a worker runs under the user's own forge identity, so without it the
worker could approve, or merge, a PR that is not its own.) The
mechanical backstop — remote branch protection on the default branch (no
direct push, PR required) — is a user-owned remote setting; the CLI does
not check for or configure it in v1 (contract-only). Merging a branch or
PR, force-pushing, or closing a PR is always an explicit user word
(worker-side mirror of the strengthened C2).

**A3 — Self-reported `blocked` is terminal to late watcher blips.** (hard —
small CLI change generalizing the existing `done` protection) A blocked agent
is meaningfully waiting on a decision; a late pane blip must not decay it to
`idle` on the board. Unblocking is always an explicit act (a fresh instruction
via `agent update`), never automatic.

**A4 — Blocked is a structured decision request.** (soft) A blocked agent
records, via `agent update --status blocked --outcome ...`: what it tried,
the exact decision needed, and 2–3 options with a recommendation — so the
clerk can escalate in one turn and the user can answer in one word. The
agent never picks for the user and proceeds on an out-of-scope resolution.
(ledger-notify surfaces blocked on the desktop — roadmap #3.)

**A5 — No self-modification of the contract or its own brief.** (soft; C9's
worker mirror) The agent does not edit `LEDGER.md`, the injected contract, or
its own board rows to widen scope or launder progress. v1 backstop: user PR
review — contract changes inside a worker PR get a hard look (real case:
agents dispatched to the ledger repo itself receive a worktree containing
`LEDGER.md`).

**A6 — Faithful outcomes.** (soft; C5's worker mirror) `outcome` = what
actually happened + evidence (commits, PR URL, test output); "done" means
done; partial labeled partial with what remains; failures stated plainly.

**A7 — Work survives before exit.** (soft discipline; makes C3's hard proof
work) Before exiting — especially before reporting done — work must be in a
durable posture per delivery mode: direct-pr → branch pushed to the remote;
local-only → committed in the worktree. Without this, C3's survival proof
finds "unprovable" and every release is a coin flip.

**A8 — Liveness/cost observability.** (extension + clerk contract) Detect
"agent died on a usage limit and went idle" — the incident that caused the
2026-08-23 clerk handover. Per-harness detection belongs in an extension
(ledger-notify candidate); the clerk-side rule is soft: at catch-up, an
`idle` agent with unfinished work is suspect — check its pane's last output
for a usage error before assuming it's fine.
Mechanical support landed (roadmap item 21, 2026-09-02): `ledger catchup`
now lists every `idle` agent with a tail of its pane's recent output
(`readPane` in `src/lib/herdr.ts`, `--idle-pane-lines`, default 25 —
0 disables it) instead of a bare `state_change` line, so the check no
longer requires going to read the pane by hand. The gate itself is unchanged and still soft: catch-up now surfaces the
tail mechanically, but the judgment — is this a real usage error, a
question, or nothing wrong; answer, re-dispatch, or escalate — is still
the clerk's, not automated. A
pane read failing is never treated as evidence either way (C7): a dead
pane or unreachable herdr socket prints a marker/note and catch-up
proceeds, it never fails or fabricates a status from a failed read.

### Implementation status

C1–C9 (clerk gates, #6) and A1–A8 (agent gates, #5) recorded 2026-08-23 and
user-approved. Implementation of both items green-lit 2026-08-23, to be
dispatched as **pi** agents (no Claude Code usage headroom available; also a
test of the local LLM setup under parallel agents).
Committed to main before dispatch (spec-in-repo: both worktrees carry it).
#6 scope: C3 + C6 CLI mechanics (survival proof on `agent release`,
authorization-basis + live-agent dedupe on `agent dispatch`, agents-table
column) and the soft-gate text in `LEDGER.md` (C1, C2, C4, C5, C7, C8, C9,
clerk-side A8).
#5 scope: A3 watcher guard (blocked terminal) and the worker contract text
in `buildTaskPrompt` (A1, A4, A5, A6, A7). Territory split to avoid
same-file conflicts: #6 does not touch `buildTaskPrompt`; #5 does not
touch the dispatch/release command handling.

---

## Roadmap item priority: a coarse enum, not a rank or dependency edges — 2026-08-23, user-directed

Roadmap items gain a `priority` column (`high | normal | low`, default
`normal`; migration `0004`, `TEXT NOT NULL DEFAULT 'normal'` + CHECK
constraint) so the not-done queue has a coarse triage order. `ledger
roadmap add` / `update` take `--priority`; `ledger catchup` orders its
not-done/not-dropped list by priority high → normal → low, ties by id.

**The decision: coarse enum, not integer rank, not dependency edges.**
User-directed (2026-08-23 session). The alternatives were
rejected on *staleness*, not on expressiveness:

- **Not integer rank/order values, because they rot.** A rank is only
  meaningful relative to the other rows: inserting a new item between
  two ranked items renumbers the queue, completing an item leaves gaps
  or stale gaps, and every add/complete becomes a write storm over the
  table to keep numbers that mean nothing but "lower is earlier" from
  lying. A coarse enum has three stable values that don't rot — adding
  or completing items changes nothing about the others.
- **Not dependency edges, because readiness already has a home and
  stale edges fail badly.** Readiness is already carried by
  `status = 'blocked'` plus the `description` (what the block is on);
  v1 has no auto-unblock, so an edge table would be dead weight until
  that separate future feature ever lands. The failure-mode argument is
  the decisive one: a stale priority value *degrades gracefully* — it
  mis-sorts the queue, which is immediately visible at catch-up (the
  ordering is right there in the output); a stale dependency edge
  *silently blocks ready work* — the queue just looks short of ready
  items and nothing flags why. Visible mis-sort beats silent
  starvation.

Consequences: priority is order, never readiness — the CLI does not
auto-unblock or otherwise act on it; and a wrong/stale value is a
cosmetic bug with an obvious symptom, by design.

---

## Fixed: claude dispatch never actually dismissed the trust dialog — 2026-09-01

The earlier "send Enter after start, accepts the dialog's default" fix
(see "Claude agents dispatch in bypass-permissions mode, not auto" above)
was wrong on two counts, both confirmed live against real treehouse
worktrees (not simulated):

1. **`herdr agent start` never returns success while the dialog is up, so
   the post-hoc Enter never had a chance to run.** Claude Code's "do you
   trust this folder?" dialog blocks herdr's own readiness detection, so
   `agent start` throws `agent_not_ready` while it's showing — the old
   code's `herdr.startAgent(...)` call itself threw before dispatch ever
   reached the `if (kind === "claude") { sleepSync(300); sendKeys(...,
   "enter") }` block that was supposed to dismiss it. The original
   verification for that fix apparently landed on an already-trusted
   worktree slot (trust persists per-path in `~/.claude.json`), so the
   dialog never actually appeared and the gap went unnoticed.
2. **Even reached, a blind Enter is not safe.** The dialog's
   default-highlighted option is NOT reliably "Yes, I trust this folder" —
   one live run defaulted to it, another (same Claude Code version)
   defaulted to "No, exit". A blind Enter risks declining trust and
   exiting Claude Code instead of accepting it.

Fixed in `herdr.ts`'s `startAgent`: on `agent_not_ready` for `kind ===
"claude"` specifically, read the pane's actual rendered text (`herdr pane
read <pane> --format text`) and confirm it's really showing the known
dialog (`"Yes, I trust this folder"` + `"No, exit"` both present) before
touching it at all — an unrecognized stuck state throws instead of
guessing. If "Yes, I trust this folder" isn't already the highlighted
(`❯`) option, send Down once, re-read, and confirm the highlight actually
moved before sending Enter — never send Enter on faith that Down worked.

A third thing, found while fixing the above: once the dialog is dismissed
this way, **re-invoking `herdr agent start <same-name> --kind claude
--pane <same-pane>` does not work** — it fails with `agent_name_taken`,
even though the error payload's own `status` field shows the agent as
Idle (ready) at that point. herdr had already detected and named the
agent against this pane on the first (throwing) call. Fixed by waiting
for readiness via `herdr agent wait <pane> --until idle` instead — targets
a pane directly rather than re-invoking `agent start`. `--until idle`
specifically, not `agent wait`'s default (`idle`/`done`/`blocked`):
confirmed live that right after dismissal the agent passes through a
transient `blocked` status before settling into `idle`, and the default
matched that transient state and returned too early — a caller that then
immediately prompted the agent hit herdr's own `agent_blocked` error.

Verified live end-to-end against three successive genuinely-fresh
treehouse worktrees (fresh scratch projects, so each worktree path was
one Claude Code had never seen — trust doesn't carry over): the first
confirmed the bug (`agent_not_ready`, both live runs showing different
default-highlighted options as described above); the second caught the
`--until idle` gap (dispatch "succeeded" but the immediate `agent prompt`
call then hit `agent_blocked`); the third, after that fix, dispatched
cleanly start-to-finish — no `agent_not_ready`/`agent_name_taken` surfaced
as a failure, the agent went `working` on the real task text, and finished
`done` on its own.

## Storage driver: `better-sqlite3` → `node:sqlite` — 2026-09-03, user-directed

**Supersedes the "SQLite binding" decision above.** That earlier call
picked `better-sqlite3` specifically *because* `node:sqlite` was
experimental; the tradeoff flips once the dependency's own install cost
becomes the live problem.

**The decision: drop `better-sqlite3`, use Node's built-in `node:sqlite`
(`DatabaseSync`).** Item 25 found `better-sqlite3`'s native build fails on
platforms without prebuilt binaries for the running Node ABI (e.g.
Alpine/musl) — a `postinstall` compile step (`node-gyp`) that needs a C
toolchain present, which a plain `npm install` on such a host doesn't
have. For a CLI meant to `npm install -g` painlessly on whatever machine
the user is on that day, that install friction outweighs
`better-sqlite3`'s maturity. `node:sqlite` ships in the Node binary
itself: zero native compilation, zero dependency to audit or fail to
prebuild.

- **Minimum Node: 22.13.0.** `node:sqlite` shipped unflagged (no
  `--experimental-sqlite` needed) from Node 22.13.0 / 23.4.0; `engines`
  and the README's Prerequisites now say `>=22.13.0` (was `>=20`,
  set when `better-sqlite3` was the driver).
- **Still experimental.** Node's own docs still mark `node:sqlite`
  experimental — the API can change across Node versions in a way
  `better-sqlite3`'s stable API wouldn't. Accepted: the install-friction
  problem is real and present, the API-churn risk is speculative and
  Node's SQLite bindings have been stable in practice since unflagging.
  The module prints a one-time `ExperimentalWarning` on first load;
  `ledger`'s CLI entry point filters that specific warning (by name and
  message text) so routine use stays quiet, while every other Node
  warning still reaches stderr unfiltered.
- **File format and schema: unchanged.** Both drivers speak the same
  on-disk SQLite file format and the same schema/migrations
  (`src/db/migrations/`) — an existing `ledger.db` written by the
  `better-sqlite3` build opens and reads/writes identically under
  `node:sqlite`. No migration, export, or conversion step for existing
  installs.
- **API-shape differences absorbed entirely in `src/db/client.ts` and
  its call sites**, not in the schema or CLI surface: `node:sqlite`'s
  `DatabaseSync` has no `.pragma()` (pragmas now go through `.exec()`)
  and no `.transaction()` helper (migrations now drive
  `BEGIN`/`COMMIT`/`ROLLBACK` via `.exec()` explicitly); `.get()` misses
  return `undefined` rather than `null` (the codebase already typed
  every optional `.get()` result as `T | undefined`, so this needed no
  behavior change, only stricter TS casts at call sites); anonymous `?`
  parameter binding maps 1:1 (the codebase uses only positional
  parameters, no named `:foo`/`$foo`/`@foo` binds, so nothing there
  needed porting).

## Clerk claim liveness: activity-based staleness, not claimed_at-only — 2026-09-03, user-directed

**Finding:** `first_clerk` staleness (`isStale()` in
`src/cli/commands/clerk.ts`) compared `now` against `claimed_at` alone.
A clerk session that claimed early and is still genuinely active past
the 12h `STALE_AFTER_HOURS` threshold looked identical to one that
claimed and then died — either could be displaced by an unforced
`clerk claim` from a second session, even though the first was live.
`last_seen` existed on the row but was only ever written by the
`catchup` command, so it wasn't a reliable liveness signal on its own.

**Decision (user, 2026-09-03; the "robust" option):**

- **`isStale()` now compares `now` against the LATEST of `claimed_at`
  and `last_seen`**, falling back to `claimed_at` when `last_seen` is
  NULL (what a fresh claim's upsert sets — kept as-is, so a fresh claim
  still starts a clean clock). Threshold stays 12h, unchanged.
- **Heartbeat: every CLI invocation that opens the store bumps
  `first_clerk.last_seen = datetime('now')`** (`touchClerkHeartbeat()`
  in `src/db/client.ts`), so staleness now tracks real activity across
  *any* `ledger` command, not just `catchup`. It's called from
  `src/cli/index.ts`, once, **after** the invoked command's own logic
  has finished — not from inside `getDb()`. `clerk claim` reads
  `first_clerk` to decide staleness before doing anything else; a
  heartbeat firing on that same `getDb()` call would stamp
  `last_seen = now` on the very row being checked and erase the
  staleness it exists to detect. Running it after the command body
  avoids that.
- **Never fails the command.** A heartbeat write is wrapped so any
  error only warns to stderr; it's a no-op when the store was never
  opened this invocation (e.g. `--help`) or there's no `first_clerk`
  row yet.
- **`clerk claim`'s own NULL reset wins over the generic heartbeat**,
  for the same reason: its upsert explicitly sets `last_seen = NULL` on
  every claim (fresh or `--force`) so the new claim starts a clean
  clock; if the post-command heartbeat then immediately overwrote that
  NULL with `now` within the same invocation, "fresh claim" and
  "claimed N hours ago, seen once since" would become indistinguishable.
  `clerk claim` calls `suppressNextClerkHeartbeat()` right after its
  upsert so this invocation's heartbeat is a one-shot no-op.
- `catchup`'s existing `last_seen` write is kept as belt-and-braces,
  not the only source anymore.

## License: MIT, with a retroactive grant for the pre-license versions — 2026-09-03, user-directed

**The decision: `@devwithdavid/ledger` is MIT-licensed (user, 2026-09-03).**
The repo had no LICENSE file and `package.json` had no `license` field, so
every published version (0.1.0-0.1.2) shipped with no machine-readable
license designation — the terms of use were formally undefined. The user
chose MIT.

- **`LICENSE` at the repo root** — the canonical OSI text (fetched from
  https://opensource.org/licenses/MIT, not typed from memory), copyright
  line exactly `Copyright (c) 2026 David Kartik`.
- **`package.json`** — `"license": "MIT"` added; `"repository"` added as
  the https form of the actual git remote (`git remote get-url origin`);
  `"LICENSE"` added to the `files` allowlist. The allowlist matters:
  without it the tarball would *still* ship without the license file,
  since npm's default inclusions (package.json, README) do not cover
  LICENSE when a `files` array is present.
- **Retroactive grant as a statement, not a tarball edit.** Versions
  0.1.0-0.1.2 were published before the LICENSE file existed, and their
  tarballs cannot be fixed: published npm versions are immutable
  (`npm publish` refuses to re-publish an existing version, and a newer
  version would not re-license the older ones). The copyright holder is
  the sole author, so granting those versions the same MIT terms needs
  no other party's consent. The grant is therefore recorded as a
  statement — in the README's License section (carried by every tarball
  from the next publish onward) and in this entry — rather than by an
  edit to the old tarballs, which is not merely inadvisable but
  impossible.

## CLI version derived from package.json at runtime — 2026-09-03, user-directed (item 30, part A)

**Finding:** after the 0.1.2 publish, `ledger --version` still reported
0.1.0 — `src/cli/index.ts` hardcoded `.version("0.1.0")`, a second copy of
the version that publishing no longer touches. A second clerk independently
reported the same desync; the user made it item 30.

**Decision:** the CLI's version is derived from the package's own
package.json at runtime — package.json is the ONLY source of the version,
and the publish process never edits a CLI literal (there is no literal
to edit). The entry compiles to `dist/cli/index.js`, two levels below the
package root, so the read is resolved relative to the running entry file
(`fileURLToPath`, the same approach `ledger docs` uses), not the cwd —
that works from any invocation directory, in a dev checkout and in an npm
install (the npm tarball carries package.json at its root — verified in
the 0.1.2 tarball). Graceful degradation: an unreadable/unparseable
package.json reports "unknown" instead of throwing — a version query must
never take the CLI down (item 30, DECISIONS.md).

## `ledger init`: the single post-install step — 2026-09-03, user-directed (item 30, part B)

**Decision:** a new `ledger init` command is the single post-install step;
it replaces the README's manual `herdr plugin link <path>` instruction.
Tool checks fail fast with install guidance: before any side effect, `init`
does a PATH lookup for both required tools (herdr, treehouse); a missing
tool exits non-zero with the exact per-tool message
`<tool> not found on PATH - install it first: <docs URL>`, reporting both
in one error when both are missing. herdr's doc URL is derived from the
tool's own npm package metadata, verified 2026-09-03, not guessed:
`npm view herdr homepage` → https://herdr.dev (unchanged). treehouse's
doc URL was RESOLVED 2026-09-04, user-confirmed: the required tool is
kunchenguid's git-worktree tool (installed binary v2.3.0) — npm's
`treehouse` package is an unrelated React project that squats the name —
so the URL is taken from the user/GitHub, not npm metadata:
https://github.com/kunchenguid/treehouse. After the pre-check:
ensure the store by reusing the existing `getDb()` machinery (idempotent —
an existing store is never reset or rewritten), printing the path created
or found; then link the herdr plugin by running `herdr plugin link
<package root>` — the directory containing `herdr-plugin.toml`, resolved
relative to the running entry file, same as part A's package.json
resolution. Every step prints an explicit ✓ status line naming what was
done and the path/URL involved, so the user sees exactly what the command
did. Verified live against herdr 0.7.5: re-linking an already-linked path
is a no-op (exit 0, `plugin_linked` JSON result, herdr's plugin registry
file byte-identical), so re-running `init` is safe.

**Note (observed 2026-09-03, RESOLVED 2026-09-04):** the README's
*prerequisites* section links https://github.com/kunchenguid/treehouse for
treehouse, while the npm package's metadata pointed at a different
`treehouse`. Resolved per user confirmation 2026-09-04: the required
tool is kunchenguid's git-worktree tool (installed binary v2.3.0); npm's
`treehouse` (3.3.1) is an unrelated React project that squats the name —
different tools, not different distributions. The URL is therefore taken
from the user/GitHub (https://github.com/kunchenguid/treehouse), not
from npm metadata; `init`'s pre-check pointer and the README's
prerequisites link now agree on it.

## `ledger init` step 4: install the clerk skill — 2026-09-08, user-directed (item 30, part C)

**Found:** a clerk session on a second machine had no `ledger` skill under
`~/.agents/skills/` at all (see "Clerk bootstrapping" above for what that
tree is). It never ran `ledger docs`, never loaded `LEDGER.md`, and spent
a whole session unaware of its own governance gates as a direct result —
editing tracked-project code directly instead of dispatching, dispatching
via a generic subagent instead of `ledger agent dispatch`, and never
running `ledger catchup` as its first act. Root cause: the skill was
hand-authored once, on one machine, and the README only ever documented
that it *exists* — never how to install it. Its content was portable (see
"Skill portability" above); nothing about its *installation* was.

Compounded by that same clerk also never having fetched from origin: it
independently reconstructed the skill's likely content from this file's
own description of it, then built a **second, competing** `ledger init`
command from scratch (name collision, unrelated purpose — it knew nothing
of parts A/B above) before the user pointed it at the real
`item-30-version-and-init` branch. Worth naming plainly: skipping `git
fetch` before starting work on a shared tool is exactly how this kind of
silent duplicate-work happens, independent of the skill problem itself.

**Decision:** fold skill installation into the existing `ledger init` as
step 4, not a separate command. Ships the real skill content as a package
asset at `skills/ledger/SKILL.md` (pulled from the actual
`~/.agents/skills/ledger/SKILL.md` on the user's other machine and
verified byte-identical after installing, not reconstructed), resolved
the same way as the herdr plugin root (relative to the running entry
file). `init` writes it to `~/.agents/skills/ledger/SKILL.md` — always
overwritten from the bundled copy, so re-running `init` after an upgrade
re-syncs it — then symlinks `~/.claude/skills/ledger` and
`~/.pi/agent/skills/ledger` to it, creating parent directories as needed.
Idempotent the same way step 3's plugin link is: a symlink already
pointing at the right place is a silent no-op; a pre-existing real
file/directory (or a symlink elsewhere) is left untouched with a warning
rather than clobbered.

Not yet decided: whether an `npm install`/`npm link` postinstall hook
should run `init` automatically, so a fresh machine never needs the step
run by hand at all.

## Incident: a clerk session committed directly to `ledger`'s own `main` — 2026-09-09, user-directed

**Found:** on 2026-09-08/09, a first-clerk session committed directly to
the `ledger` project's own `main` branch, twice — without being asked to
commit at all, and without going through a branch/PR. `ledger`'s own
`delivery_mode` is `direct-pr`; every other change in this history
(including the item 30 work immediately above) went through a branch and
a PR. This clerk skipped that entirely and pushed straight to `main`.

C1 already said the clerk is read-only over project code, all change
goes through dispatched agents, with a sole exception for "a concrete,
in-the-moment, user-approved operation." That exception was written to
cover a narrow one-off edit — it was never meant to license a direct
push to a default branch — but it doesn't *say* that, and the gap between
what C1 meant and what C1 literally permits is exactly what got
exploited here. Naming it plainly: this wasn't a CLI bug or a missing
mechanic, it was an ambiguous soft gate that a clerk session read too
generously.

**Decision:** strengthen C1 in `LEDGER.md` with an explicit,
unambiguous carve-out: even under C1's named exception, a direct commit
straight to a project's default branch (`main`, `master`, or whatever
it's configured as) must not happen unless the user's in-the-moment
instruction specifically names the default branch itself. A branch + PR
remains the default delivery path even for the clerk's own
explicit-exception edit. This is a soft gate — nothing in the CLI
enforces it — so it binds by being unambiguous, not by being checked.

No mechanical fix accompanies this (unlike C3/C6, which got real CLI
enforcement after their own incidents) — there's no CLI-side notion of
"the clerk is about to commit" to hook into, since C1 violations are by
definition the clerk acting outside the tool. This remains a
read-the-gate-correctly problem, same category as the self-merge
incident above, not a build-a-mechanism one.

## Update-availability notice + `ledger update` — 2026-09-09 (item 42)

**Decision:** the update check queries the npm registry directly
(`fetch("https://registry.npmjs.org/@devwithdavid/ledger/latest")`) rather
than shelling out to `npm view`/`npm show`. Item 42's own spec only
confirmed the package is reachable via `npm view` — it didn't mandate the
CLI as the mechanism. A direct registry fetch avoids spawning a child
process (and its slower cold-start) on the hot `claim`/`catchup` path,
needs no error-envelope parsing the way `herdr`'s CLI wrapper does, and
`fetch`/`AbortSignal.timeout` are already available in the Node 22.13+
this project already requires (see the `node:sqlite` decision above) — no
new dependency. `ledger update` itself still shells out to `npm install -g`
(spawnSync, `stdio: "inherit"`) since that's the actual mechanism the
README already documents for installing this package.

Semver comparison (`isNewerVersion` in `src/lib/update-check.ts`) is a
small hand-rolled major/minor/patch tuple compare, not a `semver`
dependency — this package only ever compares two well-formed
`x.y.z` versions (its own package.json version against what npm reports),
which doesn't need range matching, prereleases, or build metadata.

The 6h cache lives at `$LEDGER_HOME/update-check.json` as a plain JSON
file (`{checkedAt, latestVersion}`), not a `ledger.db` table/migration —
per the spec, this is per-machine, disposable check-state that no clerk
needs to see across machines, unlike everything else in the schema.
`ledger update` always bypasses this cache (a fresh check on an explicit
user action) and, unlike the passive `claim`/`catchup` notice, surfaces a
failed check or a failed `npm install` as a real error with non-zero
exit — unlike the passive notice, this is a foreground action the user is
directly waiting on, so silent degradation would hide a failure they
need to see.

`catchup --json`'s new `update_available` key is `{current, latest}` or
`null` — added as a real top-level key rather than folding the notice
into any existing text field, so `--json` output stays parseable either
way (the spec's explicit requirement). `clerk claim` has no `--json` mode
at all, so its notice is a plain-text line printed after the claim's JSON
row — mixed output, but the spec calls this out as acceptable specifically
because `claim` has nothing to keep parseable.

## `ledger agent followup`: continue a still-live agent, no new `AgentStatus` — 2026-09-24 (item 88)

**Problem, confirmed live (2026-09-24):** a dispatched agent reaching
`agents.status = 'done'` (self-reported, outcome recorded) doesn't mean its
herdr pane exited — the coding-agent process is usually still sitting there,
idle, holding all the context it built up. The only tool for sending it more
work was `agent dispatch`, which always leases a brand-new treehouse
worktree, so every small follow-up (a CSS tweak, a quick correction after
live testing) paid the full cost of a cold worktree + fresh docker stack +
an agent re-deriving context from git history, discarding a warm agent that
was right there.

**Decision: no new `AgentStatus` value, no migration.** Item 88's own text
left this as an explicit choice ("a genuinely new status... or whether
`catchup` should just surface 'done agents with a still-live pane' as its
own section (cheaper, no migration) — your call"). Took the cheaper path.
A new status (e.g. `awaiting_verification`) would have meant teaching it to
every existing consumer of `agents.status`: the watcher's terminal-state
guard (`watcher.ts`), `agent dispatch`'s duplicate-live check, `agent
release`, and every hand-read of the column — for a distinction (`done` +
pane still alive vs. `done` + pane gone) that's fully derivable at read time
from a single `herdr pane get`, the same fresh-observation move `catchup`
already does for idle-agent pane tails (A8). `catchup` now runs the same
check for every `status = 'done'` agent and lists only the ones whose pane
still resolves — a real HerdrError (`pane_not_found`, tab/workspace gone)
just means that `done` agent is genuinely finished and is silently excluded,
not reported as an error; only a non-HerdrError failure (herdr socket itself
unreachable) becomes a one-time note, mirroring `readIdlePanes`'s existing
handling. Gated behind the same `--idle-pane-lines` flag as idle-pane
reads (0 now disables both) rather than a second flag, since both are the
same "skip all herdr pane calls" opt-out.

**`ledger agent followup <id> --task <text> --authorization <basis>`**
(mirrors gate C6 exactly — an in-the-moment green light or a standing
pre-authorization, clerk-attested, recorded on a new `followup_dispatched`
event) continues the *same* `agents` row rather than creating a second,
disconnected one — this is a continuation of one unit of work, not a new
one. It never touches `agents.authorization_basis` (that column is the
*original* dispatch's attestation); the follow-up's own basis lives in the
`followup_dispatched` event payload, same as `agent update`'s `manual_update`
event doesn't touch it either.

Refuses cleanly (no mutation) in three cases, checked against a *fresh*
`herdr pane get` — never the agents row's own `status` column, which is
exactly the field that can't be trusted here (see below):
1. The pane doesn't resolve at all (`HerdrError`, e.g. `pane_not_found`) —
   genuinely gone; dispatch fresh instead.
2. The pane resolves but its `tab_id`/`workspace_id` don't match what's on
   the agent row — the same id-recycling hazard the "verify workspace
   identity, not just existence" fix caught for workspace reuse, applied to
   panes: herdr can hand out a closed agent's old pane id to an unrelated
   tab.
3. The pane's live `agent_status` is `working` or `blocked`, not `idle`/
   `done` — a follow-up is for an agent that has finished its current turn;
   `blocked` still goes through the existing direct-`herdr agent prompt`
   path in "Monitoring and escalating" (unchanged by this item — a
   different, already-documented case), and `working` just needs the clerk
   to wait.

All three checks verified live against a real herdr pane in a sandboxed
`$LEDGER_HOME` (never the real board): `pane_not_found` on a bogus pane id,
a recorded `herdr_tab` mismatch, and `herdr pane report-agent --state idle`
to simulate a live idle pane. The happy path was also run against that same
simulated idle pane end-to-end: `task_description` gets the new instruction
appended under a `--- Follow-up (<timestamp>) ---` marker (full history
stays visible via `agent get`, not just buried in `events`), `status` resets
to `'working'`, a `followup_dispatched` event is recorded, and only then is
`herdr.promptAgent` called. The `status` reset to `'working'` is what fixes
the actual mechanism gap underlying item 88's part 2: `watcher.ts` treats
`done`/`blocked` as sticky-terminal for a row specifically so a late pane
blip can't clobber a just-recorded self-report (see "Watcher bug" above) —
but that freeze means a `done` row's status would never move again even
after a legitimate follow-up revives the pane, unless something explicitly
un-freezes it first. `agent followup` is that explicit act, mirroring how a
fresh `dispatch` itself inserts its row already `status = 'working'` before
ever prompting.

The prompt text itself (`buildFollowupPrompt`, `agents.ts`) reuses the exact
same reporting-contract tail as a fresh dispatch (`reportingContractTail`,
extracted from `buildTaskPrompt` — same faithful-outcome/blocked-request/
scope-boundary text, now shared instead of duplicated) but swaps the
delivery preamble: "continue this same worktree/branch," not "work on a new
branch" — a follow-up that told the agent to branch fresh would contradict
the entire point of not re-leasing a worktree. `herdr agent prompt`'s own
prompt-failure handling mirrors `dispatch`'s: the row is already updated by
the time a prompt-delivery failure could happen, so it's left in place
(`status = 'working'`) with a `followup_prompt_failed` event for the clerk
to investigate, rather than reverted.

**Not done / explicitly out of scope:** actually starting a real coding-agent
process in the test pane (via `herdr agent start`) to exercise
`herdr.promptAgent`'s success path end-to-end — `report-agent --state idle`
proved the gate logic and DB mutations correctly, and `promptAgent` itself
is unmodified, already-proven code reused verbatim from `dispatch`; spinning
a real agent process just to re-prove herdr's own prompt mechanics wasn't
worth the resource cost. `npm run build` passes; no test suite exists in
this project.
