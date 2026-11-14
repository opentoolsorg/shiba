import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

const migration = readFileSync(new URL("../../migrations/0040_email_outbox.sql", import.meta.url), "utf8");

/** WS02 transactional email outbox tables for in-memory D1 fixtures. */
export function applyEmailOutboxSchema(sqlite: DatabaseSync): void {
  sqlite.exec(migration);
}