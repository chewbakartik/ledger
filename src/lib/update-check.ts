import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerHome } from "../db/client.js";
import { PACKAGE_NAME } from "./package-info.js";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // item 42, user-specified
const REGISTRY_TIMEOUT_MS = 1500; // "short timeout (~1-2s)", item 42

function cachePath(): string {
  return join(ledgerHome(), "update-check.json");
}

interface UpdateCache {
  checkedAt: string; // ISO 8601
  latestVersion: string;
}

function isUpdateCache(value: unknown): value is UpdateCache {
  const v = value as Partial<UpdateCache> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.checkedAt === "string" &&
    typeof v.latestVersion === "string"
  );
}

/** Per-machine cache under $LEDGER_HOME — deliberately not ledger.db (item 42: this is local cache state, not shared ledger state). */
function readCache(): UpdateCache | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cachePath(), "utf8"));
    return isUpdateCache(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(cache: UpdateCache): void {
  try {
    writeFileSync(cachePath(), JSON.stringify(cache), "utf8");
  } catch {
    // Best-effort: a failed cache write must never surface — the notice
    // check degrades silently on any failure (item 42).
  }
}

function isFresh(cache: UpdateCache): boolean {
  const age = Date.now() - new Date(cache.checkedAt).getTime();
  return age >= 0 && age < CACHE_TTL_MS;
}

/**
 * Queries the npm registry directly (not the `npm` CLI — no dependency on
 * it being installed beyond what's needed to actually run the update) for
 * the latest published version. Throws with a descriptive message on any
 * failure — offline, timeout, non-2xx, malformed body; callers choose
 * whether that should be silent (the passive notice, via
 * `fetchLatestVersion` below) or surfaced (`ledger update`, via
 * `fetchLatestVersionOrThrow`).
 */
async function fetchLatestVersionInternal(): Promise<string> {
  const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`npm registry returned HTTP ${res.status} for ${PACKAGE_NAME}`);
  }
  const body: unknown = await res.json();
  const version = (body as { version?: unknown } | null)?.version;
  if (typeof version !== "string") {
    throw new Error("npm registry response had no version field");
  }
  return version;
}

/**
 * Silent variant for the passive claim/catchup notice: any failure —
 * offline, timeout, non-2xx, malformed body — must degrade to "no notice
 * this time", never throw (item 42).
 */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    return await fetchLatestVersionInternal();
  } catch {
    return null;
  }
}

/** Parses "x.y.z" into a 3-tuple; a missing/non-numeric part reads as 0. */
function parseVersion(v: string): [number, number, number] {
  const parts = v.split(".").map((p) => Number.parseInt(p, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0].map((n) => (Number.isNaN(n) ? 0 : n)) as [
    number,
    number,
    number,
  ];
}

/** True when `a` is a properly-newer semver than `b` (not string comparison — "0.2.0" > "0.10.0" would be wrong as strings). */
export function isNewerVersion(a: string, b: string): boolean {
  const [aMaj, aMin, aPatch] = parseVersion(a);
  const [bMaj, bMin, bPatch] = parseVersion(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPatch > bPatch;
}

export interface UpdateInfo {
  current: string;
  latest: string;
}

/**
 * Cached (6h TTL) check for a newer npm version than the one running.
 * Returns null whenever no *newer* version is known to exist — the
 * running version is already current, the registry lookup failed, or
 * "unknown" (package.json unreadable) is running. Never throws (item 42:
 * this backs the passive claim/catchup notice, which must degrade
 * silently on any failure).
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo | null> {
  if (currentVersion === "unknown") return null;

  const cached = readCache();
  let latest: string | null;
  if (cached && isFresh(cached)) {
    latest = cached.latestVersion;
  } else {
    latest = await fetchLatestVersion();
    if (latest) writeCache({ checkedAt: new Date().toISOString(), latestVersion: latest });
  }

  if (!latest || !isNewerVersion(latest, currentVersion)) return null;
  return { current: currentVersion, latest };
}

/**
 * Always queries the registry fresh, bypassing the cache — for `ledger
 * update`, an explicit user action where a stale cached answer would be
 * wrong (item 42: "fresh check is fine here"). Throws (rather than
 * degrading to null) since this is a foreground, user-invoked action:
 * failures here must be visible, unlike the passive notice (item 42).
 */
export async function fetchLatestVersionOrThrow(): Promise<string> {
  return fetchLatestVersionInternal();
}

export function formatUpdateNotice(info: UpdateInfo): string {
  return `A new version of ledger is available: ${info.current} -> ${info.latest}. Run \`ledger update\` to upgrade.`;
}
