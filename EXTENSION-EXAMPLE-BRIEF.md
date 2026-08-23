# Implementation brief: `ledger-notify`

A worked example of building a **pure extension** against `ledger`
(a personal agent-orchestration tool) without touching its core. Handed to
you with no other context — everything you need is below or in the two
files it points you at.

## Background

`ledger` is a SQLite-backed state store for dispatched coding-agent work,
plus a CLI and a herdr watcher plugin. Full repo:
`/home/david/Development/llm/ledger` (read `README.md`, `DESIGN.md`, and
`LEDGER.md` there first — particularly `LEDGER.md`'s "Safe ways to extend
this" section, which is the philosophy this brief is putting into practice).
`DECISIONS.md` in that repo also has some load-bearing empirical findings
about herdr's actual (vs. documented) behavior — read it before assuming
anything about herdr's plugin system works the way its own docs describe.

`ledger` deliberately does **not** have notifications, dashboards, or any
delivery-channel integrations — those are explicit non-goals for its core,
by design (see `DESIGN.md`, "Non-goals for v1"). The idea is that anything
like that should be a separate tool that reads ledger's state directly,
never a change to ledger itself. This project is the first one, and it
exists to prove that model actually works end-to-end — not just to be
useful (though it should be).

## What to build

A **new, separate repository**, sibling to `ledger` (not a subdirectory of
it) — e.g. `~/Development/llm/ledger-notify` or wherever you're set up to
create it. Suggested name: `ledger-notify`.

It's a second, independent herdr plugin. It hooks the exact same herdr
event ledger's own watcher does (`pane.agent_status_changed`), but instead
of writing anything, it:

1. Reads the event payload from `HERDR_PLUGIN_EVENT_JSON` (shape below).
2. Opens ledger's SQLite database **read-only** and looks up whether
   `data.pane_id` matches an `agents.herdr_pane` row (i.e., is this pane
   one `ledger` actually dispatched?). If not, exit — not every herdr pane
   is a ledger-tracked agent (e.g. the clerk's own pane).
3. If it is, and the new `agent_status` is `blocked` or `done`: fire a
   desktop notification. Otherwise (still `working`/`idle`/`unknown`),
   exit quietly.
4. Exit. No daemon, no polling loop, no standing process — same "not a
   daemon, just an event hook" shape as ledger's own watcher.

**Never write to ledger's database.** This plugin only ever reads it.
That's the whole point of the example: it proves an extension can consume
ledger's state without ledger needing to know it exists, and without any
change to ledger's schema, CLI, or its own watcher plugin.

### Notification content

Keep it minimal and useful: project name + a truncated `task_description`
in the title, status (and `outcome` if status is `done`) in the body. You
have the full `agents` row once you've matched `pane_id` — use it, don't
just echo the raw herdr payload at the user.

### Notification mechanism

This machine is Linux. Use `notify-send` (standard on Linux desktops),
invoked via `child_process` — **no npm dependency needed for this**. Don't
build a cross-platform notification abstraction (node-notifier or similar)
for a v1 that only needs to run here; that's exactly the kind of
speculative generality this whole project's philosophy argues against. If
cross-platform support is ever actually needed, that's a later, separate
change, made when there's a real need for it — not now.

## The exact contract to implement against

**herdr-plugin.toml** (place at the new repo's root):

```toml
id = "ledger-notify"
name = "ledger-notify"
version = "0.1.0"
min_herdr_version = "0.7.0"
description = "Desktop notification when a ledger-dispatched agent goes blocked or done."

[[events]]
on = "pane.agent_status_changed"
command = ["node", "dist/watcher.js"]
```

(`on` is dotted — confirmed live against the actual herdr binary; herdr's
own internal event-catalog schema uses an underscored name for the same
thing, which is a trap — see `ledger`'s `DECISIONS.md` for the full story
of how that was found. Don't trust the schema dump over what's below.)

**The actual JSON delivered via `HERDR_PLUGIN_EVENT_JSON`** (confirmed live,
not just from docs — see `ledger`'s `DECISIONS.md` and
`src/plugin/watcher.ts`, which is the reference implementation to model
your parsing against):

```json
{
  "event": "pane_agent_status_changed",
  "data": {
    "type": "pane_agent_status_changed",
    "pane_id": "w3:p1",
    "workspace_id": "w3",
    "agent": "claude",
    "agent_status": "idle"
  }
}
```

Note it's **wrapped** (`event` + `data`), and `agent_status` is one of
`idle | working | blocked | done | unknown` — `unknown` should be a no-op
here too, same reasoning ledger's own watcher uses (it's usually transient
detection noise, not a real state).

**ledger's schema** (read-only access — see
`ledger/src/db/migrations/0001_init.ts` for the authoritative DDL; don't
copy it by hand, that file is the source of truth and can change):

The only table this project needs is `agents`. Relevant columns:
`id`, `project_id`, `task_description`, `herdr_pane`, `status`, `outcome`.
Join to `projects` (via `project_id`) for the project's `name` if you want
it in the notification title.

**Locating the database**: `$LEDGER_HOME/ledger.db`, where `LEDGER_HOME`
defaults to `~/.ledger` if the env var isn't set — match ledger's own
resolution logic (`ledger/src/db/client.ts`, `ledgerHome()`) exactly so
this plugin finds the same database ledger itself is using.

## Stack

TypeScript, built via `tsc` to `dist/` (no runtime transpiler — same
reasoning as `ledger` itself: `herdr` invokes the compiled JS directly and
shouldn't need a transpiler present). `better-sqlite3` for the read-only DB
access (`new Database(path, { readonly: true, fileMustExist: true })`).
Mirror `ledger`'s own `package.json`/`tsconfig.json` shape unless you have
a specific reason to diverge.

## Local development / testing

Same loop ledger itself uses — copy it:

1. `npm install && npm run build`
2. `herdr plugin link .` from the new repo's root — confirm
   `herdr plugin list` shows it enabled with **no warnings** (a warning
   about an unrecognized event name means the `on` value is wrong; a real
   one was caught exactly this way while building `ledger` itself).
3. **Don't** validate against a live coding-agent dispatch (spawning one is
   a real, billed side effect). Instead, do what `ledger`'s own watcher
   verification did: seed a **scratch** copy of a ledger-shaped SQLite DB
   (or point `LEDGER_HOME` at a scratch directory and use ledger's own CLI
   to create one — `ledger project add`, then hand-insert a fake `agents`
   row via `sqlite3`) with a `herdr_pane` value, then invoke your built
   `dist/watcher.js` directly with `HERDR_PLUGIN_EVENT_JSON` set to the
   exact captured payload above (substituting your fake row's `pane_id`)
   and confirm: a notification fires for `blocked`/`done`, doesn't fire for
   `working`/`idle`/`unknown`, and doesn't fire (and doesn't error) for a
   `pane_id` that matches no `agents` row at all.
4. Only after that's solid, consider a real end-to-end check: dispatch a
   throwaway agent from `ledger` for real and watch a notification actually
   land when it goes `blocked`/`done`.

## Non-goals (explicitly out of scope for this v1)

- No config file — reuse `LEDGER_HOME` the same way ledger does, nothing
  else configurable yet.
- No multi-channel support (Slack/email/etc.) — desktop notification only.
- No daemon, no polling.
- No changes to the `ledger` repo itself, for anything. If you find
  yourself wanting to modify `ledger`'s schema, CLI, or watcher to make
  this easier, stop — that's a sign this belongs in core after all, and is
  a conversation to have with the `ledger` maintainer, not something to
  just go implement.

## When you're done

A short `README.md` in the new repo (install/link steps, mirroring
`ledger`'s own `README.md` structure) is worth having, same reasoning as
`ledger`'s own — this is a real deliverable someone else might pick up. A
`DECISIONS.md` isn't required unless you hit genuine forks worth recording
for the next person, the way `ledger`'s implementation did.
