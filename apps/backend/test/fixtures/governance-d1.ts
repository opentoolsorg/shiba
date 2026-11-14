import { readFileSync } from "node:fs";
import { customAgentD1 } from "./custom-agent-d1.js";
import { ensureTeamWorkspacesSchema } from "../../src/team-workspaces-store.js";
import type { Env } from "../../src/env.js";

export async function governanceD1Fixture() {
  const { database, sqlite } = customAgentD1();
  const env = { AGENT_AUDIT: database } as unknown as Env;
  await ensureTeamWorkspacesSchema(env);
  sqlite.exec(readFileSync(new URL("../../migrations/0048_governance.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../migrations/0049_audit_exports.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../migrations/0001_audit_log.sql", import.meta.url), "utf8"));
  return { env, sqlite, database };
}