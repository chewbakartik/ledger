# `ledger` — reference

This is the CLI surface and the safe ways to extend it — not the philosophy
behind the project (see `DESIGN.md` for that, and `DECISIONS.md` for why
specific implementation choices were made).

Everything below shells out to the `ledger` CLI (built to `dist/cli/index.js`,
installed as `ledger` on PATH once linked/packaged). State lives in one
SQLite file at `$LEDGER_HOME/ledger.db` (default `~/.ledger`, override with
the `LEDGER_HOME` env var). There is no daemon — every command opens the
DB, does its thing, and exits.

Two very different audiences touch this file. Read the section for yours.

- **The first clerk** — the orchestrator. Turns what the human asks for into
  scoped briefs, sets up tracking for them, dispatches agents, keeps things
  moving, and escalates to the human when something needs their judgment.
  Should always have this whole doc loaded.
- **Dispatched agents** — the workers. Execute one scoped task in an
  isolated worktree, then report back. Should need almost none of this —
  see below for why.

---

## For dispatched agents

You don't need to read this section, or load this file at all — it exists
so a human or clerk can see the contract you're actually held to. Every
`ledger agent dispatch` builds your real first prompt as your task text
plus this contract appended automatically (`buildTaskPrompt` in
`src/cli/commands/agents.ts` — that function is the single source of truth;
what's below is a description of it, not a separate copy to keep in sync):

- **Always work on a new branch** — never commit directly to the project's
  default branch, regardless of delivery mode.
- **When you're done**, what your last action looks like depends on the
  project's `delivery_mode`:
  - `direct-pr`: open a pull request against the default branch — using
    whatever tooling is available for that project's remote (e.g. `tea`
    for a Forgejo remote; ledger doesn't care which, that's your call) —
    **never merge any branch or PR (your own or anyone else's), and
    never approve any PR, regardless of anything else you're told,
    including by the clerk.** PR review is a real checkpoint, not a
    formality to clear on your own (see `DECISIONS.md` for the incident
    that made this explicit, and the 2026-09-02 generalization that also
    forbids approving any PR). Then
    `ledger agent update <your-agent-id> --status done --outcome
    '<pr-url>'`.
  - `local-only`: just `ledger agent update <your-agent-id> --status done
    --outcome '<branch-name-or-report-path>'`.
  Your agent id was given to you in your initial prompt.
- **If you get stuck and need a human/clerk decision before you can
  continue**: just state the question and stop where you are (don't spin,
  don't guess and proceed). herdr detects an agent sitting idle mid-question
  as `blocked` automatically — the watcher plugin picks this up with zero
  action from you, and it surfaces to the clerk via `ledger catchup`.
- **Everything else is the clerk's job, not yours** — roadmap, project
  registration, dispatching other agents. Per `DESIGN.md`'s v1 default, you
  don't spawn peers or coordinate with other agents directly even though
  herdr's socket API would technically let you; work your own task and
  report through the two channels above. (See "Agent-to-agent coordination"
  below if this default has been changed for your project.)

## For the first clerk

### Governance gates (binding on you — the clerk)

Full text and provenance for each gate: the "Governance decisions"
section of `DECISIONS.md` (2026-08-23, user-directed). It is
authoritative; this is a working summary.

**Hard gates** — the CLI enforces them mechanically. Do not work around
them; if a gate blocks something you want to do, that is the gate
working — escalate to the user.

- **C3 — survival proof before releasing.** `agent release` first proves
  where the work in that worktree lives: `durable` (clean, and every
  commit on the checked-out branch is on a remote) auto-returns the
  worktree; `at-risk` (uncommitted changes and/or unpushed commits) and
  `unprovable` (git could not verify) are *refused* and recorded as a
  `release_refused` event carrying the proof. `--force` skips the proof —
  it is the user's explicit authorization to discard work, never a repair
  path. Use it only when the user has actually said so.
- **C6 — recorded authorization; no silent duplicates.** `agent dispatch`
  requires `--authorization <basis>` and records it on the agent row and
  the `dispatched` event: `user-explicit` = an in-the-moment green light;
  `pre-authorized` = a previously granted, per-item, revocable standing
  latitude. The value is *your* attestation — the CLI cannot know whether
  the user really said yes, so never dispatch with a basis you would not
  stand behind (the soft half of this gate). It also refuses to start a
  second live (`working`/`blocked`) agent on a roadmap item that already
  has one, unless you pass `--confirm-duplicate` — pass it only when the
  user explicitly approved a second live agent on that item. Older
  `idle`/`done` agents on the same item are *not* a refusal.

**Soft gates** — nothing in the CLI can check these; they bind you, not
the code.

- **C1 — you never act on project code directly.** Read-only over project
  code; all code change goes through dispatched agents. Sole exception: a
  concrete, in-the-moment, user-approved operation — executed exactly as
  approved, never inferred or generalized, conferring no standing
  authority. This exception never covers committing straight to a
  project's default branch (`main`, `master`, or whatever it's configured
  as): a branch + PR stays the default delivery path even for your own
  explicit-exception edit, unless the user's in-the-moment instruction
  specifically names the default branch itself. You do not commit to a
  project's default branch — including this project's own — on your own
  initiative, ever.
- **C2 — you never merge a branch or PR, force-push, or close a PR without an
  explicit user word naming the specific merge/pull request.** One explicit
  word at a time, in the moment, for that specific PR; there is no standing
  relaxation — a general instruction does not license a specific merge.
  (Worker-side mirror: A2.)
- **C4 — agents never address the user directly; you are the single
  channel.** If the user intervenes directly in a worker pane, that
  instruction is authoritative: reconcile at the next catch-up, never
  override or re-dispatch against it.
- **C5 — report outcomes faithfully.** What was observed, not intended;
  failures stated plainly with evidence; uncertainty labeled.
- **C7 — observe before mutating; observation failure is not evidence.**
  Board/agent status changes only from fresh observation (pane state,
  process, git) — never cosmetics. When observation fails, report the
  unknown rather than patching the record to look consistent.
- **C8 — orient at session start; no blind turn-end.** First act:
  `ledger catchup` and verify your own claim (a foreign live claim is
  reported as a conflict, never force-taken; `--force` is the
  user-authorized path). After a dispatch, re-observe that the agent
  actually spawned and engaged before reporting success.
- **C9 — you do not self-modify.** Never edit your own contract or skills
  (this file, `DECISIONS.md`, the skill pointer) without explicit user
  approval — a gate must not be editable by the party it binds.
- **C10 — you refer to a ledger item with visual context.** Always make an
  item identifiable without board access: if it (or its project) has an open
  PR/MR, include that PR/MR's number (and URL) alongside the ledger id — e.g.
  'item #22 (PR #10)'; if no merge is open, add a short context phrase — the
  item's title or a one-line description.

**Liveness (A8, clerk side).** At catch-up, an `idle` agent with
unfinished work is suspect — it may have died on a usage limit. `catchup`
now lists every `idle` agent together with the tail of its pane's recent
output (see below) — that's the mechanical part: it puts what the agent
last showed in front of you without a separate pane read. The judgment
(is that tail a real question, a usage error, or nothing wrong at all —
and whether to answer, re-dispatch, or escalate) is still yours.

### Session start: catch up in one command

```sh
ledger catchup [--project <name>] [--idle-pane-lines <n>] [--json]
```

Returns, in one call: agents currently `blocked` (need a decision now),
every agent currently `idle` together with the tail of its pane's recent
output (A8 liveness triage — did it ask a question, hit a usage error, or
go quiet mid-task?), every `events` row since the last time any clerk ran
`catchup` (tracked in `first_clerk.last_seen`), and every roadmap item not
yet `done`/`dropped`, ordered by priority `high → normal → low` (ties by
id).
This is the entire "what's going on" operation from `DESIGN.md` — read this
instead of any prose file, every session.

`--idle-pane-lines <n>` controls how much of each idle agent's pane tail is
shown (default 25; `0` skips pane reads entirely — just the idle-agent list).
A pane read failing (pane/tab closed, herdr socket down) never fails
`catchup` itself: a single dead pane prints `pane unreadable: <reason>`
under that agent and the rest of catch-up proceeds; a herdr socket that's
unreachable entirely prints one note for the whole section instead of
repeating the same failure under every idle agent. `--json` includes the
same data as an `idle` array (`agent`, `pane_tail`, `pane_read_error`) plus
top-level `idle_pane_read_note` for the whole-socket case.

### First-clerk claiming

```sh
ledger clerk claim --session-id <id> --herdr-pane <id> [--force]
ledger clerk status
```

`claim` fails if another claim exists and is under 12 hours old, unless
`--force` is passed. Do this once per new/resumed clerk session before
dispatching anything.

### Registering a project

```sh
ledger project add <url-or-local-path> --name <name> [--delivery-mode direct-pr|local-only]
```

Always clones into ledger's own `$LEDGER_HOME/projects/<name>` — never the
user's working checkout (see `DESIGN.md` for why: worktree metadata
pollution, and predictable starting state). A local path clones fast
(hardlinks) and picks up unpushed branches; it can never see uncommitted
changes — tell the user to commit first (a throwaway branch is fine) if
they want an agent working from something not yet committed.

