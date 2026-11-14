import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

const migrationDir = new URL("../../migrations/", import.meta.url);

/** WS01 marker + WS04 external MCP and inbound grant tables for in-memory D1 tests. */
export function applyExternalMcpMigrations(sqlite: DatabaseSync): void {
  for (const file of ["0039_ws01_schema_marker.sql", "0044_external_mcp_v2.sql", "0045_mcp_grants.sql"]) {
    sqlite.exec(readFileSync(new URL(file, migrationDir), "utf8"));
  }
}