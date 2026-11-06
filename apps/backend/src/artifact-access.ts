import { getAgentByName } from "agents/routing";
import type { Env } from "./env.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import { ORCHESTRATOR_NAME } from "./slack-routes.js";
import { isApprover, parseApproverAllowlist } from "./slack-approval.js";
import {
  isAuthorizedSessionAgent,
  parseSessionAgentName,
  WEB_SESSION_PREFIX,
} from "./web-sessions.js";

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
  const userId = await resolveUserId(request, env);
  return userId !== null && isApprover(userId, parseApproverAllowlist(env.DASHBOARD_APPROVERS));
}

async function callerOwnsPrivateSession(
  env: Env,
  userId: string,
  accessAgent: string,
): Promise<boolean> {
  const parsed = parseSessionAgentName(accessAgent);
  if (!parsed || parsed.userId !== userId) return false;
  try {
    // Team executors deliberately have no private-session registry entry. A
    // matching owner in their address cannot replace current room/source ACLs.
    const owner = await getAgentByName(env.CodingOrchestrator, userId);
    const response = await owner.fetch(
      `https://internal/internal/web-sessions/${encodeURIComponent(parsed.sessionId)}`,
    );
    if (!response.ok) return false;
    const body = await response.json().catch(() => null) as {
      session?: { id?: unknown; userId?: unknown; agentName?: unknown; metadata?: unknown; deletingAt?: unknown };
    } | null;
    const session = body?.session;
    if (!session || session.id !== parsed.sessionId || session.userId !== userId ||
        session.agentName !== accessAgent || session.deletingAt !== undefined) return false;
    const metadata = session.metadata;
    if (metadata === undefined) return true;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
    const fields = metadata as Record<string, unknown>;
    return !(typeof fields.orgId === "string" && fields.orgId.startsWith("team:")) &&
      !Object.hasOwn(fields, "teamWorkspaceId") && !Object.hasOwn(fields, "teamMembershipVersion");
  } catch {
    return false;
  }
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
    if (isAuthorizedSessionAgent(accessAgent, userId)) {
      if (!accessAgent.startsWith(WEB_SESSION_PREFIX) ||
          await callerOwnsPrivateSession(env, userId, accessAgent)) return null;
      return Response.json({ error: "Artifact not found." }, { status: 404 });
    }
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
