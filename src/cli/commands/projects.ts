import { Command } from "commander";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { getDb, projectsDir } from "../../db/client.js";
import type { DeliveryMode, ProjectRow } from "../../db/types.js";
import { addRemote, cloneProject, getRemoteUrl, initProject } from "../../lib/git.js";
import * as herdr from "../../lib/herdr.js";
import {
  assertProjectCodeAvailable,
  normalizeProjectCode,
  provisionalProjects,
  setProjectCode,
} from "../../lib/roadmap-keys.js";
import { printJson, printTable } from "../format.js";

export function registerProjectCommands(program: Command): void {
  const project = program.command("project").description("manage registered projects");

  project
    .command("add <source>")
    .description(
      "register a project by cloning it into ledger's own home directory " +
        "(never the user's working checkout) — source is a remote URL or local path",
    )
    .requiredOption("--name <name>", "unique project name")
    .requiredOption(
      "--code <code>",
      "short code for roadmap item keys, e.g. LEDGER -> LEDGER-1 (A-Z0-9, 2-10 chars, unique)",
    )
    .option("--delivery-mode <mode>", "direct-pr | local-only", "direct-pr")
    .action((source: string, opts: { name: string; code: string; deliveryMode: string }) => {
      const { db, code, deliveryMode, destPath } = prepareRegistration(opts);
      const { defaultBranch } = cloneProject(source, destPath);
      const row = insertProject(db, opts.name, code, source, destPath, defaultBranch, deliveryMode);
      printJson(row);
    });

  project
    .command("init")
    .description(
      "register a brand-new project that doesn't exist anywhere yet — no repo " +
        "to clone, local or remote. Creates an empty git repo (one empty initial " +
        "commit, so treehouse has a ref to lease worktrees from) in ledger's own " +
        "home directory; a dispatched agent scaffolds it from there.",
    )
    .requiredOption("--name <name>", "unique project name")
    .requiredOption(
      "--code <code>",
      "short code for roadmap item keys, e.g. LEDGER -> LEDGER-1 (A-Z0-9, 2-10 chars, unique)",
    )
    .option("--delivery-mode <mode>", "direct-pr | local-only", "local-only")
    .action((opts: { name: string; code: string; deliveryMode: string }) => {
      const { db, code, deliveryMode, destPath } = prepareRegistration(opts);
      const { defaultBranch } = initProject(destPath);
      const row = insertProject(db, opts.name, code, null, destPath, defaultBranch, deliveryMode);
      printJson(row);
    });

  project
    .command("update <name>")
    .description(
      "update a project's name, code, repo_url, and/or delivery_mode — most " +
        "commonly, giving a `project init`'d (from-scratch) project a real " +
        "remote once one exists, or renaming a registered project. Adds a " +
        "git 'origin' remote to the local clone if it doesn't already have " +
        "one; never overwrites an existing remote. Renaming never touches " +
        "local_clone_path on disk, and updates the project's live herdr " +
        "workspace label to match, if it has one.",
    )
    .option("--name <new-name>", "new, unique name for the project")
    .option(
      "--code <code>",
      "set and CONFIRM the roadmap-key short code. While the code is provisional " +
        "(migration-derived) this rewrites the project's existing keys; a confirmed " +
        "code is frozen and can't be changed",
    )
    .option("--repo-url <url>", "remote URL the project now has")
    .option("--delivery-mode <mode>", "direct-pr | local-only")
    .action(
      (
        name: string,
        opts: { name?: string; code?: string; repoUrl?: string; deliveryMode?: string },
      ) => {
        if (!opts.name && !opts.code && !opts.repoUrl && !opts.deliveryMode) {
          throw new Error("give at least one of --name, --code, --repo-url, or --delivery-mode");
        }
        const existing = getProjectByName(name);

        // Validate the code up front (before any git/herdr side effect); it
        // is applied — atomically, with its key rewrite — after the rest.
        if (opts.code !== undefined) {
          const wanted = normalizeProjectCode(opts.code);
          if (existing.code !== null && existing.code_confirmed === 1 && wanted !== existing.code) {
            setProjectCode(existing, wanted); // throws the "frozen" error
          }
          assertProjectCodeAvailable(wanted, existing.id);
        }

        let newName = existing.name;
        if (opts.name) {
          if (!opts.name.trim()) {
            throw new Error("--name must not be empty");
          }
          if (opts.name !== existing.name) {
            const collision = getDb()
              .prepare("SELECT id FROM projects WHERE name = ?")
              .get(opts.name);
            if (collision) {
              throw new Error(`a project named "${opts.name}" is already registered`);
            }
          }
          newName = opts.name;
        }

        let deliveryMode = existing.delivery_mode;
        if (opts.deliveryMode) {
          deliveryMode = opts.deliveryMode as DeliveryMode;
          if (deliveryMode !== "direct-pr" && deliveryMode !== "local-only") {
            throw new Error("--delivery-mode must be direct-pr or local-only");
          }
        }

        // repo_url must always reflect the actual git remote, not just what
        // was requested — an existing remote is never silently overwritten,
        // so the DB record can't be allowed to silently diverge from it.
        let repoUrl = existing.repo_url;
        let remoteAdded = false;
        let repoUrlMismatch = false;
        if (opts.repoUrl) {
          const currentRemote = getRemoteUrl(existing.local_clone_path, "origin");
          if (currentRemote === null) {
            addRemote(existing.local_clone_path, "origin", opts.repoUrl);
            repoUrl = opts.repoUrl;
            remoteAdded = true;
          } else {
            repoUrl = currentRemote;
            repoUrlMismatch = currentRemote !== opts.repoUrl;
          }
        }

        // Keep the project's live herdr workspace label in sync with a
        // rename, so future dispatches recognize it as still belonging to
        // this project (see workspaceHasLabel) instead of treating the
        // label mismatch as stale and creating a fresh workspace.
        let herdrWorkspaceRenamed = false;
        if (
          newName !== existing.name &&
          existing.herdr_workspace &&
          herdr.workspaceHasLabel(existing.herdr_workspace, existing.name)
        ) {
          herdr.renameWorkspace(existing.herdr_workspace, newName);
          herdrWorkspaceRenamed = true;
        }

        const row = getDb()
          .prepare(
            `UPDATE projects SET name = ?, repo_url = ?, delivery_mode = ? WHERE id = ? RETURNING *`,
          )
          .get(newName, repoUrl, deliveryMode, existing.id) as unknown as ProjectRow;
        const codeChange =
          opts.code !== undefined ? setProjectCode(existing, opts.code) : undefined;
        const finalRow = codeChange ? getProjectByName(newName) : row;

        printJson({
          ...finalRow,
          git_remote_added: remoteAdded,
          herdr_workspace_renamed: herdrWorkspaceRenamed,
          ...(codeChange ? { code_change: codeChange } : {}),
          ...(repoUrlMismatch
            ? {
                warning:
                  `an 'origin' remote already exists at ${repoUrl}, which differs from ` +
                  `the --repo-url given (${opts.repoUrl}) — ledger recorded the existing ` +
                  `remote's actual URL and did not touch git; resolve manually if needed`,
              }
            : {}),
        });
      },
    );

  project
    .command("codes")
    .description(
      "interactive (TTY only): walk each project whose roadmap-key code is still " +
        "provisional, accept the suggested code or type another, and confirm it. " +
        "Non-interactive equivalent: 'ledger project update <name> --code X'.",
    )
    .action(async () => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        const todo = provisionalProjects();
        throw new Error(
          "'ledger project codes' is interactive and needs a TTY. Non-interactive: " +
            "'ledger project update <name> --code X' (confirms the code)." +
            (todo.length ? ` Provisional: ${todo.map((p) => `${p.name}=${p.code}`).join(", ")}` : ""),
        );
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        await walkProvisionalCodes((q) => rl.question(q), (l) => console.log(l));
      } finally {
        rl.close();
      }
    });

  project
    .command("list")
    .description("list registered projects")
    .option("--json", "output as JSON")
    .action((opts: { json?: boolean }) => {
      const rows = getDb()
        .prepare("SELECT * FROM projects ORDER BY name")
        .all() as unknown as ProjectRow[];
      if (opts.json) printJson(rows);
      else printTable(rows);
    });

  project
    .command("get <name>")
    .description("show a project by name")
    .action((name: string) => {
      const row = getProjectByName(name);
      printJson(row);
    });
}

