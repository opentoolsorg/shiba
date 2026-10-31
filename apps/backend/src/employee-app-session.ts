import { getAgentByName } from "agents/routing";
import type { Env } from "./env.js";
import { parseSessionAgentName, validateSessionRecordIntegrity, type WebSessionRecord } from "./web-sessions.js";

/** Resolve retained session identity independently of current tool/profile grants. */
export async function resolveOwnedAppSession(env: Env, executionContextId: string): Promise<WebSessionRecord | null> {
  try {
    const parsed = parseSessionAgentName(executionContextId);
    if (!parsed || !env.CodingOrchestrator) return null;
    const base = await getAgentByName(env.CodingOrchestrator, parsed.userId);
    const response = await base.fetch("https://internal/internal/web-sessions");
    if (!response.ok) return null;
    const body = await response.json() as { sessions?: unknown };
    if (!Array.isArray(body.sessions)) return null;
    const matches = body.sessions.filter((candidate) =>
      validateSessionRecordIntegrity(candidate, parsed.userId) === null &&
      (candidate as WebSessionRecord).id === parsed.sessionId && (candidate as WebSessionRecord).agentName === executionContextId);
    if (matches.length !== 1) return null;
    const session = matches[0] as WebSessionRecord;
    if (session.deletingAt) return null;
    return session;
  } catch {
    return null;
  }
}

