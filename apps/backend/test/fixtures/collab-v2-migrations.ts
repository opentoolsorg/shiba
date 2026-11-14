import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export function applyCollabV2Migrations(sqlite: DatabaseSync): void {
  if (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='collaboration_task_threads'").get()) {
    return;
  }
  sqlite.exec(readFileSync(new URL("../../migrations/0046_collab_v2.sql", import.meta.url), "utf8"));
}
