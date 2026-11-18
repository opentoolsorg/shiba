import { readFileSync, readdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";

/** Auth tests use the same schema source as a fresh Worker database. */
export function applyAuthMigrations(sqlite: DatabaseSync): void {
  const migrations = new URL("../../../../apps/backend/migrations/", import.meta.url);
  for (const file of readdirSync(migrations).filter(file => file.endsWith(".sql")).sort()) {
    sqlite.exec("BEGIN");
    try {
      sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}