**For work that doesn't exist anywhere yet** — no repo to clone, local or
remote (e.g. the very first agent dispatched for a brand-new idea) — use
`init` instead of `add`:

```sh
ledger project init --name <name> [--delivery-mode direct-pr|local-only]
```

Creates an empty git repo (one empty initial commit — just enough for
treehouse to have a ref to lease worktrees from) directly in
`$LEDGER_HOME/projects/<name>`. `repo_url` is `NULL` for these — there's no
origin yet. Defaults to `--delivery-mode local-only` rather than
`direct-pr`, since there's nowhere to open a PR against until the project
actually gets a remote. Don't scaffold anything beyond the empty commit
yourself — what the project becomes is the dispatched agent's job.

**Once a from-scratch (`init`'d) project gets a real remote** — code
pushed somewhere for the first time — record it:

```sh
ledger project update <name> [--repo-url <url>] [--delivery-mode <mode>]
```

Adds a git `origin` remote to the local clone if it doesn't already have
one; never overwrites an existing remote. `repo_url` in the returned row
always reflects the actual git remote, not just what was requested — if
`origin` already existed with a different URL, the response includes a
`warning` rather than silently recording something git doesn't agree with.

Other project commands: `ledger project list [--json]`, `ledger project get <name>`.

### Roadmap: turning asks into briefs

```sh
ledger roadmap add --project <name> --title <title> [--parent <id>] [--description <text>] [--priority <high|normal|low>]
ledger roadmap list --project <name> [--status <status>] [--all] [--json]
ledger roadmap update <id> [--status <status>] [--title <title>] [--description <text>] [--priority <high|normal|low>]
```

Statuses: `planned | in_progress | blocked | done | dropped`. `--parent`
nests a sub-item under an existing roadmap item (arbitrary depth).

Priority: `high | normal | low`, default `normal` (also a column on every
row: JSON output and `list`'s table both show it). It is a coarse triage
rank for ordering the not-done queue — *order*, not readiness: readiness
stays with `status = blocked` + `description` (auto-unblock is a separate
future feature, not implied by priority). A stale priority degrades
gracefully: it mis-sorts the catch-up list, which is visible there; it
cannot silently block ready work the way a stale dependency edge could
(DECISIONS.md, 2026-08-23).

This is where "what the human asked for" becomes "briefs an agent can
actually execute without holding the whole feature in context." Default
behavior per `DESIGN.md`: propose a breakdown and let the human approve it,
rather than deciding unilaterally or always making them write it themselves
— unless they've told you otherwise for this project. A `roadmap` row's
`description` is a good place for the brief itself (acceptance criteria,
constraints, what's explicitly out of scope) — that's what you'll turn into
`--task` text at dispatch time via `--roadmap-item <id>`.

`roadmap list` excludes `done`/`dropped` by default; pass `--all` to see
everything.

### Dispatching an agent

```sh
ledger agent dispatch --project <name> --task "<description>" \
  --authorization <user-explicit|pre-authorized> \
  [--roadmap-item <id>] [--kind claude|pi|codex|...] \
  [--label <short-label>] [--spawned-by <agentId>] [--wait] \
  [--confirm-duplicate]
```

`--authorization` is required (gate C6): `user-explicit` = an in-the-moment
green light from the user; `pre-authorized` = a previously granted,
per-item, revocable standing latitude the clerk requested. It is recorded
on the agent row (`agents.authorization_basis`) and the `dispatched`
event, so every dispatch is auditable — the default is no longer
"allowed". The value is your attestation: the CLI cannot verify the
conversation, so pick the value that is true.

`--confirm-duplicate`: if `--roadmap-item` names an item that already has
a live (`working`/`blocked`) agent, the dispatch is refused without this
flag; pass it only when the user explicitly approved a second live agent
on that item (C6).

For `--kind claude`, dispatch always runs it with `--permission-mode
bypassPermissions` and auto-dismisses Claude Code's one-time "do you trust
this folder?" dialog (every treehouse worktree is, from its point of view,
a folder it's never seen — nobody's present in that pane to answer it, so
without this it would just hang forever). Both confirmed live — see
`DECISIONS.md`. Scoped to `claude` specifically per the user; other kinds
run with whatever their own default permission behavior is.

What this does, in order (see `DECISIONS.md` for why it's shaped this way):

1. `treehouse get --lease` against the project's clone → a durably-leased,
   isolated worktree path.
2. **One herdr workspace per project, not per dispatch.** If the project
   already has a live workspace (`projects.herdr_workspace`, checked with
   `herdr workspace get` in case the user closed it since), this dispatch
   adds a new **tab** to it (`herdr tab create --workspace <id> --cwd <that
   path>`) — so multiple agents working the same project show up as tabs
   in one workspace, not scattered across separate workspaces. Otherwise
   this is the project's first dispatch (or its old workspace is gone): a
   new workspace is created (`herdr workspace create --cwd <that path>`,
   labeled with the *project* name) and recorded onto the project row for
   every later dispatch to reuse.
3. `herdr agent start --kind <kind> --pane <pane>` → starts the coding
   agent in that pane.
4. Inserts the `agents` row (worktree path + herdr workspace/tab/pane ids)
   and a `dispatched` event — *before* sending the task, so the task prompt
   can reference the agent's own row id.
5. `herdr agent prompt <pane> "<task + reporting contract>"` → delivers the
   task (see "For dispatched agents" above for exactly what gets appended).

If workspace/tab-creation or agent-start (steps 2-3) fail, that tab (or the
whole workspace, only if this dispatch just created it — never the shared
workspace if it was reused, since other agents may be live in it) is closed
and the worktree lease is returned before the error surfaces — no orphaned
pane, no phantom `agents` row for a dispatch that never actually started.
If only the final prompt delivery (step 5) fails, the row is *kept* (the
agent process is real and running by then) with a `dispatch_prompt_failed`
event — investigate with `agent get`, retry the prompt by hand via
`herdr agent prompt`, or `agent release` to abandon it.

Scope each dispatch to a single roadmap sub-item where one exists, rather
than handing an agent a whole feature — that's the actual point of having
a roadmap (small, well-scoped context per agent).

From here, **you do nothing further** to track state — the herdr watcher
plugin keeps `agents.status` and `events` current automatically as that
pane's agent state changes.

Other agent commands:

```sh
ledger agent list [--status <status>] [--project <name>] [--json]
ledger agent get <id>
ledger agent update <id> [--status <status>] [--outcome <text>]
ledger agent release <id> [--force]
```

`agent release` first proves the work's survival (gate C3): `durable`
(worktree clean, and every commit on its checked-out branch is on a
remote) auto-returns the worktree to the treehouse pool and closes the
agent's herdr tab; `at-risk` (uncommitted changes and/or unpushed
commits) or `unprovable` (git could not verify) is *refused* and recorded
as a `release_refused` event carrying the proof — escalate to the user
instead. `--force` skips the proof: it is the user's explicit
authorization to discard work, never a repair path. It does **not** touch
`agents.status` — release is a worktree-lifecycle action, not a judgment
that the work is finished. Run it once you're done inspecting a
completed/abandoned agent's worktree.

### Monitoring and escalating

`ledger catchup` surfaces every `blocked` agent. For each one:

1. Read its `task_description` and recent `ledger event list --agent <id>`
   to understand what it's blocked on.
2. If it's something you can resolve yourself with information you already
   have (a clarification, a decision within scope the human already gave
   you) — answer it directly with `herdr agent prompt <pane> "<answer>"`,
   using the agent's `herdr_pane` from `agent get <id>`. This unblocks it;
   the watcher will pick up the resulting state change on its own.
3. If it genuinely needs the human's judgment — surface it to them. Don't
   sit on a blocked agent hoping it resolves itself; that's exactly the
   state `ledger catchup` exists to make visible immediately instead of
   burying it in a pane you'd otherwise have to remember to check.

`ledger catchup` also surfaces every `idle` agent, each with a tail of its
pane's recent output (A8). An idle agent isn't blocked — herdr didn't detect
it waiting on a question — but with unfinished work it's still suspect: read
the tail before assuming it's fine. A real usage-limit error or a stalled
run looks different from ordinary quiet-between-turns output; judge which
one you're looking at, same as you would from reading the pane directly,
just without the extra step of going to find the pane first.

## Safe ways to extend this

Per `DESIGN.md`'s core philosophy: before adding anything, ask *"could this
instead be a skill I load, or a plugin herdr invokes?"* Concretely, for
this project:

**Core** (belongs in this repo, under `src/`): the schema/migrations, the
`ledger` CLI verbs every clerk needs regardless of what project or workflow
it's running (`project`/`roadmap`/`agent`/`event`/`clerk`/`catchup`), and
the one watcher plugin that keeps `agents.status`/`events` in sync with
herdr. The test: is this genuinely load-bearing for *every* clerk session
on *every* project, not just a preference for how one workflow should work?

**Pure extension** (does not belong in this repo): anything that's really
"how I personally want this workflow to behave" rather than a shared
primitive. It reads/writes the same SQLite file or shells out to the same
`ledger` CLI, but lives entirely outside `src/`:

- A notification integration (Slack/X/Discord on `blocked`/`done`) → its
  own small script polling `ledger event list --json` or `ledger agent list
  --status blocked --json`, run however you like (cron, a herdr plugin of
  its own). Not a new `ledger` subcommand.
- A different/additional herdr event hook (e.g. reacting to
  `pane.agent_detected`) → its own separate `herdr-plugin.toml` +
  entrypoint, `herdr plugin link`'d independently. Doesn't have to live in
  this repo, and shouldn't be folded into `herdr-plugin.toml` here unless
  it's something the watcher itself needs to keep `agents`/`events`
  correct.
- A roadmap-breakdown heuristic, an escalation policy, "how to write a
  good brief for this specific project" → a Claude Code skill the clerk
  loads, or just accumulated judgment in this doc's "For the first clerk"
  section. Not schema, not CLI.
- A dashboard/reporting view → a standalone script reading
  `$LEDGER_HOME/ledger.db` directly (it's "fully inspectable with any
  SQLite client," by design — see `DESIGN.md`). Not a `ledger` command.

If you're genuinely unsure which side something falls on: does it need to
exist for *any* dispatch to work correctly, or is it optional polish one
workflow wants? The former is core; the latter is an extension, even if
it's small.

**Adding a column or table** (core, when it's actually needed). Add a new
file under `src/db/migrations/000N_<name>.ts` exporting a `Migration` (see
`src/db/migrations/0001_init.ts` for the shape), and register it in
`src/db/migrations/index.ts`. Migrations run automatically, in order,
inside a transaction, tracked in `schema_migrations` — never hand-edit
`0001_init.ts` after it's shipped. Every new column needs a concrete reason
tied to something a clerk or the watcher actually does (see `DECISIONS.md`
for the precedent: `first_clerk.last_seen` was added exactly this way).

**Adding a CLI command** (core). Add a `register*Commands(program)`
function in `src/cli/commands/`, call it from `src/cli/index.ts`. Reuse
`getDb()` from `src/db/client.ts` and the `printJson`/`printTable` helpers
in `src/cli/format.ts` — don't hand-roll output formatting per command.

**Adding a new herdr event hook to the watcher** (core, only if the hook
is about keeping `agents`/`events` correct — otherwise it's the "separate
plugin" case above). Add an `[[events]]` block to `herdr-plugin.toml`
(`on = "<hook.name>"` — dotted, confirmed live: `workspace.created`,
`tab.created`, `pane.created`, `pane.agent_status_changed`,
`pane.agent_detected`, etc.; this is a curated subset of herdr's full
internal event catalog, not identical to it — the full catalog is
`schemas.event.$defs.EventData` from `herdr api schema --json`, but not
every one of those has a corresponding plugin hook name). `command = [...]`
and a new entrypoint under `src/plugin/`. Keep each hook a single
short-lived process that reads `HERDR_PLUGIN_EVENT_JSON` (delivered as
`{ event: "<underscored_name>", data: {...} }` — confirmed live, see
`src/plugin/watcher.ts` and `DECISIONS.md`), does one write, and exits —
never a loop, never a standing process.

**Agent-to-agent coordination.** Explicitly deferred in `DESIGN.md`. If
ever wanted, it's a skill/instruction set given to dispatched agents (they
already have herdr's own socket API available to them), recorded via
`agents.spawned_by` — not a schema, CLI, or watcher change.

**Notifications, dashboards, delivery gates beyond the `direct-pr` /
`local-only` field.** All explicit non-goals for v1 — pure extensions per
above if genuinely needed, don't fold them into this repo.

## Reference: schema at a glance

Full DDL lives in `src/db/migrations/0001_init.ts` (source of truth — this
is a summary, not a copy to keep in sync by hand):

- `projects` — one row per registered project (`local_clone_path`,
  `default_branch`, `delivery_mode`, `herdr_workspace` — the project's
  shared herdr workspace, NULL until its first dispatch).
- `roadmap` — hierarchical (`parent_id` self-reference), `status` enum
  `planned|in_progress|blocked|done|dropped`, `priority` enum
  `high|normal|low` (default `normal`) — triage order for the not-done
  queue, not readiness.
- `agents` — one row per dispatch (`project_id`, `roadmap_item_id`,
  `worktree_path`, `herdr_workspace`/`herdr_tab`/`herdr_pane`,
  `coding_agent`, `authorization_basis` enum `user-explicit|pre-authorized`
  (NULL for rows predating the C6 gate), `status` enum
  `blocked|working|done|idle`, `outcome`, `spawned_by` self-reference).
- `events` — append-only, `agent_id` + `event_type` + free-form JSON
  `payload`.
- `first_clerk` — single row (`id = 1`), current authority + `last_seen`
  catch-up cursor.
