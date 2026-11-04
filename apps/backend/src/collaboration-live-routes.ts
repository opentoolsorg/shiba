import { runInputHash, type DelegatedRun } from "@shiba/shared";
import { getAgentByName } from "agents/routing";
import { isCollaborationApprovalDispatchable } from "./collaboration-context.js";
import { collaborationExecutorIdentity } from "./collaboration-executor.js";
import { canReadCollaborationRoom } from "./collaboration-room-access.js";
import { getCollaborationHandoff, type CollaborationHandoffRow, type CollaborationScope } from "./collaboration-store.js";
import type { RunRoomReplay } from "./conversation-room-do.js";
import { signInternalRequest } from "./edge-identity.js";
import type { Env } from "./env.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import { isRunRoomEvent, runRoomName, type RunRoomEvent } from "./run-room-events.js";
import { resolveTeamCollaborationScope } from "./team-collaboration-scope.js";

const ROUTE = /^\/api\/collaboration\/rooms\/([^/]+)\/handoffs\/([^/]+)\/live$/;
const SHA256 = /^[a-f0-9]{64}$/;
const STATUSES = new Set(["pending", "running", "completed", "error", "aborted", "cancelled", "unknown"]);

/** The selector is never authority: implementations must check current workspace membership. */
export type CollaborationLiveScopeResolver = (request: Request, env: Env) => Promise<CollaborationScope | null>;

