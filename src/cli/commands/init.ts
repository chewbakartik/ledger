import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { getDb, ledgerHome } from "../../db/client.js";

// This file compiles to dist/cli/commands/init.js, three levels under the
// package root — resolve the package root relative to *this running code's
// own location* rather than the cwd (same approach as docs.ts), so it works
// from any invocation directory, in a dev checkout and in an npm install.
// The herdr plugin manifest (herdr-plugin.toml) lives at the package root,
// so that directory is what gets linked.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Step 4's bundled skill template: a hand-authored `~/.agents/skills/ledger`
// (cross-agent skill tree; see DECISIONS.md "Clerk bootstrapping") existed
// on one machine only and was never captured as a reproducible setup step —
// a second machine's clerk session never loaded LEDGER.md as a result and
// spent a whole session unaware of its own governance gates. This ships the
// real skill content as a package asset instead, resolved the same way as
// the herdr plugin root above, so `init` can (re-)install it anywhere.
const SKILL_TEMPLATE_PATH = join(PACKAGE_ROOT, "skills/ledger/SKILL.md");
const AGENTS_SKILL_DIR = join(homedir(), ".agents/skills/ledger");
const AGENTS_SKILL_FILE = join(AGENTS_SKILL_DIR, "SKILL.md");
// Deliberately outside this repo (same reasoning as the skill itself living
// outside it) — per-tool skill directories are symlinks into the shared
// `~/.agents/skills/<name>` tree, so any coding agent that understands that
// convention picks it up with zero ledger-specific config of its own.
const SKILL_SYMLINK_TARGETS = [join(homedir(), ".claude/skills/ledger"), join(homedir(), ".pi/agent/skills/ledger")];

// Install pointers for the pre-check:
//   herdr: derived from the tool's own npm package metadata, verified
//   2026-09-03 — NOT guessed: npm view herdr homepage -> https://herdr.dev
//   treehouse: npm's 'treehouse' is an unrelated React package (name
//   squat); the required tool is kunchenguid's git-worktree tool
//   (installed binary v2.3.0) — URL per user confirmation 2026-09-04,
//   not npm metadata.
// (The README's prerequisites section carries the same treehouse URL —
// the two now agree; see DECISIONS.md for the resolution.)
const DOCS: { herdr: string; treehouse: string } = {
  herdr: "https://herdr.dev",
  treehouse: "https://github.com/kunchenguid/treehouse",
};

const REQUIRED_TOOLS = ["herdr", "treehouse"] as const;

/**
 * PATH lookup for a required tool: the first $PATH directory that contains
 * an executable FILE named <tool> wins. A plain lookup, deliberately not a
 * version/capability probe — the pre-check's job is to fail fast with a
 * per-tool install pointer, not to audit the tool (item 30).
 */
function findOnPath(tool: string): string | undefined {
  const dirs = (process.env["PATH"] ?? "").split(delimiter).filter((d) => d.length > 0);
  for (const dir of dirs) {
    const candidate = join(dir, tool);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here (or not executable) — keep looking
    }
  }
  return undefined;
}

/**
 * Step 4 helper: symlink one per-tool skill path to AGENTS_SKILL_DIR,
 * creating its parent directory if needed. Idempotent: a symlink already
 * pointing at the right place is a silent no-op; a pre-existing real
 * file/directory (or a symlink to somewhere else) is left untouched with a
 * warning rather than clobbered — this must never destroy something a user
 * put there on purpose.
 */
function linkSkill(linkPath: string): void {
  mkdirSync(dirname(linkPath), { recursive: true });

  if (existsSync(linkPath)) {
    let currentTarget: string | undefined;
    try {
      currentTarget = readlinkSync(linkPath);
    } catch {
      // Exists but isn't a symlink at all.
    }
    if (currentTarget === AGENTS_SKILL_DIR) {
      console.log(`✓ ${linkPath} already links to ${AGENTS_SKILL_DIR}`);
    } else {
      console.log(
        `Warning: ${linkPath} already exists and is not a symlink to ${AGENTS_SKILL_DIR} ` +
          `(${currentTarget ?? "a real file/directory"}) — left untouched. Remove it and ` +
          `re-run 'ledger init' to relink.`,
      );
    }
    return;
  }

  symlinkSync(AGENTS_SKILL_DIR, linkPath);
  console.log(`✓ linked ${linkPath} -> ${AGENTS_SKILL_DIR}`);
}

