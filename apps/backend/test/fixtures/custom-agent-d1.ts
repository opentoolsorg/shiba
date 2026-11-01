import { DatabaseSync } from "node:sqlite";

/** Real SQLite statements and transactions behind the D1 interface. */
export function customAgentD1() {
  const sqlite = new DatabaseSync(":memory:");
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...args: unknown[]) => statement(sql, args),
    execute() {
      if (/\bRETURNING\s+root_handoff_id\b/i.test(sql)) {
        const results = sqlite.prepare(sql).all(...values as never[]);
        return { success: true, results, meta: { changes: results.length, last_row_id: 0 } };
      }
      const result = sqlite.prepare(sql).run(...values as never[]);
      return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    },
    async run() { return statement(sql, values).execute(); },
    async first() { return sqlite.prepare(sql).get(...values as never[]) ?? null; },
    async all() { return { success: true, results: sqlite.prepare(sql).all(...values as never[]), meta: {} }; },
  });
  const database = {
    prepare: (sql: string) => statement(sql),
    async batch(statements: ReturnType<typeof statement>[]) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        // D1 batches execute sequentially in one transaction; SQLite changes()
        // must refer to the immediately preceding conditional write.
        for (const item of statements) results.push(item.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { database, sqlite };
}
