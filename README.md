# ledger

A personal agent-orchestration tool: talk to one coding-agent session (the
**clerk**), it dispatches work to other coding agents running in parallel,
each in its own isolated git worktree. Durable state — what's running,
what's blocked, what happened — lives in one local SQLite file, the
**ledger**. No daemon, no server process, nothing running when nothing is
happening.

Full philosophy and design rationale: [`DESIGN.md`](./DESIGN.md). This repo
is the implementation of it, built for one person's actual workflow, not as
a general product.

## Prerequisites

- [Node.js](https://nodejs.org) ≥ 20
- [herdr](https://herdr.dev) installed and running — the terminal
  workspace/pane manager. `herdr status` should show a running server.
- [treehouse](https://github.com/kunchenguid/treehouse) installed — isolated
  git worktree pooling. No config file required; it auto-provisions a pool
  per repo on first use.
- `git`

## Install

```sh
git clone <this-repo> ledger   # or you already have it locally
cd ledger
npm install
npm run build
```

**Make the CLI available.** Either:

```sh
npm link          # puts `ledger` on PATH globally
```

or invoke it directly / alias it:

```sh
node dist/cli/index.js ...
```

**Link the watcher plugin into herdr** — this is what keeps agent status
current automatically as dispatched agents work, without any polling:

```sh
herdr plugin link .
```

This registers `herdr-plugin.toml`, so herdr invokes `dist/plugin/watcher.js`
whenever a pane's detected agent state changes. It's local and reversible:
`herdr plugin unlink ledger` removes it. Re-run `npm run build` after any
change to `src/plugin/watcher.ts` — herdr always invokes whatever's
currently in `dist/`.

## Starting a clerk session

You don't run `ledger` commands yourself day to day — you talk to **the
clerk** (a Claude Code or Pi session), and it runs them on your behalf. A
`ledger` skill is installed at `~/.agents/skills/ledger` (symlinked into
both `~/.claude/skills/` and `~/.pi/agent/skills/`) so either tool can pick
it up — it loads only when you actually ask for ledger-related work
(register a project, dispatch an agent, check status, ...), not on every
unrelated session.

The skill itself carries no machine-specific path: it just tells the clerk
to run `ledger docs`, which prints `LEDGER.md` by resolving it relative to
wherever `ledger` is actually installed (works correctly through the
`npm link` symlink too — proven live, see `DECISIONS.md`). That's what
makes the skill portable to a fresh machine as-is: install `ledger` there
per this README, and the skill works with no edits.

## Quick start (what the clerk actually runs)

```sh
# Register a project (clones into ledger's own home dir — never your
# working checkout; see DESIGN.md for why).
ledger project add /path/to/repo-or-url --name myproj

# Break a feature into scoped briefs.
ledger roadmap add --project myproj --title "Do the thing"

# Dispatch an agent against one brief.
ledger agent dispatch --project myproj --task "Implement X" --roadmap-item 1

# Session start / "what's going on" — the entire catch-up operation.
ledger catchup
```

Run `ledger --help`, or any subcommand with `--help`, for the full flag
reference.

## Where state lives

One file: `$LEDGER_HOME/ledger.db` (default `~/.ledger`, override with the
`LEDGER_HOME` env var), plus project clones under
`$LEDGER_HOME/projects/<name>`. It's a plain SQLite file — inspectable with
any SQLite client at any time, by design. There is no daemon: every `ledger`
command opens the DB, does one thing, and exits. If herdr isn't running, no
agents can be running either, and nothing here breaks — the watcher plugin
simply never fires.

## Documentation map

| Doc | What's in it |
|---|---|
| [`DESIGN.md`](./DESIGN.md) | The philosophy, why this exists, and the original schema/flow brief |
| [`LEDGER.md`](./LEDGER.md) | The operational reference — full CLI surface, what the first clerk is responsible for vs. what a dispatched agent is told, and how to extend this safely |
| [`DECISIONS.md`](./DECISIONS.md) | Running log of implementation decisions and why, including things verified live against the real herdr/treehouse binaries (some of herdr's actual behavior differs from its docs — see this file before assuming a documented API shape is accurate) |

## Extending

Core is deliberately small: the schema (`src/db`), the CLI (`src/cli`), and
the one watcher plugin (`src/plugin`) that keeps `agents`/`events` in sync
with herdr. Almost everything else — notifications, alternate herdr event
hooks, roadmap-breakdown heuristics, dashboards — is meant to live **outside
this repo**, as a separate script or plugin that reads/writes the same
SQLite file or shells out to the same `ledger` CLI. See [`LEDGER.md` §
"Safe ways to extend this"](./LEDGER.md#safe-ways-to-extend-this) for the
concrete core-vs-extension test and worked examples, and that same doc for
how to add a migration, a CLI command, or a new watcher hook when something
genuinely does belong in core.

## Example extension

[`ledger-notify`](../ledger-notify) *(sibling repo, once built)* — a
desktop-notification plugin that watches for agents going `blocked` or
`done`, built entirely outside this repo as a worked example of the
extension model. See [`EXTENSION-EXAMPLE-BRIEF.md`](./EXTENSION-EXAMPLE-BRIEF.md)
for the implementation brief.

## Status

Personal tool, not a general product. `herdr` and `treehouse` are pre-1.0
with a high release cadence; some of the CLI/plugin behavior this repo
depends on was reverse-engineered live (their docs don't fully match
current behavior in places — see `DECISIONS.md`) and may need
re-verification after either tool upgrades.
