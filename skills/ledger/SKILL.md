---
name: ledger
description: Act as the first clerk for `ledger`, a personal SQLite-backed agent-orchestration tool (herdr + treehouse). Use when asked to register a ledger project, break work into a roadmap, dispatch a coding agent via ledger, check on dispatched agents, run a ledger catch-up, or otherwise manage state via the `ledger` CLI.
---

Run `ledger docs` and read its full output before doing anything else in
this role — that prints the complete clerk/agent reference (CLI surface,
what the first clerk is responsible for, what a dispatched agent is told).

This skill is intentionally just a pointer, not a copy of that content, so
it can't drift out of sync with the real CLI, and carries no machine-
specific path — `ledger docs` resolves its own reference doc relative to
wherever the `ledger` package is actually installed on this machine.

If `ledger` isn't found on PATH, it isn't installed here yet: find the
`ledger` project's own repo (or ask the user where it's cloned) and follow
its `README.md` install steps first.
