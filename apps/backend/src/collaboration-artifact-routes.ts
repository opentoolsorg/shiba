import { isSafeDeliverablePath, MAX_DELIVERABLE_BYTES, runInputHash, type DelegatedRun, type RunDeliverable } from "@shiba/shared";
import { getAgentByName } from "agents/routing";
import { isCollaborationApprovalDispatchable } from "./collaboration-context.js";
import { collaborationExecutorIdentity } from "./collaboration-executor.js";
import { canReadCollaborationRoom } from "./collaboration-room-access.js";
import { getCollaborationHandoff, type CollaborationHandoffRow, type CollaborationScope } from "./collaboration-store.js";
import { signInternalRequest } from "./edge-identity.js";
import type { Env } from "./env.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import { deliverableStorageKey } from "./run-deliverables.js";
import { resolveTeamCollaborationScope } from "./team-collaboration-scope.js";

const ROUTE = /^\/api\/collaboration\/rooms\/([^/]+)\/handoffs\/([^/]+)\/artifacts\/([^/]+)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ARTIFACT_ID = /^artifact_[a-f0-9]{32}$/;

function failure(status = 404): Response {
  return Response.json({ error: status === 503 ? "Shared deliverable is unavailable." : "Deliverable not found." }, {
    status, headers: { "Cache-Control": "private, no-store" },
  });
}

function sameHandoff(a: CollaborationHandoffRow, b: CollaborationHandoffRow | null): b is CollaborationHandoffRow {
  return b !== null && b.status === "active" && a.handoffId === b.handoffId && a.roomId === b.roomId &&
    a.tenantId === b.tenantId && a.workspaceId === b.workspaceId &&
    a.runId === b.runId && a.approvalId === b.approvalId && a.executorAgentName === b.executorAgentName &&
    a.senderUserId === b.senderUserId && a.senderActorId === b.senderActorId &&
    a.recipientUserId === b.recipientUserId && a.recipientActorId === b.recipientActorId &&
    a.profileVersion === b.profileVersion && a.rootHandoffId === b.rootHandoffId;
}

/** No session search, casing guess, or default-owner fallback is permitted for a shared download. */
function validRun(run: DelegatedRun | undefined, handoff: CollaborationHandoffRow, index: number): RunDeliverable | null {
  try {
    const evidence = run?.approval;
    const item = run?.deliverables?.[index];
    if (!run || run.status !== "completed" || run.runId !== handoff.runId ||
        run.runId !== `agent-tool:${handoff.approvalId}` || run.collaborationHandoffId !== handoff.handoffId ||
        run.customAgentId !== handoff.recipientActorId.slice("agent:".length) || run.customAgentVersion !== handoff.profileVersion ||
        !evidence || evidence.approvalId !== handoff.approvalId || typeof evidence.decidedBy !== "string" ||
        !evidence.decidedBy.trim() || /^(?:(?:default|system|automation|agent|mcp|child|subagent)(?::|$)|task-cancel$|collaboration-cancellation$)/i.test(evidence.decidedBy.trim()) ||
        !Number.isFinite(evidence.decidedAt) || evidence.decidedAt < 1 || typeof evidence.inputHash !== "string" ||
        !SHA256.test(evidence.inputHash) || evidence.inputHash !== runInputHash(run) ||
        typeof run.sandboxId !== "string" || !run.sandboxId || run.sandboxId.length > 200 ||
        typeof run.task !== "string" || !Array.isArray(run.expectedDeliverables) || !Array.isArray(run.deliverables) ||
        run.deliverables.length > 8 || !item || run.expectedDeliverables[index] !== item.path ||
        typeof item.path !== "string" || !isSafeDeliverablePath(item.path) ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > MAX_DELIVERABLE_BYTES ||
        typeof item.sha256 !== "string" || !SHA256.test(item.sha256) ||
        typeof item.artifactId !== "string" || !ARTIFACT_ID.test(item.artifactId) ||
        !Number.isSafeInteger(item.version) || Number(item.version) < 1 || item.sourceRunId !== run.runId) return null;
    return item;
  } catch {
    return null;
  }
}

/** Only artifacts explicitly published into this room's deterministic agent reply are shared. */
async function hasSharedArtifactRef(
  env: Env, scope: CollaborationScope, handoff: CollaborationHandoffRow, index: number, item: RunDeliverable,
): Promise<boolean> {
  const row = await env.AGENT_AUDIT.prepare(`SELECT source_artifact_refs_json FROM collaboration_messages
    WHERE tenant_id=? AND workspace_id=? AND room_id=? AND message_id=? AND sender_kind='agent'
      AND sender_user_id=? AND sender_actor_id=? AND profile_version=? AND source_run_id=? AND source_handoff_id=?`)
    .bind(scope.tenantId, scope.workspaceId, handoff.roomId, `agent_reply_${handoff.handoffId}`,
      handoff.recipientUserId, handoff.recipientActorId, handoff.profileVersion, handoff.runId, handoff.handoffId)
    .first<{ source_artifact_refs_json: string }>();
  if (!row || typeof row.source_artifact_refs_json !== "string" || row.source_artifact_refs_json.length > 8_192) return false;
  try {
    const refs: unknown = JSON.parse(row.source_artifact_refs_json);
    if (!Array.isArray(refs) || refs.length > 8) return false;
    const matches = refs.filter((ref: unknown) => ref !== null && typeof ref === "object" &&
      (ref as { index?: unknown }).index === index) as Array<Record<string, unknown>>;
    const ref = matches[0];
    return matches.length === 1 && ref !== undefined && ref.path === item.path && ref.artifactId === item.artifactId &&
      ref.version === item.version && ref.sha256 === item.sha256;
  } catch {
    return false;
  }
}

