import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The npm package name this CLI is published as — also the identity used
// to query the registry for the latest published version (item 42).
export const PACKAGE_NAME = "@devwithdavid/ledger";

// This file compiles to dist/lib/package-info.js, two levels below the
// package root — resolve package.json relative to *this running code's own
// location* rather than the cwd (same approach as docs.ts/init.ts), so it
// works from any invocation directory, in a dev checkout, and in an npm
// install (the npm tarball carries package.json at its root).
const PACKAGE_JSON_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");

/**
 * The running CLI's own version, read from package.json at runtime —
 * package.json is the ONLY source of it (item 30, DECISIONS.md). Graceful
 * degradation: an unreadable/unparseable package.json reports "unknown"
 * instead of throwing — a version query must never crash the CLI.
 */
export function packageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
      version?: string;
    };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
