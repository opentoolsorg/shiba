import { deliverableByteLimit, isSafeDeliverablePath } from "@shiba/shared";
import { getAgentByName } from "agents/routing";
import { assertSandboxArtifactAccess } from "./artifact-access.js";
import { canReadCollaborationRoom } from "./collaboration-room-access.js";
import { createCollaborationMessage, humanActorId } from "./collaboration-store.js";
import { deliverableResponse, deliverableViewOptions } from "./deliverable-response.js";
import { signInternalRequest } from "./edge-identity.js";
import type { Env } from "./env.js";
import { isAuthorizedRequest } from "./request-auth.js";
import { deliverableStorageKey } from "./run-deliverables.js";
import { resolveTeamCollaborationScope } from "./team-collaboration-scope.js";
import { buildSessionAgentName, DEFAULT_SESSION_ID, isValidSessionId } from "./web-sessions.js";

const ROUTE = /^\/api\/collaboration\/rooms\/(room_[a-f0-9]{24})\/shared-deliverables(?:\/(shared_[a-f0-9]{24}))?$/;
const SHARED_KIND = "shared_deliverable";
const sha256Hex = async (body: ArrayBuffer) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body)), (byte) => byte.toString(16).padStart(2, "0")).join("");

const fail = (status: number, error: string) => Response.json({ error }, { status, headers: { "Cache-Control": "private, no-store" } });
const sharedKey = (roomId: string, messageId: string) => `shared-deliverables/${roomId}/${messageId}`;

interface SharedRef { index: 0; path: string; sha256: string; bytes: number }

