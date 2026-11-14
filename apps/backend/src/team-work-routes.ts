import { authorizeCollaborationAction, isTeamWorkspaceId, runInputHash, type DelegatedRun, type PendingApproval } from "@shiba/shared";
import { getAgentByName } from "agents/routing";
import { z } from "zod";
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
import { isAuthorizedRequest, requireJsonContentType, requireSameOriginBrowserMutation, resolveUserId } from "./request-auth.js";
import {
  archiveTeamWorkTask, commentTeamWorkTask, createTeamWorkTask, getTeamWorkTask, listTeamWorkTasks, TeamWorkTaskError, updateTeamWorkTask,
  type TeamWorkActivityEntry, type TeamWorkTask, type TeamWorkTaskPriority, type TeamWorkTaskStatus,
} from "./team-work-tasks-store.js";
import { getTeamWorkspaceMembership, normalizeTeamWorkspaceEmail } from "./team-workspaces-store.js";
import { upsertWorkspaceSearchDoc } from "./workspace-search-store.js";
import { publishWorkspaceEvent, workspaceTaskEvent } from "./workspace-events-client.js";

/** Structural counterpart to the frontend DTO; never imports another app's source. */
export interface TeamWorkItemDto {
  id: string; workspaceId: string; roomId: string; roomTitle: string; title: string;
  assigneeUserId?: string; assigneeActorId?: string; assigneeKind: "human" | "agent"; assigneeName?: string;
  status: "queued" | "needs-approval" | "running" | "completed" | "blocked" | "cancelled" | "unknown" | TeamWorkTaskStatus;
  updatedAt: number; runId?: string; approvalRequired?: boolean; viewerCanApprove: boolean; resultAvailable?: boolean;
  priority?: TeamWorkTaskPriority; ownerId?: string; reviewerId?: string; startDate?: string; endDate?: string; parentId?: string;
  blocked?: boolean; objective?: string; waitingOn?: string[]; context?: string[]; doneWhen?: string[];
  activity?: TeamWorkActivityEntry[]; archived?: boolean;
}

export const TEAM_WORK_LIMITS = { rooms: 20, tasks: 100, concurrentReads: 4 } as const;
const ROUTE = /^\/api\/workspaces\/([^/]+)\/work(?:\/(task_[a-f0-9]{24})(?:\/(archive|comments))?)?$/;
const BODY_LIMIT = 32_768;
const line = (max: number) => z.string().trim().min(1).max(max);
const lines = z.array(line(500)).max(50);
const actorRef = z.string().regex(/^(human|agent):\S{1,320}$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "Invalid date.");
const PATCH_FIELDS = z.object({
  title: line(200), status: z.enum(["backlog", "todo", "in-progress", "in-review", "done", "cancelled"]),
  priority: z.enum(["none", "low", "medium", "high", "urgent"]), blocked: z.boolean(),
  ownerId: actorRef.nullable(), reviewerId: actorRef.nullable(), startDate: day.nullable(), endDate: day.nullable(),
  parentId: z.string().regex(/^task_[a-f0-9]{24}$/).nullable(), objective: z.string().trim().max(4000).nullable(),
  waitingOn: lines, context: lines, doneWhen: lines,
}).partial();
const CREATE_BODY = PATCH_FIELDS.extend({ title: line(200) }).strict();
const COMMENT_BODY = z.object({ text: line(4000) }).strict();
const PATCH_BODY = z.object({
  patch: PATCH_FIELDS.strict().refine((patch) => Object.keys(patch).length > 0, "Patch must change at least one field."),
}).strict();
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

function storedItem(task: TeamWorkTask): TeamWorkItemDto {
  const owner = task.ownerId ?? undefined;
  return {
    id: task.taskId, workspaceId: task.workspaceId, roomId: "", roomTitle: "", title: task.title,
    assigneeKind: owner?.startsWith("agent:") ? "agent" : "human", assigneeActorId: owner,
    assigneeUserId: owner?.startsWith("human:") ? owner.slice("human:".length) : undefined,
    status: task.status, updatedAt: task.updatedAt, viewerCanApprove: false, priority: task.priority, ownerId: owner,
    reviewerId: task.reviewerId ?? undefined, startDate: task.startDate ?? undefined, endDate: task.endDate ?? undefined,
    parentId: task.parentId ?? undefined, blocked: task.blocked, objective: task.objective ?? undefined,
    waitingOn: task.waitingOn, context: task.context, doneWhen: task.doneWhen, activity: task.activity, archived: task.archived,
  };
}

async function readJson(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) throw new TeamWorkTaskError("Request body is too large.", 413);
  const text = await request.text();
  if (text.length > BODY_LIMIT) throw new TeamWorkTaskError("Request body is too large.", 413);
  try { return JSON.parse(text); } catch { throw new TeamWorkTaskError("Request body must be a JSON object."); }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new TeamWorkTaskError(result.error.issues[0]?.message ?? "Invalid request body.");
  return result.data;
}