/**
 * The single post-install step (item 30, user-directed): the README's
 * install section no longer tells users to hand-run `herdr plugin link
 * <path>` — this command does that, transparently.
 *
 * Steps, in order:
 *  1. Pre-check herdr AND treehouse on PATH before touching anything. If
 *     one or both are missing, exit non-zero with a per-tool install
 *     pointer (both in one error when both are missing) — no store is
 *     created and no link is attempted.
 *  2. Ensure the ledger store, reusing getDb() (it creates $LEDGER_HOME
 *     and opens/migrates ledger.db; an existing store is only opened —
 *     never reset or rewritten). Prints the path created or found.
 *  3. Link the herdr plugin: `herdr plugin link <package root>`.
 *     Verified live against herdr 0.7.5 (2026-09-03): re-linking a path
 *     that's already linked exits 0, prints its `plugin_linked` JSON
 *     result, and leaves herdr's plugin registry file byte-identical —
 *     so this step is idempotent and the command is safe to re-run (e.g.
 *     after `npm update -g @devwithdavid/ledger`). A non-zero exit (for
 *     instance an already-linked different path) is surfaced: herdr's
 *     own output is printed, the command fails, and the user resolves it
 *     (`herdr plugin unlink ledger` first).
 *  4. Install/update the clerk skill: write the bundled
 *     `skills/ledger/SKILL.md` to `~/.agents/skills/ledger/SKILL.md`
 *     (always overwritten from the bundled copy, so re-running `init`
 *     after an upgrade re-syncs it), then symlink `~/.claude/skills/ledger`
 *     and `~/.pi/agent/skills/ledger` to it if not already correctly
 *     linked. Found missing on a second machine (see DECISIONS.md) —
 *     the skill's *content* was portable, but nothing ever installed it.
 *
 * Every step prints an explicit status line (✓) naming what was done and
 * the path/URL involved, so the user sees exactly what `ledger init` did.
 */
export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description(
      "one-time post-install setup: verify herdr and treehouse are on PATH, " +
        "create the ledger store if missing, link the herdr watcher plugin, " +
        "install the clerk skill (idempotent — safe to re-run)",
    )
    .action(() => {
      // 1. Pre-check both required tools up front, before any side effect.
      for (const tool of REQUIRED_TOOLS) {
        if (findOnPath(tool)) {
          console.log(`✓ ${tool} found on PATH`);
        }
      }
      const missing = REQUIRED_TOOLS.filter((tool) => !findOnPath(tool));
      if (missing.length > 0) {
        // All missing tools are reported in one error, per the exact
        // message format "<tool> not found on PATH - install it first:
        // <docs URL>" (item 30). The CLI entry prints this as a single
        // `Error:` line and exits non-zero.
        throw new Error(
          missing.map((tool) => `${tool} not found on PATH - install it first: ${DOCS[tool]}`).join("; "),
        );
      }

      // 2. Ensure the store — reuse the existing getDb() machinery (it
      //    creates the home dir and migrates on open). Never resets or
      //    rewrites an existing store.
      const storePath = join(ledgerHome(), "ledger.db");
      const alreadyThere = existsSync(storePath);
      getDb();
      console.log(`✓ ledger store ${alreadyThere ? "found at" : "created at"} ${storePath}`);

      // 3. Link the herdr plugin from the package root.
      const res = spawnSync("herdr", ["plugin", "link", PACKAGE_ROOT], { encoding: "utf8" });
      if (res.error || res.status !== 0) {
        const out = res.stdout ?? "";
        const err = res.stderr ?? "";
        if (out.trim()) process.stderr.write(`${out.trimEnd()}\n`);
        if (err.trim()) process.stderr.write(`${err.trimEnd()}\n`);
        const detail = res.error ? res.error.message : `exit ${res.status}`;
        throw new Error(`herdr plugin link failed (${detail})`);
      }
      // Print herdr's own result so a fresh link and a no-op re-link are
      // both visible, then our own status line naming the linked path.
      const out = res.stdout ?? "";
      if (out.trim()) console.log(out.trimEnd());
      console.log(`✓ herdr plugin linked from ${PACKAGE_ROOT}`);

      // 4. Install/update the clerk skill from the bundled template, then
      //    link it into every known per-tool skill tree.
      let skillTemplate: string;
      try {
        skillTemplate = readFileSync(SKILL_TEMPLATE_PATH, "utf8");
      } catch {
        throw new Error(
          `couldn't read the bundled skill template at ${SKILL_TEMPLATE_PATH} ` +
            `— is this a complete ledger install, not a partial copy?`,
        );
      }
      const skillAlreadyThere = existsSync(AGENTS_SKILL_FILE);
      mkdirSync(AGENTS_SKILL_DIR, { recursive: true });
      writeFileSync(AGENTS_SKILL_FILE, skillTemplate);
      console.log(`✓ clerk skill ${skillAlreadyThere ? "updated at" : "installed at"} ${AGENTS_SKILL_FILE}`);
      for (const linkPath of SKILL_SYMLINK_TARGETS) {
        linkSkill(linkPath);
      }
    });
}