async function currentAccess(request: Request, env: Env, scope: CollaborationScope, handoff: CollaborationHandoffRow, run: DelegatedRun): Promise<boolean> {
  const currentScope = await resolveTeamCollaborationScope(request, env);
  if (!currentScope || currentScope.userId !== scope.userId || currentScope.tenantId !== scope.tenantId || currentScope.workspaceId !== scope.workspaceId) return false;
  const identity = { tenantId: scope.tenantId, workspaceId: scope.workspaceId, roomId: handoff.roomId };
  if (!await canReadCollaborationRoom(env, identity, scope.userId)) return false;
  const current = await getCollaborationHandoff(env, scope, handoff.handoffId);
  if (!sameHandoff(handoff, current)) return false;
  const root = await getCollaborationHandoff(env, scope, handoff.rootHandoffId);
  if (!root || root.roomId !== handoff.roomId || root.status !== "active") return false;
  if (!await isCollaborationApprovalDispatchable(env, {
    handoffId: handoff.handoffId, approvalId: handoff.approvalId!,
    employeeId: handoff.recipientActorId.slice("agent:".length), employeeVersion: handoff.profileVersion!, task: run.task,
  })) return false;
  return canReadCollaborationRoom(env, identity, scope.userId);
}

async function readBoundedBody(object: R2ObjectBody, bytes: number): Promise<ArrayBuffer | null> {
  const reader = object.body.getReader();
  const output = new Uint8Array(bytes);
  let used = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return used === bytes ? output.buffer : null;
      if (used + part.value.byteLength > bytes) return null;
      output.set(part.value, used);
      used += part.value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Authenticated, revocable room reads; archive bearer capabilities never enter this lane. */
export async function handleCollaborationArtifact(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(ROUTE);
  if (!match) return null;
  if (!await isAuthorizedRequest(request, env)) return failure(401);
  if (request.method !== "GET") return failure(405);
  const origin = request.headers.get("Origin");
  if ((origin !== null && origin !== url.origin) || request.headers.get("Sec-Fetch-Site") === "cross-site") return failure(403);
  const userId = (await resolveUserId(request, env))?.trim().toLowerCase();
  if (!userId) return failure(401);
  let roomId: string, handoffId: string, rawIndex: string;
  try {
    roomId = decodeURIComponent(match[1]!);
    handoffId = decodeURIComponent(match[2]!);
    rawIndex = decodeURIComponent(match[3]!);
  } catch { return failure(400); }
  if (!/^room_[a-f0-9]{24}$/.test(roomId) || !/^[A-Za-z0-9_-]{1,100}$/.test(handoffId) || !/^[0-7]$/.test(rawIndex)) return failure(400);
  if (!env.AGENT_AUDIT || !env.CodingOrchestrator || !env.ATTACHMENTS) return failure(503);
  try {
    const scope = await resolveTeamCollaborationScope(request, env);
    if (!scope || scope.userId !== userId) return failure();
    if (!await canReadCollaborationRoom(env, { ...scope, roomId }, userId)) return failure();
    const handoff = await getCollaborationHandoff(env, scope, handoffId);
    const executor = handoff && collaborationExecutorIdentity(handoff);
    if (!handoff || handoff.roomId !== roomId || handoff.status !== "active" || !handoff.approvalId ||
        !handoff.runId || !executor ||
        !handoff.recipientActorId.startsWith("agent:") || !Number.isSafeInteger(handoff.profileVersion) ||
        Number(handoff.profileVersion) < 1) return failure();
    const owner = await getAgentByName(env.CodingOrchestrator, executor.agentName);
    // A fresh request prevents forged client principal/intake/token headers from reaching the DO.
    const lookup = new Request(`https://internal/api/runs/${encodeURIComponent(handoff.runId)}`);
    await signInternalRequest(lookup, env);
    const found = await owner.fetch(lookup);
    if (!found.ok) return failure(found.status >= 500 ? 503 : 404);
    const { run } = await found.json() as { run?: DelegatedRun };
    const index = Number(rawIndex);
    const item = validRun(run, handoff, index);
    if (!run || !item || !await hasSharedArtifactRef(env, scope, handoff, index, item) ||
        !await currentAccess(request, env, scope, handoff, run)) return failure();
    const object = await env.ATTACHMENTS.get(deliverableStorageKey(run.sandboxId, item.sha256, index));
    if (!object) return failure();
    if (object.size !== item.bytes) {
      await object.body.cancel().catch(() => {});
      return failure(409);
    }
    const body = await readBoundedBody(object, item.bytes);
    if (!body) return failure(409);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== item.sha256) return failure(409);
    // Body reads and hashing yield: removed members and revoked selected sources must lose cached output too.
    if (!await hasSharedArtifactRef(env, scope, handoff, index, item) || !await currentAccess(request, env, scope, handoff, run)) return failure();
    const types: Record<string, string> = { md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8", json: "application/json; charset=utf-8", csv: "text/csv; charset=utf-8" };
    return new Response(body, { headers: {
      "Cache-Control": "private, no-store", "content-type": types[item.path.split(".").pop()!.toLowerCase()]!,
      "content-disposition": `attachment; filename="${item.path.split("/").pop()!}"`,
      "content-length": String(item.bytes), "x-content-type-options": "nosniff",
    } });
  } catch {
    // Do not disclose executor identity, private object keys or upstream errors.
    return failure(503);
  }
}
