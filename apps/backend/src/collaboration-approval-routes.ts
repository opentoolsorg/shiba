import { isApprovalExpired, isTeamWorkspaceId, LOCAL_INTAKE_DASHBOARD, LOCAL_INTAKE_HEADER, runInputHash, type PendingApproval } from "@shiba/shared";
import { getAgentByName } from "agents/routing";
import { isCollaborationApprovalDispatchable } from "./collaboration-context.js";
import { canReadCollaborationRoom } from "./collaboration-room-access.js";
import { collaborationEmployeeOrgId, getCollaborationHandoff, getCollaborationMembership, humanActorId, type CollaborationHandoffRow, type CollaborationScope } from "./collaboration-store.js";
import { getCustomAgentById, getCustomAgentVersion } from "./custom-agents-store.js";
import { signInternalRequest } from "./edge-identity.js";
import type { Env } from "./env.js";
import { isAuthorizedRequest, requireApplicationJson, requireSameOriginBrowserMutation, resolveUserId } from "./request-auth.js";
import { resolveTeamCollaborationScope } from "./team-collaboration-scope.js";

const ROUTE = /^\/api\/collaboration\/rooms\/(room_[a-f0-9]{24})\/handoffs\/([A-Za-z0-9_-]{1,100})\/approval$/;
const INPUT_HASH = /^[a-f0-9]{64}$/;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
const unavailable = (status = 409) => json({ error: "This approval is unavailable or its room, employee, or shared sources changed. Refresh the room and request a new handoff.", code: "approval_unavailable" }, status);

async function decisionBody(request: Request): Promise<{ expectedInputHash: string; reviewed: true; approved: boolean } | null> {
  const limit = 4096, reader = request.body?.getReader();
  if (!reader) return null;
  const output = new Uint8Array(limit); let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      if (size + part.value.length > limit) return null;
      output.set(part.value, size); size += part.value.length;
    }
    const body: unknown = JSON.parse(new TextDecoder().decode(output.subarray(0, size)));
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const value = body as Record<string, unknown>;
    if (Object.keys(value).length !== 3 || Object.keys(value).some((key) => !["expectedInputHash", "reviewed", "approved"].includes(key)) ||
      typeof value.expectedInputHash !== "string" || !INPUT_HASH.test(value.expectedInputHash) || value.reviewed !== true || typeof value.approved !== "boolean") return null;
    return value as { expectedInputHash: string; reviewed: true; approved: boolean };
  } catch { return null; }
  finally { await reader.cancel().catch(() => {}); }
}

function ownsHandoff(handoff: CollaborationHandoffRow | null, scope: CollaborationScope, owner: string, roomId: string): handoff is CollaborationHandoffRow {
  return Boolean(handoff && handoff.status === "active" && handoff.tenantId === scope.tenantId && handoff.workspaceId === scope.workspaceId &&
    handoff.roomId === roomId && handoff.senderUserId === scope.userId && handoff.senderActorId === humanActorId(scope.userId) &&
    handoff.executorAgentName === owner && !owner.includes(":") && handoff.approvalId && handoff.runId === `agent-tool:${handoff.approvalId}` &&
    handoff.recipientActorId.startsWith("agent:") && handoff.recipientActorId.length > 6 &&
    Number.isSafeInteger(handoff.profileVersion) && Number(handoff.profileVersion) > 0);
}

function boundApproval(approval: PendingApproval | undefined, scope: CollaborationScope, owner: string, handoff: CollaborationHandoffRow): approval is PendingApproval {
  return Boolean(approval && approval.approvalId === handoff.approvalId && approval.threadKey === owner &&
    (approval.kind === undefined || approval.kind === "run") && approval.status === "pending" && !isApprovalExpired(approval, Date.now()) &&
    approval.orgId === collaborationEmployeeOrgId(scope) && approval.collaborationHandoffId === handoff.handoffId &&
    approval.customAgentId === handoff.recipientActorId.slice(6) && approval.customAgentVersion === handoff.profileVersion &&
    approval.queuedBy === undefined && typeof approval.task === "string" && approval.task.length > 0 &&
    typeof approval.repoUrl === "string" && Number.isFinite(approval.createdAt));
}

async function current(request: Request, env: Env, scope: CollaborationScope, owner: string, original: CollaborationHandoffRow, approval: PendingApproval): Promise<boolean> {
  const fresh = await resolveTeamCollaborationScope(request, env);
  if (!fresh || fresh.userId !== scope.userId || fresh.tenantId !== scope.tenantId || fresh.workspaceId !== scope.workspaceId ||
    (await resolveUserId(request, env)) !== owner || !await canReadCollaborationRoom(env, { ...scope, roomId: original.roomId }, scope.userId)) return false;
  const handoff = await getCollaborationHandoff(env, scope, original.handoffId);
  const member = await getCollaborationMembership(env, scope, original.roomId, humanActorId(scope.userId));
  if (!member || member.actorKind !== "human" || !member.capabilities.includes("approval.decide")) return false;
  if (!ownsHandoff(handoff, scope, owner, original.roomId) || handoff.approvalId !== original.approvalId ||
    handoff.profileVersion !== original.profileVersion || handoff.recipientActorId !== original.recipientActorId ||
    handoff.recipientUserId !== original.recipientUserId || handoff.rootHandoffId !== original.rootHandoffId) return false;
  const profile = await getCustomAgentById(env, collaborationEmployeeOrgId(scope), approval.customAgentId!);
  const pinned = await getCustomAgentVersion(env, collaborationEmployeeOrgId(scope), approval.customAgentId!, approval.customAgentVersion!);
  return Boolean(profile && pinned && profile.version === approval.customAgentVersion &&
    await isCollaborationApprovalDispatchable(env, { handoffId: handoff.handoffId, approvalId: approval.approvalId,
      employeeId: approval.customAgentId!, employeeVersion: approval.customAgentVersion!, task: approval.task }));
}