function failure(status = 404): Response {
  return Response.json({ error: status === 503 ? "Shared execution is temporarily unavailable." : "Shared execution not found." }, {
    status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export function isSameCollaborationHandoff(a: CollaborationHandoffRow, b: CollaborationHandoffRow | null): b is CollaborationHandoffRow {
  return b !== null && b.status === "active" && a.handoffId === b.handoffId && a.roomId === b.roomId &&
    a.tenantId === b.tenantId && a.workspaceId === b.workspaceId &&
    a.runId === b.runId && a.approvalId === b.approvalId && a.executorAgentName === b.executorAgentName &&
    a.senderUserId === b.senderUserId && a.senderActorId === b.senderActorId &&
    a.recipientUserId === b.recipientUserId && a.recipientActorId === b.recipientActorId &&
    a.profileVersion === b.profileVersion && a.rootHandoffId === b.rootHandoffId;
}

export function isCollaborationRunBound(run: DelegatedRun | undefined, handoff: CollaborationHandoffRow): run is DelegatedRun {
  try {
    const evidence = run?.approval;
    return Boolean(run && STATUSES.has(run.status) && run.runId === handoff.runId &&
      run.runId === `agent-tool:${handoff.approvalId}` && run.collaborationHandoffId === handoff.handoffId &&
      run.customAgentId === handoff.recipientActorId.slice("agent:".length) && run.customAgentVersion === handoff.profileVersion &&
      evidence && evidence.approvalId === handoff.approvalId && typeof evidence.decidedBy === "string" &&
      evidence.decidedBy.trim() && !/^(?:(?:default|system|automation|agent|mcp|child|subagent)(?::|$)|task-cancel$|collaboration-cancellation$)/i.test(evidence.decidedBy.trim()) &&
      Number.isFinite(evidence.decidedAt) && evidence.decidedAt > 0 && typeof evidence.inputHash === "string" &&
      SHA256.test(evidence.inputHash) && evidence.inputHash === runInputHash(run) &&
      typeof run.task === "string" && (run.runtime === undefined || run.runtime === "sandbox" || run.runtime === "local"));
  } catch { return false; }
}

async function currentAccess(
  request: Request, env: Env, scope: CollaborationScope, handoff: CollaborationHandoffRow, run: DelegatedRun,
  resolveScope: CollaborationLiveScopeResolver,
): Promise<boolean> {
  const currentScope = await resolveScope(request, env);
  if (!currentScope || currentScope.userId !== scope.userId || currentScope.tenantId !== scope.tenantId || currentScope.workspaceId !== scope.workspaceId) return false;
  const identity = { tenantId: scope.tenantId, workspaceId: scope.workspaceId, roomId: handoff.roomId };
  if (!await canReadCollaborationRoom(env, identity, scope.userId)) return false;
  if (!isSameCollaborationHandoff(handoff, await getCollaborationHandoff(env, scope, handoff.handoffId))) return false;
  const root = await getCollaborationHandoff(env, scope, handoff.rootHandoffId);
  if (!root || root.roomId !== handoff.roomId || root.status !== "active") return false;
  if (!await isCollaborationApprovalDispatchable(env, {
    handoffId: handoff.handoffId, approvalId: handoff.approvalId!,
    employeeId: handoff.recipientActorId.slice("agent:".length), employeeVersion: handoff.profileVersion!, task: run.task,
  })) return false;
  return canReadCollaborationRoom(env, identity, scope.userId);
}

/** Defense in depth: a binding response cannot broaden the exact approved run. */
function validReplay(value: RunRoomReplay, runId: string, after: number): boolean {
  if (!value || value.runId !== runId || value.after !== after || !Array.isArray(value.frames) || value.frames.length > 256 ||
    ![value.oldest, value.latest, value.nextCursor].every((number) => Number.isSafeInteger(number) && number >= 0) ||
    value.oldest > value.latest || value.nextCursor > value.latest || typeof value.gap !== "boolean" || typeof value.hasMore !== "boolean") return false;
  const reset = value.gap && after > value.latest;
  if ((!reset && value.nextCursor < after) || (value.hasMore && (value.nextCursor >= value.latest || value.nextCursor <= (reset ? 0 : after)))) return false;
  let sequence = reset ? 0 : after;
  for (const frame of value.frames) {
    if (!frame || frame.type !== "run:event" || frame.runId !== runId || !Number.isSafeInteger(frame.sequence) ||
      frame.sequence <= sequence || frame.sequence > value.nextCursor || typeof frame.eventId !== "string" || frame.eventId.length > 128 ||
      !Number.isFinite(frame.createdAt) || !isRunRoomEvent(frame.event)) return false;
    sequence = frame.sequence;
  }
  return value.frames.length === 0 || value.nextCursor >= sequence;
}

function publicEvent(event: RunRoomEvent): RunRoomEvent {
  if (event.kind === "terminal") return { kind: "terminal", stream: event.stream, data: event.data };
  if (event.kind === "diff") return { kind: "diff", data: event.data, reset: event.reset, complete: event.complete };
  const message = event.message === undefined ? {} : { message: event.message };
  return event.kind === "child" ? { kind: "child", childId: event.childId, status: event.status, ...message }
    : { kind: "status", status: event.status, ...message };
}

/** Revocable HTTP replay, not a bearer room URL or a new execution/control surface. */
export async function handleCollaborationLive(
  request: Request, env: Env, resolveScope: CollaborationLiveScopeResolver = resolveTeamCollaborationScope,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(ROUTE);
  if (!match) return null;
  if (!await isAuthorizedRequest(request, env)) return failure(401);
  if (request.method !== "GET") return failure(405);
  const origin = request.headers.get("Origin");
  if ((origin !== null && origin !== url.origin) || request.headers.get("Sec-Fetch-Site") === "cross-site") return failure(403);
  let roomId: string, handoffId: string;
  try { roomId = decodeURIComponent(match[1]!); handoffId = decodeURIComponent(match[2]!); } catch { return failure(400); }
  const rawAfter = url.searchParams.get("after") ?? "0";
  const after = Number(rawAfter);
  if (!/^room_[a-f0-9]{24}$/.test(roomId) || !/^[A-Za-z0-9_-]{1,100}$/.test(handoffId) ||
    !/^(0|[1-9][0-9]{0,15})$/.test(rawAfter) || !Number.isSafeInteger(after) ||
    url.searchParams.getAll("after").length > 1 || [...url.searchParams.keys()].some((key) => key !== "after" && key !== "workspaceId")) return failure(400);
  if (!env.AGENT_AUDIT || !env.CodingOrchestrator || !env.ConversationRoom) return failure(503);
  try {
    const userId = (await resolveUserId(request, env))?.trim().toLowerCase();
    if (!userId) return failure(401);
    const scope = await resolveScope(request, env);
    if (!scope || scope.userId !== userId) return failure();
    if (!await canReadCollaborationRoom(env, { ...scope, roomId }, userId)) return failure();
    const handoff = await getCollaborationHandoff(env, scope, handoffId);
    // Team runs use their exact saved isolated executor. Never search private
    // sessions or adopt a client-supplied executor/room identity.
    const executor = handoff && collaborationExecutorIdentity(handoff);
    if (!handoff || handoff.roomId !== roomId || handoff.status !== "active" || !handoff.approvalId || !handoff.runId ||
      !executor || !handoff.recipientActorId.startsWith("agent:") ||
      !Number.isSafeInteger(handoff.profileVersion) || Number(handoff.profileVersion) < 1) return failure();
    const owner = await getAgentByName(env.CodingOrchestrator, executor.agentName);
    const readRun = async (): Promise<DelegatedRun | undefined> => {
      // Fresh requests discard client identity, intake and authorization headers.
      const lookup = new Request(`https://internal/api/runs/${encodeURIComponent(handoff.runId!)}`);
      await signInternalRequest(lookup, env);
      const found = await owner.fetch(lookup);
      if (!found.ok) return undefined;
      return (await found.json() as { run?: DelegatedRun }).run;
    };
    const run = await readRun();
    if (!isCollaborationRunBound(run, handoff) || !await currentAccess(request, env, scope, handoff, run, resolveScope)) return failure();
    const identity = { ownerId: executor.ownerId, sessionId: executor.sessionId, runId: handoff.runId };
    const replay = await env.ConversationRoom.getByName(runRoomName(identity.ownerId, identity.sessionId)).readRunEvents(identity, after, 256);
    if (!validReplay(replay, run.runId, after)) return failure(503);
    const freshRun = await readRun();
    if (!isCollaborationRunBound(freshRun, handoff) || freshRun.approval!.inputHash !== run.approval!.inputHash ||
      !await currentAccess(request, env, scope, handoff, freshRun, resolveScope)) return failure();
    return Response.json({ roomId, handoffId, runId: run.runId, runtime: freshRun.runtime ?? "sandbox", status: freshRun.status,
      source: "trusted-run-journal", readOnly: true, after: replay.after, oldest: replay.oldest, latest: replay.latest,
      nextCursor: replay.nextCursor, gap: replay.gap, hasMore: replay.hasMore,
      frames: replay.frames.map(({ type, sequence, eventId, runId, createdAt, event }) => ({ type, sequence, eventId, runId, createdAt, event: publicEvent(event) })),
    }, {
      headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    // No executor identity, private room names or upstream error bodies escape.
    return failure(503);
  }
}
