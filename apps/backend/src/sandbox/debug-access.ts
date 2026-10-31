/**
 * Debug sandbox routes must not reach arbitrary provider instances by id.
 * Access is granted only when the sandbox id belongs to a run visible to
 * the authenticated dashboard caller (their user DO, plus the shared default
 * DO when they are on DASHBOARD_APPROVERS).
 */
import { getAgentByName } from "agents/routing";
import type { Env } from "../env.js";
import { isApprover, parseApproverAllowlist } from "../slack-approval.js";
import { ORCHESTRATOR_NAME } from "../slack-routes.js";
import { isAccessConfigured, isLoopbackRequest, resolveUserId } from "../request-auth.js";

import { isBetterAuthConfigured } from "../better-auth.js";

type RunRow = { sandboxId?: string };

async function runsForAgent(env: Env, agentName: string): Promise<RunRow[]> {
  const stub = await getAgentByName(env.CodingOrchestrator, agentName);
  const response = await stub.fetch(
    new Request("https://internal/api/runs?limit=500&view=summary", { method: "GET" }),
  );
  if (!response.ok) return [];
  const body = (await response.json().catch(() => ({}))) as { runs?: RunRow[] };
  return body.runs ?? [];
}

export async function assertAuthorizedSandboxDebug(
  env: Env,
  request: Request,
  sandboxId: string,
): Promise<Response | null> {
  const identity = await resolveUserId(request, env);
  if (identity === null && (
    request.headers.has("authorization") || isAccessConfigured(env) ||
    isBetterAuthConfigured(env) || !isLoopbackRequest(request)
  )) {
    return Response.json({ error: "User identity required." }, { status: 403 });
  }
  const userId = identity ?? "default";
  const agents = new Set<string>([userId]);
  if (isApprover(userId, parseApproverAllowlist(env.DASHBOARD_APPROVERS))) {
    agents.add(ORCHESTRATOR_NAME);
  }
  for (const agentName of agents) {
    const runs = await runsForAgent(env, agentName);
    if (runs.some((run) => run.sandboxId === sandboxId)) {
      return null;
    }
  }
  return Response.json({ error: "Sandbox not found or not authorized." }, { status: 403 });
}
