import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { packageVersion, PACKAGE_NAME } from "../../lib/package-info.js";
import { fetchLatestVersionOrThrow, isNewerVersion } from "../../lib/update-check.js";

/**
 * `ledger update` (item 42): an explicit, foreground user action, so unlike
 * the passive claim/catchup notice this always checks fresh (never the 6h
 * cache) and never degrades silently — every failure (the version check
 * itself, or the npm install) is reported plainly and exits non-zero.
 * No confirmation prompt: per the spec, running it at all is the user's
 * confirmation.
 */
export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description(`check for and install the latest ${PACKAGE_NAME} from npm`)
    .action(async () => {
      const current = packageVersion();

      let latest: string;
      try {
        latest = await fetchLatestVersionOrThrow();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`couldn't check npm for the latest version: ${msg}`);
      }

      if (!isNewerVersion(latest, current)) {
        console.log(`Already up to date (${current}).`);
        return;
      }

      console.log(`Updating ${PACKAGE_NAME}: ${current} -> ${latest} ...`);
      const res = spawnSync("npm", ["install", "-g", `${PACKAGE_NAME}@latest`], {
        encoding: "utf8",
        stdio: "inherit",
      });

      if (res.error) {
        throw new Error(`npm install failed: ${res.error.message}`);
      }
      if (res.status !== 0) {
        throw new Error(`npm install exited with code ${res.status}`);
      }

      console.log(`Updated ${PACKAGE_NAME}: ${current} -> ${latest}.`);
    });
}
