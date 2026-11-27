import { getAgentByName } from "agents/routing";
import type { Env } from "./env.js";
import { parseSessionAgentName, validateSessionRecordIntegrity, type WebSessionRecord } from "./web-sessions.js";

/** Resolve an EmployeeRuntime execution identity without trusting client-supplied ownership. */
export async function resolveEmployeeRuntimeExecutionContext(
  env: Env,
  input: { orgId: string; employeeId: string; actorId: string; executionContextId: string },
): Promise<boolean> {
  try {
    if (!/^run_[a-f0-9]{24}$/.test(input.executionContextId) || !env.EmployeeRuntime) return false;
    const namespace = env.EmployeeRuntime;
    const stub = namespace.get(namespace.idFromName(`employee-runtime:${input.orgId}:${input.employeeId}`));
    const url = new URL("https://internal/internal/employee-runtime/execution-context");
    url.searchParams.set("executionId", input.executionContextId);
    url.searchParams.set("actorId", input.actorId);
    const response = await stub.fetch(url);
    if (!response.ok) return false;
    const body = await response.json() as { ok?: unknown; executionId?: unknown };
    return body.ok === true && body.executionId === input.executionContextId;
  } catch {
    return false;
  }
}

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

