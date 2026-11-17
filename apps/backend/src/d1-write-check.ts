/**
 * Do not use meta.changes for tables with triggers: D1 counts trigger-written
 * rows, including writes carried into later statements in the same batch.
 * Check the scoped row that proves the write succeeded instead.
 */
export async function rowExists(
  db: D1Database,
  sql: string,
  binds: unknown[],
): Promise<boolean> {
  return (await db.prepare(sql).bind(...binds).first()) !== null;
}
