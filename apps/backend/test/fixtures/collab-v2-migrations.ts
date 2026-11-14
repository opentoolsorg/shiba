import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export function applyCollabV2Migrations(sqlite: DatabaseSync): void {
  if (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_notifications'").get()) {
    return;
  }
  const migrations = ["0046_collab_v2.sql", "0047_slack_import_mappings.sql"] as const;
  for (const file of migrations) {
    sqlite.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
  }
}