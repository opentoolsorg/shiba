import { authorizeCollaborationAction, isTeamWorkspaceId, runInputHash, type DelegatedRun, type PendingApproval } from "@shiba/shared";
import { getAgentByName } from "agents/routing";
import { isCollaborationContextCurrent } from "./collaboration-context.js";
import { handleCollaborationApproval } from "./collaboration-approval-routes.js";
import { collaborationExecutorIdentity, type CollaborationExecutorIdentity } from "./collaboration-executor.js";
import { isCollaborationRunBound, isSameCollaborationHandoff } from "./collaboration-live-routes.js";
import {
  COLLAB_TENANT_ID, getCollaborationHandoff, getCollaborationMembership, getCollaborationRoom,
  humanActorId, isCollaborationSlackRoomAudienceAuthorized, listCollaborationHandoffs,
  listCollaborationMemberships, listCollaborationRooms,
  type CollaborationHandoffRow, type CollaborationMembershipRow, type CollaborationRoomRow, type CollaborationScope,
} from "./collaboration-store.js";
import { signInternalRequest } from "./edge-identity.js";
import type { Env } from "./env.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import { getTeamWorkspaceMembership, normalizeTeamWorkspaceEmail } from "./team-workspaces-store.js";

/** Structural counterpart to the frontend DTO; never imports another app's source. */
export interface TeamWorkItemDto {
  id: string; workspaceId: string; roomId: string; roomTitle: string; title: string;
  assigneeUserId: string; assigneeActorId: string; assigneeKind: "human" | "agent"; assigneeName?: string;
  status: "queued" | "needs-approval" | "running" | "completed" | "blocked" | "cancelled" | "unknown";
  updatedAt: number; runId?: string; approvalRequired?: boolean; viewerCanApprove: boolean; resultAvailable?: boolean;
}

export const TEAM_WORK_LIMITS = { rooms: 20, tasks: 100, concurrentReads: 4 } as const;
const ROUTE = /^\/api\/workspaces\/([^/]+)\/work$/;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: {
  "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
} });
const missing = () => json({ error: "Workspace work is unavailable." }, 404);

async function roomAccess(env: Env, scope: CollaborationScope, roomId: string): Promise<boolean> {
  const room = await getCollaborationRoom(env, scope, roomId);
  if (!room || room.tenantId !== scope.tenantId || room.workspaceId !== scope.workspaceId) return false;
  const actor = { ...scope, kind: "human" as const, actorId: humanActorId(scope.userId) };
  const member = await getCollaborationMembership(env, scope, roomId, actor.actorId);
  return authorizeCollaborationAction({ ...scope, actor }, room, member ?? undefined, "room.read").allowed &&
    await isCollaborationSlackRoomAudienceAuthorized(env, scope, roomId);
}

function pinnedExecutor(handoff: CollaborationHandoffRow): CollaborationExecutorIdentity | null {
  const executor = collaborationExecutorIdentity(handoff);
  return executor &&
    handoff.recipientActorId.startsWith("agent:") && Number.isSafeInteger(handoff.profileVersion) && Number(handoff.profileVersion) > 0 &&
    handoff.runId && handoff.approvalId ? executor : null;
}

function runStatus(status: DelegatedRun["status"]): TeamWorkItemDto["status"] {
  if (status === "running" || status === "completed" || status === "cancelled") return status;
  if (status === "pending") return "queued";
  if (status === "error" || status === "aborted") return "blocked";
  return "unknown";
}

interface Candidate { handoff: CollaborationHandoffRow; room: CollaborationRoomRow; recipient: CollaborationMembershipRow }