async function share(request: Request, env: Env, roomId: string): Promise<Response> {
  const scope = await resolveTeamCollaborationScope(request, env);
  if (!scope) return fail(401, "Authentication required.");
  if (!await canReadCollaborationRoom(env, { tenantId: scope.tenantId, workspaceId: scope.workspaceId, roomId }, scope.userId)) {
    return fail(404, "Room not found.");
  }
  const body = await request.json().catch(() => null) as { runId?: unknown; index?: unknown; sessionId?: unknown } | null;
  const index = body?.index;
  if (typeof body?.runId !== "string" || !body.runId || body.runId.length > 200 ||
      typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 7) return fail(400, "Choose a deliverable to share.");
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : DEFAULT_SESSION_ID;
  if (sessionId !== DEFAULT_SESSION_ID && !isValidSessionId(sessionId)) return fail(400, "Invalid session.");
  const agentName = sessionId === DEFAULT_SESSION_ID ? scope.userId : buildSessionAgentName(scope.userId, sessionId);
  // Only the owner's own completed run can be shared; team-scoped runs are never copied out.
  const lookup = new Request(`https://internal/api/runs/${encodeURIComponent(body.runId)}`);
  await signInternalRequest(lookup, env);
  const found = await (await getAgentByName(env.CodingOrchestrator, agentName)).fetch(lookup);
  if (!found.ok) return fail(404, "Deliverable not found.");
  const { run } = await found.json() as { run?: { status?: string; sandboxId?: string; expectedDeliverables?: string[];
    deliverables?: Array<{ path: string; bytes: number; sha256: string }>; approval?: unknown; collaborationHandoffId?: string } };
  const item = run?.deliverables?.[index];
  if (!run || run.status !== "completed" || !run.sandboxId || run.collaborationHandoffId || !item ||
      run.expectedDeliverables?.[index] !== item.path || !isSafeDeliverablePath(item.path) ||
      !Number.isInteger(item.bytes) || item.bytes < 1 || item.bytes > deliverableByteLimit(item.path) ||
      !/^[a-f0-9]{64}$/.test(item.sha256)) return fail(404, "Deliverable not found.");
  const denied = await assertSandboxArtifactAccess(request, env, run.sandboxId, sessionId === DEFAULT_SESSION_ID ? undefined : agentName);
  if (denied) return fail(404, "Deliverable not found.");
  const object = await env.ATTACHMENTS.get(deliverableStorageKey(run.sandboxId, item.sha256, index));
  const bytes = object ? await object.arrayBuffer() : null;
  if (!bytes || bytes.byteLength !== item.bytes || await sha256Hex(bytes) !== item.sha256) return fail(409, "Deliverable integrity check failed.");
  const messageId = `shared_${Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const ref: SharedRef = { index: 0, path: item.path, sha256: item.sha256, bytes: item.bytes };
  // The room keeps its own snapshot, so the card outlives the sender's session.
  await env.ATTACHMENTS.put(sharedKey(roomId, messageId), bytes);
  try {
    const saved = await createCollaborationMessage(env, scope, {
      messageId, tenantId: scope.tenantId, workspaceId: scope.workspaceId, roomId, senderUserId: scope.userId,
      senderActorId: humanActorId(scope.userId), senderKind: "human", body: `Shared ${item.path}`, profileVersion: null, createdAt: Date.now(),
    });
    if (!saved) throw new Error("not a room member");
    await env.AGENT_AUDIT.prepare(`UPDATE collaboration_messages SET message_kind=?, source_artifact_refs_json=?
      WHERE tenant_id=? AND workspace_id=? AND room_id=? AND message_id=?`)
      .bind(SHARED_KIND, JSON.stringify([ref]), scope.tenantId, scope.workspaceId, roomId, messageId).run();
    return Response.json({ messageId, roomId, path: item.path }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch {
    await env.ATTACHMENTS.delete(sharedKey(roomId, messageId)).catch(() => {});
    return fail(503, "Could not share to the room.");
  }
}

async function read(request: Request, env: Env, roomId: string, messageId: string): Promise<Response> {
  const scope = await resolveTeamCollaborationScope(request, env);
  if (!scope || !await canReadCollaborationRoom(env, { tenantId: scope.tenantId, workspaceId: scope.workspaceId, roomId }, scope.userId)) {
    return fail(404, "Deliverable not found.");
  }
  const row = await env.AGENT_AUDIT.prepare(`SELECT source_artifact_refs_json FROM collaboration_messages
    WHERE tenant_id=? AND workspace_id=? AND room_id=? AND message_id=? AND message_kind=?`)
    .bind(scope.tenantId, scope.workspaceId, roomId, messageId, SHARED_KIND).first<{ source_artifact_refs_json: string }>();
  let ref: SharedRef | undefined;
  try { ref = (JSON.parse(row?.source_artifact_refs_json ?? "[]") as SharedRef[])[0]; } catch { /* treated as missing */ }
  if (!ref || !isSafeDeliverablePath(ref.path) || !/^[a-f0-9]{64}$/.test(ref.sha256)) return fail(404, "Deliverable not found.");
  const object = await env.ATTACHMENTS.get(sharedKey(roomId, messageId));
  const bytes = object ? await object.arrayBuffer() : null;
  if (!bytes || bytes.byteLength !== ref.bytes || await sha256Hex(bytes) !== ref.sha256) return fail(404, "Deliverable not found.");
  return deliverableResponse(ref.path, bytes, deliverableViewOptions(new URL(request.url)), { "Cache-Control": "private, no-store" });
}

/** Share-to-room cards: a member-readable snapshot served by the same safe viewer headers. */
export async function handleCollaborationShare(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(ROUTE);
  if (!match) return null;
  if (!await isAuthorizedRequest(request, env)) return fail(401, "Authentication required.");
  if (!env.AGENT_AUDIT || !env.CodingOrchestrator || !env.ATTACHMENTS) return fail(503, "Sharing is unavailable.");
  const origin = request.headers.get("Origin");
  if ((origin !== null && origin !== url.origin) || request.headers.get("Sec-Fetch-Site") === "cross-site") return fail(403, "Cross-site request refused.");
  try {
    if (request.method === "POST" && !match[2]) return await share(request, env, match[1]!);
    if (request.method === "GET" && match[2]) return await read(request, env, match[1]!, match[2]);
  } catch {
    return fail(503, "Shared deliverable is unavailable.");
  }
  return fail(405, "Method not allowed.");
}
