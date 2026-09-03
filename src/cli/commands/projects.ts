import { Command } from "commander";
import { join } from "node:path";
import { getDb, projectsDir } from "../../db/client.js";
import type { DeliveryMode, ProjectRow } from "../../db/types.js";
import { addRemote, cloneProject, getRemoteUrl, initProject } from "../../lib/git.js";
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
    .option("--delivery-mode <mode>", "direct-pr | local-only", "direct-pr")
    .action((source: string, opts: { name: string; deliveryMode: string }) => {
      const { db, deliveryMode, destPath } = prepareRegistration(opts);
      const { defaultBranch } = cloneProject(source, destPath);
      const row = insertProject(db, opts.name, source, destPath, defaultBranch, deliveryMode);
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
    .option("--delivery-mode <mode>", "direct-pr | local-only", "local-only")
    .action((opts: { name: string; deliveryMode: string }) => {
      const { db, deliveryMode, destPath } = prepareRegistration(opts);
      const { defaultBranch } = initProject(destPath);
      const row = insertProject(db, opts.name, null, destPath, defaultBranch, deliveryMode);
      printJson(row);
    });

  project
    .command("update <name>")
    .description(
      "update a project's repo_url and/or delivery_mode — most commonly, " +
        "giving a `project init`'d (from-scratch) project a real remote once " +
        "one exists. Adds a git 'origin' remote to the local clone if it " +
        "doesn't already have one; never overwrites an existing remote.",
    )
    .option("--repo-url <url>", "remote URL the project now has")
    .option("--delivery-mode <mode>", "direct-pr | local-only")
    .action((name: string, opts: { repoUrl?: string; deliveryMode?: string }) => {
      if (!opts.repoUrl && !opts.deliveryMode) {
        throw new Error("give at least one of --repo-url or --delivery-mode");
      }
      const existing = getProjectByName(name);

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

      const row = getDb()
        .prepare(
          `UPDATE projects SET repo_url = ?, delivery_mode = ? WHERE name = ? RETURNING *`,
        )
        .get(repoUrl, deliveryMode, name) as unknown as ProjectRow;

      printJson({
        ...row,
        git_remote_added: remoteAdded,
        ...(repoUrlMismatch
          ? {
              warning:
                `an 'origin' remote already exists at ${repoUrl}, which differs from ` +
                `the --repo-url given (${opts.repoUrl}) — ledger recorded the existing ` +
                `remote's actual URL and did not touch git; resolve manually if needed`,
            }
          : {}),
      });
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

function prepareRegistration(opts: { name: string; deliveryMode: string }) {
  const deliveryMode = opts.deliveryMode as DeliveryMode;
  if (deliveryMode !== "direct-pr" && deliveryMode !== "local-only") {
    throw new Error("--delivery-mode must be direct-pr or local-only");
  }

  const db = getDb();
  const existing = db.prepare("SELECT id FROM projects WHERE name = ?").get(opts.name);
  if (existing) {
    throw new Error(`a project named "${opts.name}" is already registered`);
  }

  const destPath = join(projectsDir(), opts.name);
  return { db, deliveryMode, destPath };
}

function insertProject(
  db: ReturnType<typeof getDb>,
  name: string,
  repoUrl: string | null,
  localClonePath: string,
  defaultBranch: string,
  deliveryMode: DeliveryMode,
): ProjectRow {
  return db
    .prepare(
      `INSERT INTO projects (name, repo_url, local_clone_path, default_branch, delivery_mode)
       VALUES (?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(name, repoUrl, localClonePath, defaultBranch, deliveryMode) as unknown as ProjectRow;
}

export function getProjectByName(name: string): ProjectRow {
  const row = getDb()
    .prepare("SELECT * FROM projects WHERE name = ?")
    .get(name) as unknown as ProjectRow | undefined;
  if (!row) throw new Error(`no project named "${name}"`);
  return row;
}