function prepareRegistration(opts: { name: string; code: string; deliveryMode: string }) {
  const deliveryMode = opts.deliveryMode as DeliveryMode;
  if (deliveryMode !== "direct-pr" && deliveryMode !== "local-only") {
    throw new Error("--delivery-mode must be direct-pr or local-only");
  }

  // Validated before any clone/init side effect.
  const code = normalizeProjectCode(opts.code);

  const db = getDb();
  const existing = db.prepare("SELECT id FROM projects WHERE name = ?").get(opts.name);
  if (existing) {
    throw new Error(`a project named "${opts.name}" is already registered`);
  }
  assertProjectCodeAvailable(code, undefined, db);

  const destPath = join(projectsDir(), opts.name);
  return { db, code, deliveryMode, destPath };
}

function insertProject(
  db: ReturnType<typeof getDb>,
  name: string,
  code: string,
  repoUrl: string | null,
  localClonePath: string,
  defaultBranch: string,
  deliveryMode: DeliveryMode,
): ProjectRow {
  return db
    .prepare(
      `INSERT INTO projects (name, code, repo_url, local_clone_path, default_branch, delivery_mode)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(name, code, repoUrl, localClonePath, defaultBranch, deliveryMode) as unknown as ProjectRow;
}

export function getProjectByName(name: string): ProjectRow {
  const row = getDb()
    .prepare("SELECT * FROM projects WHERE name = ?")
    .get(name) as unknown as ProjectRow | undefined;
  if (!row) throw new Error(`no project named "${name}"`);
  return row;
}

export function getProjectById(id: number): ProjectRow {
  const row = getDb()
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(id) as unknown as ProjectRow | undefined;
  if (!row) throw new Error(`no project #${id}`);
  return row;
}

/**
 * The `project codes` walk, with prompt/print injected so it's testable
 * without a TTY: for each provisional project, show the suggested (current
 * provisional) code, accept it on empty input or take a typed replacement,
 * re-asking until it's valid and unique, then confirm it.
 */
export async function walkProvisionalCodes(
  ask: (question: string) => Promise<string>,
  print: (line: string) => void,
): Promise<CodeChangeSummary[]> {
  const todo = provisionalProjects();
  if (todo.length === 0) {
    print("No provisional project codes — nothing to confirm.");
    return [];
  }
  const done: CodeChangeSummary[] = [];
  for (const p of todo) {
    for (;;) {
      const answer = (
        await ask(`${p.name} (${p.items} item${p.items === 1 ? "" : "s"}) code [${p.code}]: `)
      ).trim();
      try {
        const project = getProjectByName(p.name);
        const change = setProjectCode(project, answer === "" ? p.code : answer);
        print(
          `  confirmed ${change.to}` +
            (change.keys_rewritten ? ` (${change.keys_rewritten} key(s) rewritten from ${change.from}-<n>)` : ""),
        );
        done.push(change);
        break;
      } catch (err) {
        print(`  ${(err as Error).message} — try again`);
      }
    }
  }
  return done;
}

type CodeChangeSummary = ReturnType<typeof setProjectCode>;
