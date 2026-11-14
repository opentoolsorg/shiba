import type { DatabaseSync } from "node:sqlite";
import { applyExternalMcpMigrations, customAgentD1 } from "./custom-agent-d1.js";

export { applyExternalMcpMigrations };

/** D1 + SQLite with WS04 external MCP and grant tables (no runtime CREATE TABLE). */
export function externalMcpD1() {
  return customAgentD1();
}

/** @deprecated use {@link customAgentD1} — migrations are applied by default. */
export function applyMcpSchemaForTest(sqlite: DatabaseSync): void {
  applyExternalMcpMigrations(sqlite);
}