/** Reuse the exact requester-only card admission; do not infer permission from a stored pointer. */
async function pendingApprovalForViewer(request: Request, env: Env, scope: CollaborationScope, handoff: CollaborationHandoffRow): Promise<boolean> {
  if (handoff.senderUserId !== scope.userId || handoff.senderActorId !== humanActorId(scope.userId)) return false;
  const url = new URL(`/api/collaboration/rooms/${encodeURIComponent(handoff.roomId)}/handoffs/${encodeURIComponent(handoff.handoffId)}/approval`, request.url);
  const headers = new Headers(request.headers);
  headers.set("X-Shiba-Workspace", scope.workspaceId);
  const response = await handleCollaborationApproval(new Request(url, { method: "GET", headers, signal: request.signal }), env);
  if (!response?.ok) return false;
  const proof = await response.json() as { handoffId?: string; requesterUserId?: string; inputHash?: string; approval?: PendingApproval };
  const approval = proof.approval;
  return Boolean(approval && proof.handoffId === handoff.handoffId && proof.requesterUserId?.trim().toLowerCase() === scope.userId &&
    approval.approvalId === handoff.approvalId && approval.status === "pending" && typeof proof.inputHash === "string" &&
    /^[a-f0-9]{64}$/.test(proof.inputHash) && proof.inputHash === runInputHash({ ...approval,
      baseBranch: approval.baseBranch ?? "main", publishPullRequest: approval.publishPullRequest ?? false }));
}

async function project(request: Request, env: Env, scope: CollaborationScope, candidate: Candidate): Promise<TeamWorkItemDto | null> {
  const { handoff, room, recipient } = candidate;
  const item: TeamWorkItemDto = {
    id: handoff.handoffId, workspaceId: scope.workspaceId, roomId: room.roomId, roomTitle: room.title, title: handoff.taskId,
    assigneeUserId: recipient.userId, assigneeActorId: recipient.actorId, assigneeKind: recipient.actorKind,
    assigneeName: recipient.displayName, status: handoff.status === "cancelled" ? "cancelled" : recipient.actorKind === "human" ? "queued" : "unknown",
    updatedAt: handoff.cancelledAt ?? handoff.createdAt, viewerCanApprove: false,
  };
  if (handoff.status === "cancelled") return item;
  if (!await isCollaborationContextCurrent(env, handoff.handoffId)) return { ...item, status: "blocked", resultAvailable: false };
  if (recipient.actorKind === "agent" && await pendingApprovalForViewer(request, env, scope, handoff)) {
    return { ...item, status: "needs-approval", approvalRequired: true, viewerCanApprove: true };
  }
  const executor = pinnedExecutor(handoff);
  if (!executor || !env.CodingOrchestrator) return item;
  try {
    const owner = await getAgentByName(env.CodingOrchestrator, executor.agentName);
    const request = new Request(`https://internal/api/runs/${encodeURIComponent(handoff.runId!)}`, { signal: AbortSignal.timeout(5_000) });
    await signInternalRequest(request, env);
    const response = await owner.fetch(request);
    const run = response.ok ? (await response.json() as { run?: DelegatedRun }).run : undefined;
    if (!isCollaborationRunBound(run, handoff)) return { ...item, resultAvailable: false };
    if (!isSameCollaborationHandoff(handoff, await getCollaborationHandoff(env, scope, handoff.handoffId)) ||
      !await roomAccess(env, scope, room.roomId)) return null;
    if (!await isCollaborationContextCurrent(env, handoff.handoffId, run.task, handoff.approvalId!)) {
      return { ...item, status: "blocked", resultAvailable: false };
    }
    return { ...item, status: runStatus(run.status), runId: run.runId,
      updatedAt: Number.isFinite(run.updatedAt) && run.updatedAt > 0 ? run.updatedAt : item.updatedAt,
      ...(run.status === "completed" && (Boolean(run.summary?.trim()) || Boolean(run.pullUrl) || Boolean(run.deliverables?.length))
        ? { resultAvailable: true } : {}),
    };
  } catch {
    // A transport failure or unverified body never changes a task into success.
    return { ...item, resultAvailable: false };
  }
}

async function boundedMap<T, U>(items: readonly T[], limit: number, mapper: (item: T) => Promise<U>): Promise<U[]> {
  const results: U[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!);
    }
  }));
  return results;
}

