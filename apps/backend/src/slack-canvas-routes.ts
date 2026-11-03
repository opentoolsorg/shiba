import { getAgentByName } from "agents/routing";
import { APPROVAL_TTL_MS } from "@shiba/shared";
import type { Env } from "./env.js";
import { getUserId, isAccessConfigured, isAuthorizedRequest } from "./request-auth.js";
import { redactSecrets } from "./security.js";
import { authenticatedRoomViewerId, runRoomName } from "./run-room-events.js";
import { parseSlackCanvasOrigin, resolveSlackCanvasBinding, signSlackCanvasRequest, slackCanvasOwner, type SlackCanvasBinding } from "./slack-canvas.js";

interface CanvasOrchestratorStub {
  fetch(request: Request): Promise<Response>;
}

interface SlackCanvasDeps {
  orchestrator?: (name: string) => Promise<CanvasOrchestratorStub>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function sameRoom(value: unknown, binding: SlackCanvasBinding): boolean {
  return record(value) && value.ownerId === binding.ownerId && value.sessionId === binding.sessionId && value.runId === binding.runId;
}

function workspaceLabel(value: Record<string, unknown>): string {
  const target = value.executionTarget;
  if (record(target) && target.kind === "artifact-workspace") {
    return typeof target.workspaceId === "string" ? `Workspace ${redactSecrets(target.workspaceId).slice(0, 128)}` : "Ephemeral workspace";
  }
  return typeof value.repoUrl === "string" && value.repoUrl ? redactSecrets(value.repoUrl).slice(0, 512) : "Ephemeral workspace";
}

function viewablePullUrl(value: unknown): string | undefined {
  return typeof value === "string" && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(value) ? value : undefined;
}

/** Dedicated reads recheck policy and retained provenance before touching a room. */
export async function handleSlackCanvas(request: Request, env: Env, deps: SlackCanvasDeps = {}): Promise<Response | null> {
  const url = new URL(request.url);
  const socketRequest = url.pathname === "/api/slack-canvas/websocket";
  if (!socketRequest && url.pathname !== "/api/slack-canvas") return null;
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
  if (!isAccessConfigured(env) || !(await isAuthorizedRequest(request, env)) || !getUserId(request)) {
    return json({ error: "Cloudflare Access authentication required." }, 401);
  }
  const origin = url.searchParams.get("origin") ?? "";
  const approvalId = url.searchParams.get("approval") ?? "";
  if (url.searchParams.getAll("origin").length !== 1 || url.searchParams.getAll("approval").length !== 1 ||
    !parseSlackCanvasOrigin(origin) || !/^[A-Za-z0-9_-]{1,128}$/.test(approvalId)) {
    return json({ error: "Invalid Slack canvas locator." }, 400);
  }
  if ((env.INTERNAL_SIGNING_KEY?.length ?? 0) < 32) return json({ error: "Slack canvas is not configured." }, 404);
  const actorId = getUserId(request)?.trim().toLowerCase() ?? "";
  const policy = slackCanvasOwner(env, origin);
  const binding = await resolveSlackCanvasBinding(env, origin, approvalId);
  if (!binding || !policy || (actorId !== binding.ownerId && !policy.viewerIds?.includes(actorId))) {
    return json({ error: "Slack canvas not found." }, 404);
  }
  if (socketRequest && (request.headers.get("Upgrade")?.toLowerCase() !== "websocket" || request.headers.get("Origin") !== url.origin)) {
    return json({ error: "A same-origin WebSocket connection is required." }, 403);
  }

  let snapshot: unknown;
  try {
    const stub = deps.orchestrator ? await deps.orchestrator(binding.orchestratorName)
      : await getAgentByName(env.CodingOrchestrator, binding.orchestratorName);
    const internal = new URL("https://internal/internal/slack-canvas");
    internal.searchParams.set("origin", origin);
    internal.searchParams.set("approval", approvalId);
    const signed = await signSlackCanvasRequest(new Request(internal), env.INTERNAL_SIGNING_KEY ?? "", origin);
    const response = await stub.fetch(signed);
    if (!response.ok) return json({ error: "Slack canvas not found." }, response.status === 503 ? 503 : 404);
    snapshot = await response.json();
  } catch {
    return json({ error: "Slack canvas is unavailable." }, 503);
  }
  if (!record(snapshot) || snapshot.source !== "slack" || snapshot.origin !== origin || !record(snapshot.approval)) {
    return json({ error: "Slack canvas not found." }, 404);
  }
  const approval = snapshot.approval;
  if (approval.approvalId !== approvalId || approval.threadKey !== origin ||
    (approval.kind !== undefined && approval.kind !== "run") || typeof approval.task !== "string" || !sameRoom(snapshot.runRoom, binding)) {
    return json({ error: "Slack canvas not found." }, 404);
  }
  if (snapshot.run === undefined || snapshot.run === null) {
    if (approval.status !== "pending" || typeof approval.createdAt !== "number" || !Number.isSafeInteger(approval.createdAt) || approval.createdAt > Date.now() + 60_000 ||
      Date.now() - approval.createdAt > APPROVAL_TTL_MS) return json({ error: "Slack canvas not found." }, 404);
    if (socketRequest) return json({ error: "This task is awaiting approval." }, 409);
    return json({
      state: "pending",
      approval: { approvalId, status: "pending", task: redactSecrets(approval.task).slice(0, 20_000), workspaceLabel: workspaceLabel(approval) },
    });
  }
  const run = snapshot.run;
  if (!record(run) || approval.status !== "approved" || run.runId !== binding.runId || !record(run.approval) ||
    run.approval.approvalId !== approvalId || !sameRoom(snapshot.runRoom, binding) ||
    !["pending", "running", "completed", "error", "aborted", "cancelled", "unknown"].includes(String(run.status))) {
    return json({ error: "Slack canvas not found." }, 404);
  }
  if (socketRequest) {
    const viewerId = url.searchParams.get("viewer") ?? "";
    if (url.searchParams.getAll("viewer").length !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(viewerId)) {
      return json({ error: "Invalid viewer identity." }, 400);
    }
    const headers = new Headers(request.headers);
    headers.set("x-shiba-room-owner", binding.ownerId);
    headers.set("x-shiba-room-session", binding.sessionId);
    headers.set("x-shiba-room-viewer", await authenticatedRoomViewerId(actorId, viewerId));
    headers.set("x-shiba-room-actor", actorId);
    headers.set("x-shiba-room-readonly", "true");
    headers.set("x-shiba-room-run", binding.runId);
    return env.ConversationRoom.getByName(runRoomName(binding.ownerId, binding.sessionId)).fetch(new Request(request, { headers }));
  }
  const pullUrl = viewablePullUrl(run.pullUrl);
  return json({
    state: "run",
    run: {
      runId: binding.runId, status: run.status, task: redactSecrets(approval.task).slice(0, 20_000), workspaceLabel: workspaceLabel(approval),
      ...(typeof run.publishPullRequest === "boolean" ? { publishPullRequest: run.publishPullRequest } : {}),
      ...(typeof run.summary === "string" ? { summary: redactSecrets(run.summary).slice(0, 8_000) } : {}),
      ...(typeof run.error === "string" ? { error: redactSecrets(run.error).slice(0, 2_000) } : {}),
      ...(pullUrl ? { pullUrl } : {}),
    },
    room: { sessionId: binding.sessionId, runId: binding.runId },
  });
}