/** Workspace-owned tasks: any active member may create and edit; the actor comes from the session. */
async function mutateTeamWork(request: Request, env: Env, workspaceId: string, taskId: string | undefined, action: string | undefined): Promise<Response> {
  const allowed = taskId === undefined || action !== undefined ? "POST" : "PATCH";
  if (request.method !== allowed) return json({ error: "Method not allowed." }, 405);
  const originError = requireSameOriginBrowserMutation(request) ?? requireJsonContentType(request);
  if (originError) return originError;
  if (!isTeamWorkspaceId(workspaceId)) return missing();
  const selected = request.headers.get("X-Shiba-Workspace");
  if (selected !== null && selected !== workspaceId) return missing();
  if (!env.AGENT_AUDIT) return json({ error: "Workspace storage is unavailable." }, 503);
  try {
    const identity = await resolveUserId(request, env);
    if (!identity) return json({ error: "Authenticated human session required." }, 401);
    let userId: string;
    try { userId = normalizeTeamWorkspaceEmail(identity); }
    catch { return json({ error: "Authenticated email identity required." }, 403); }
    if (!await getTeamWorkspaceMembership(env, workspaceId, userId)) return json({ error: "Workspace membership required." }, 403);
    const actorId = humanActorId(userId), body = await readJson(request);
    if (action === "archive") return json({ task: storedItem(await archiveTeamWorkTask(env, workspaceId, taskId ?? "", actorId)) });
    if (action === "comments") {
      const { text } = parse(COMMENT_BODY, body);
      return json({ task: storedItem(await commentTeamWorkTask(env, workspaceId, taskId ?? "", actorId, text)) });
    }
    const { title, ...fields } = taskId === undefined ? parse(CREATE_BODY, body) : { title: undefined, ...parse(PATCH_BODY, body).patch };
    for (const person of [fields.ownerId, fields.reviewerId]) {
      if (person?.startsWith("human:") && !await getTeamWorkspaceMembership(env, workspaceId, person.slice("human:".length))) {
        return json({ error: "Owner and reviewer must be workspace members." }, 400);
      }
    }
    if (taskId !== undefined) {
      const updated = await updateTeamWorkTask(env, workspaceId, taskId, actorId, { title, ...fields });
      void upsertWorkspaceSearchDoc(env, workspaceId, updated.taskId, "task", updated.title, updated.objective ?? "", updated.updatedAt);
      void publishWorkspaceEvent(env, workspaceTaskEvent(workspaceId, updated.taskId, "task.updated", { title: updated.title }));
      return json({ task: storedItem(updated) });
    }
    // Pre-check what the follow-up update would reject so a failed create leaves no half-made task.
    if (fields.startDate && fields.endDate && fields.startDate > fields.endDate) return json({ error: "Start date must be on or before the end date." }, 400);
    const parent = fields.parentId ? await getTeamWorkTask(env, workspaceId, fields.parentId) : null;
    if (fields.parentId && (!parent || parent.archived)) return json({ error: "Parent task not found." }, 400);
    const created = await createTeamWorkTask(env, workspaceId, actorId, title ?? "");
    const task = Object.keys(fields).length ? await updateTeamWorkTask(env, workspaceId, created.taskId, actorId, fields) : created;
    void upsertWorkspaceSearchDoc(env, workspaceId, task.taskId, "task", task.title, task.objective ?? "", task.updatedAt);
    void publishWorkspaceEvent(env, workspaceTaskEvent(workspaceId, task.taskId, "task.created", { title: task.title }));
    return json({ task: storedItem(task) }, 201);
  } catch (error) {
    if (error instanceof TeamWorkTaskError) return json({ error: error.message }, error.status);
    return json({ error: "Workspace work is temporarily unavailable." }, 503);
  }
}

/** Current explicit room grants are the sole source; personal histories are never enumerated. */
export async function handleTeamWork(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url), match = ROUTE.exec(url.pathname);
  if (!match) return null;
  if (request.headers.has("Authorization") || !await isAuthorizedRequest(request, env)) return json({ error: "Authenticated human session required." }, 401);
  const [, routeWorkspaceId = "", taskId, action] = match;
  if (taskId !== undefined || request.method === "POST") return mutateTeamWork(request, env, routeWorkspaceId, taskId, action);
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
    const stored = await listTeamWorkTasks(env, workspaceId);
    tasks.push(...stored.tasks.map(storedItem));
    truncated ||= stored.truncated;
    const finalMembership = await getTeamWorkspaceMembership(env, workspaceId, userId);
    if (!finalMembership || finalMembership.version !== membership.version) return missing();
    return json({ workspaceId, currentActorId: humanActorId(userId), tasks: tasks.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)), truncated });
  } catch {
    return json({ error: "Workspace work is temporarily unavailable." }, 503);
  }
}