/** Current explicit room grants are the sole source; personal histories are never enumerated. */
export async function handleTeamWork(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url), match = ROUTE.exec(url.pathname);
  if (!match) return null;
  if (request.headers.has("Authorization") || !await isAuthorizedRequest(request, env)) return json({ error: "Authenticated human session required." }, 401);
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
  const origin = request.headers.get("Origin");
  if ((origin !== null && origin !== url.origin) || request.headers.get("Sec-Fetch-Site") === "cross-site") return json({ error: "Same-origin request required." }, 403);
  if (!isTeamWorkspaceId(match[1]) || url.searchParams.size > 0) return missing();
  const workspaceId = match[1];
  const selected = request.headers.get("X-Shiba-Workspace");
  if (selected !== null && selected !== workspaceId) return missing();
  if (!env.AGENT_AUDIT) return json({ error: "Workspace storage is unavailable." }, 503);
  try {
    const identity = await resolveUserId(request, env);
    if (!identity) return json({ error: "Authenticated human session required." }, 401);
    let userId: string;
    try { userId = normalizeTeamWorkspaceEmail(identity); }
    catch { return json({ error: "Authenticated email identity required." }, 403); }
    const membership = await getTeamWorkspaceMembership(env, workspaceId, userId);
    if (!membership) return missing();
    const scope = { tenantId: COLLAB_TENANT_ID, workspaceId, userId };
    const rooms = await listCollaborationRooms(env, scope);
    let truncated = rooms.length > TEAM_WORK_LIMITS.rooms;
    const candidates: Candidate[] = [];
    for (const [roomIndex, room] of rooms.slice(0, TEAM_WORK_LIMITS.rooms).entries()) {
      if (!await roomAccess(env, scope, room.roomId)) continue;
      const [members, handoffs] = await Promise.all([
        listCollaborationMemberships(env, scope, room.roomId), listCollaborationHandoffs(env, scope, room.roomId),
      ]);
      if (handoffs.length >= TEAM_WORK_LIMITS.tasks) truncated = true;
      for (const handoff of handoffs) {
        if (candidates.length >= TEAM_WORK_LIMITS.tasks) { truncated = true; break; }
        const recipient = members.find((member) => member.actorId === handoff.recipientActorId && member.userId === handoff.recipientUserId && member.status === "active");
        if (handoff.tenantId === scope.tenantId && handoff.workspaceId === workspaceId && handoff.roomId === room.roomId && recipient) candidates.push({ handoff, room, recipient });
      }
      if (candidates.length >= TEAM_WORK_LIMITS.tasks) {
        if (roomIndex + 1 < rooms.length) truncated = true;
        break;
      }
    }
    const projected = await boundedMap(candidates, TEAM_WORK_LIMITS.concurrentReads, (candidate) => project(request, env, scope, candidate));
    const current = await getTeamWorkspaceMembership(env, workspaceId, userId);
    if (!current || current.version !== membership.version) return missing();
    const tasks: TeamWorkItemDto[] = [];
    for (let index = 0; index < candidates.length; index++) {
      const task = projected[index], handoff = candidates[index]!.handoff;
      if (!task || !await roomAccess(env, scope, task.roomId)) continue;
      const fresh = await getCollaborationHandoff(env, scope, task.id);
      if (!fresh || fresh.status !== handoff.status || (handoff.status === "active" && !isSameCollaborationHandoff(handoff, fresh))) continue;
      if (handoff.status === "active" && !await isCollaborationContextCurrent(env, task.id)) {
        tasks.push({ ...task, status: "blocked", runId: undefined, resultAvailable: false, approvalRequired: false, viewerCanApprove: false });
      } else if (task.viewerCanApprove && !await pendingApprovalForViewer(request, env, scope, handoff)) {
        tasks.push({ ...task, status: "unknown", runId: undefined, resultAvailable: false, approvalRequired: false, viewerCanApprove: false });
      } else tasks.push(task);
    }
    const finalMembership = await getTeamWorkspaceMembership(env, workspaceId, userId);
    if (!finalMembership || finalMembership.version !== membership.version) return missing();
    return json({ workspaceId, currentActorId: humanActorId(userId), tasks: tasks.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)), truncated });
  } catch {
    return json({ error: "Workspace work is temporarily unavailable." }, 503);
  }
}
