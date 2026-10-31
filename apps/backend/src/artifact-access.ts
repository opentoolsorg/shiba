import { getAgentByName } from "agents/routing";
import type { Env } from "./env.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import { ORCHESTRATOR_NAME } from "./slack-routes.js";
import { isApprover, parseApproverAllowlist } from "./slack-approval.js";
import { isAuthorizedSessionAgent } from "./web-sessions.js";

const ACCESS_AGENT_METADATA = "accessAgent";

export function artifactAccessAgentMetadata(accessAgent: string): Record<string, string> {
  const trimmed = accessAgent.trim();
  if (!trimmed || trimmed.length > 200) return {};
  return { [ACCESS_AGENT_METADATA]: trimmed };
}

async function runsIncludeSandbox(
  env: Env,
  agentName: string,
  sandboxId: string,
): Promise<boolean> {
  const stub = await getAgentByName(env.CodingOrchestrator, agentName);
  const response = await stub.fetch("https://internal/api/runs?limit=500");
  if (!response.ok) return false;
  const body = (await response.json().catch(() => ({}))) as {
    runs?: Array<{ sandboxId?: string }>;
  };
  return (body.runs ?? []).some((run) => run.sandboxId === sandboxId);
}

async function callerMayReadSharedRuns(request: Request, env: Env): Promise<boolean> {
  const email = request.headers.get("CF-Access-Authenticated-User-Email")?.trim() ?? "";
  if (email && isApprover(email, parseApproverAllowlist(env.DASHBOARD_APPROVERS))) return true;
  const userId = await resolveUserId(request, env);
  return userId !== null && isApprover(userId, parseApproverAllowlist(env.DASHBOARD_APPROVERS));
}

/**
 * Returns null when the caller may read artifacts for this sandbox, else a 403/404 response.
 */
export async function assertSandboxArtifactAccess(
  request: Request,
  env: Env,
  sandboxId: string,
  storedAccessAgent?: string,
): Promise<Response | null> {
  if (!(await isAuthorizedRequest(request, env))) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  const userId = (await resolveUserId(request, env)) ?? "default";
  const accessAgent = storedAccessAgent?.trim() ?? "";

  if (accessAgent !== "") {
    if (isAuthorizedSessionAgent(accessAgent, userId)) return null;
    if (accessAgent === ORCHESTRATOR_NAME && (await callerMayReadSharedRuns(request, env))) {
      return null;
    }
    return Response.json({ error: "Artifact not found." }, { status: 404 });
  }

  if (await runsIncludeSandbox(env, userId, sandboxId)) return null;
  if (await callerMayReadSharedRuns(request, env)) {
    if (await runsIncludeSandbox(env, ORCHESTRATOR_NAME, sandboxId)) return null;
  }
  return Response.json({ error: "Artifact not found." }, { status: 404 });
}

export function readArtifactAccessAgent(object: {
  customMetadata?: Record<string, string>;
}): string | undefined {
  const value = object.customMetadata?.[ACCESS_AGENT_METADATA];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
