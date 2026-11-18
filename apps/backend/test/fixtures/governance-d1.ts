import { customAgentD1 } from "./custom-agent-d1.js";
import type { Env } from "../../src/env.js";

export async function governanceD1Fixture() {
  const { database, sqlite } = customAgentD1();
  const env = { AGENT_AUDIT: database } as unknown as Env;
  return { env, sqlite, database };
}