/** Exact requester-only decision lane; no default DO, session fanout, or autonomous decision. */
export async function handleCollaborationApproval(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url), match = ROUTE.exec(url.pathname);
  if (!match) return null;
  if (request.headers.has("authorization") || !await isAuthorizedRequest(request, env)) return json({ error: "An authenticated human session is required." }, 401);
  if (request.method !== "GET" && request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const origin = request.headers.get("Origin");
  if ((origin !== null && origin !== url.origin) || request.headers.get("Sec-Fetch-Site") === "cross-site") return json({ error: "Same-origin request required." }, 403);
  if (!isTeamWorkspaceId(request.headers.get("X-Shiba-Workspace")) || url.search) return unavailable(404);
  const originError = requireSameOriginBrowserMutation(request); if (originError) return originError;
  let decision: Awaited<ReturnType<typeof decisionBody>> = null;
  if (request.method === "POST") {
    const contentError = requireApplicationJson(request); if (contentError) return contentError;
    decision = await decisionBody(request); if (!decision) return json({ error: "Review the exact frozen input before submitting a valid decision." }, 400);
  }
  if (!env.AGENT_AUDIT || !env.CodingOrchestrator) return unavailable(503);
  try {
    const owner = await resolveUserId(request, env), scope = await resolveTeamCollaborationScope(request, env);
    if (!owner || !scope || owner.trim().toLowerCase() !== scope.userId ||
      !/^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(owner) ||
      !await canReadCollaborationRoom(env, { ...scope, roomId: match[1]! }, scope.userId)) return unavailable(404);
    const handoff = await getCollaborationHandoff(env, scope, match[2]!);
    if (!ownsHandoff(handoff, scope, owner, match[1]!)) return unavailable(404);
    const member = await getCollaborationMembership(env, scope, handoff.roomId, humanActorId(scope.userId));
    if (!member || member.actorKind !== "human" || !member.capabilities.includes("approval.decide")) return unavailable(404);
    const stub = await getAgentByName(env.CodingOrchestrator, owner);
    const lookup = new Request("https://internal/api/approvals", { headers: { [LOCAL_INTAKE_HEADER]: LOCAL_INTAKE_DASHBOARD } });
    await signInternalRequest(lookup, env);
    const found = await stub.fetch(lookup); if (!found.ok) return unavailable(503);
    const body = await found.json() as { approvals?: PendingApproval[] };
    const candidates = body.approvals?.filter((item) => item.approvalId === handoff.approvalId) ?? [];
    const approval = candidates.length === 1 ? candidates[0] : undefined;
    if (!boundApproval(approval, scope, owner, handoff) || !await current(request, env, scope, owner, handoff, approval)) return unavailable();
    const inputHash = runInputHash({ ...approval, baseBranch: approval.baseBranch ?? "main", publishPullRequest: approval.publishPullRequest ?? false });
    if (!decision) {
      const { envSealed: _sealed, ...publicApproval } = approval;
      return json({ approval: publicApproval, inputHash, requesterUserId: scope.userId, handoffId: handoff.handoffId });
    }
    if (decision.expectedInputHash !== inputHash) return unavailable();
    const resolve = new Request("https://internal/api/approvals", { method: "POST", headers: {
      "Content-Type": "application/json", [LOCAL_INTAKE_HEADER]: LOCAL_INTAKE_DASHBOARD }, body: JSON.stringify({
      threadKey: owner, approvalId: approval.approvalId, approved: decision.approved, decidedBy: owner,
      source: "dashboard", expectedInputHash: inputHash,
    }) });
    await signInternalRequest(resolve, env);
    // Signing yields; membership and source revocation still fence dispatch.
    if (!await current(request, env, scope, owner, handoff, approval)) return unavailable();
    const resolved = await stub.fetch(resolve);
    if (!resolved.ok) return unavailable(resolved.status >= 500 ? 503 : 409);
    const result = await resolved.json() as { result?: string };
    if (result.result !== (decision.approved ? "approved" : "rejected")) return unavailable();
    if (!await current(request, env, scope, owner, handoff, approval)) return unavailable();
    return json({ result: result.result, approvalId: approval.approvalId, inputHash });
  } catch { return unavailable(503); }
}
