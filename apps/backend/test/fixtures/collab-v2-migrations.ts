import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

function apply(sqlite: DatabaseSync, file: string, marker: string): void {
  if (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(marker)) return;
  const url = new URL(`../../migrations/${file}`, import.meta.url);
  if (!existsSync(fileURLToPath(url))) return;
  sqlite.exec(readFileSync(url, "utf8"));
}

export function applyCollabV2Migrations(sqlite: DatabaseSync): void {
  apply(sqlite, "0046_collab_v2.sql", "collaboration_task_threads");
  apply(sqlite, "0047_collab_engagement.sql", "collaboration_reactions");
  apply(sqlite, "0048_slack_import.sql", "slack_import_jobs");
  apply(sqlite, "0059_coordination.sql", "collaboration_reply_claims");
}
