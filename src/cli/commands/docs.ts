import { Command } from "commander";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// This file compiles to dist/cli/commands/docs.js, three levels under the
// repo root — resolve LEDGER.md relative to *this running code's own
// location* rather than any hardcoded/machine-specific path, so `ledger
// docs` works correctly regardless of where the repo was cloned or which
// machine it's running on (including through an `npm link` symlink: ESM
// resolves import.meta.url to the real file location).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const LEDGER_MD_PATH = join(REPO_ROOT, "LEDGER.md");

export function registerDocsCommand(program: Command): void {
  program
    .command("docs")
    .description(
      "print LEDGER.md, the full clerk/agent reference — read this first " +
        "if acting as the clerk",
    )
    .action(() => {
      let content: string;
      try {
        content = readFileSync(LEDGER_MD_PATH, "utf8");
      } catch {
        throw new Error(
          `couldn't read LEDGER.md at ${LEDGER_MD_PATH} — is this a ` +
            `complete ledger install (git clone + npm run build), not just ` +
            `a copied dist/ directory?`,
        );
      }
      console.log(content);
    });
}
