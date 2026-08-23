export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** Simple aligned-column table for terminal output (no dependency needed). */
export function printTable<T extends object>(rows: T[]): void {
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  const asRecords = rows as unknown as Record<string, unknown>[];
  const columns = Object.keys(asRecords[0] as Record<string, unknown>);
  const widths = columns.map((col) =>
    Math.max(
      col.length,
      ...asRecords.map((row) => String(row[col] ?? "").length),
    ),
  );

  const formatRow = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i] as number)).join("  ");

  console.log(formatRow(columns));
  console.log(formatRow(widths.map((w) => "-".repeat(w))));
  for (const row of asRecords) {
    console.log(formatRow(columns.map((col) => String(row[col] ?? ""))));
  }
}
