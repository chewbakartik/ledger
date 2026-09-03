/**
 * node:sqlite is still experimental (unflagged since Node 22.13.0/23.4.0)
 * and prints an ExperimentalWarning the moment it's first imported.
 * Suppress only that one warning — everything else still reaches stderr
 * as normal.
 *
 * Must be the *first* import in the CLI entry point: ES module static
 * imports are hoisted and executed before the importing module's own
 * top-level body, so this override has to be its own dependency-free
 * module, imported before anything that (transitively) imports
 * "node:sqlite" — otherwise the warning fires before the override is
 * installed.
 */
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const type =
    typeof args[0] === "string" ? args[0] : (args[0] as { type?: string } | undefined)?.type;
  const message = warning instanceof Error ? warning.message : warning;
  if (type === "ExperimentalWarning" && typeof message === "string" && message.includes("SQLite")) {
    return;
  }
  return (originalEmitWarning as (...a: unknown[]) => void)(warning, ...args);
}) as typeof process.emitWarning;
