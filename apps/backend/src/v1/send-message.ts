import { isActiveStatus } from "@shiba/shared";
import { requireV1Write, v1Forbidden } from "../v1-auth.js";
import { enqueueThreadMessage, listQueuedMessages, removeQueuedMessage } from "../v1-message-queue.js";
import type { V1Context } from "./context.js";
import { readRun } from "./runs.js";

const DELIVERIES = new Set(["queue", "steer", "interrupt"]);

export async function handleSendMessage(ctx: V1Context): Promise<Response | null> {
  const match = ctx.url.pathname.match(
    /^\/api\/v1\/threads\/([^/]+)\/(?:message|messages\/([^/]+)\/(cancel|send-now))$/,
  );
  if (!match) return null;
  if (!requireV1Write(ctx.principal)) return v1Forbidden();
  let id: string;
  let eventId: string | undefined;
  let action: string | undefined;
  try {
    id = decodeURIComponent(match[1]!);
    eventId = match[2] ? decodeURIComponent(match[2]) : undefined;
    action = match[3];
  } catch {
    return Response.json({ _tag: "shiba/InvalidRequest", message: "invalid thread id." }, { status: 400 });
  }
  if (action !== undefined) {
    if (ctx.request.method !== "POST") {
      return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
    }
    const run = await readRun(ctx, id);
    if (run instanceof Response) return run;
    const removed = await removeQueuedMessage(ctx.env, id, eventId!);
    if (!removed) {
      return Response.json({ _tag: "shiba/MessageNotFound", eventId }, { status: 404 });
    }
    if (action === "cancel") {
      return Response.json({ ok: true, cancelled: true, id: removed.id });
    }
    const steer = await ctx.forward("POST", `/api/runs/${encodeURIComponent(id)}/steer`, {
      message: removed.text,
    });
    if (!steer.ok) return steer;
    const body = await steer.json() as { approvalId?: string };
    return Response.json({ ok: true, id: removed.id, approvalId: body.approvalId, delivery: "interrupt" });
  }
  if (ctx.request.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await ctx.request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ _tag: "shiba/InvalidRequest", message: "invalid request body." }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return Response.json({ _tag: "shiba/InvalidRequest", message: "text is required." }, { status: 400 });
  }
  const delivery = typeof body.delivery === "string" ? body.delivery : "interrupt";
  if (!DELIVERIES.has(delivery)) {
    return Response.json({ _tag: "shiba/InvalidRequest", message: "invalid delivery mode." }, { status: 400 });
  }
  const clientKey =
    typeof body.clientKey === "string" && body.clientKey.trim() ? body.clientKey.trim().slice(0, 64) : undefined;
  const run = await readRun(ctx, id);
  if (run instanceof Response) return run;
  if (delivery === "steer" && isActiveStatus(run.status)) {
    return Response.json({
      ok: false,
      error: "not_implemented",
      detail: "Mid-run steer without cancellation is not supported until the harness exposes live intake.",
    }, { status: 501 });
  }
  if (delivery === "queue" && isActiveStatus(run.status)) {
    const { message, deduped } = await enqueueThreadMessage(ctx.env, id, text, clientKey);
    return Response.json({ id: message.id, deduped, status: "queued" });
  }
  if (isActiveStatus(run.status)) {
    const steer = await ctx.forward("POST", `/api/runs/${encodeURIComponent(id)}/steer`, { message: text });
    if (!steer.ok) return steer;
    const queued = await steer.json() as { approvalId?: string };
    return Response.json({ id: `adm_${queued.approvalId ?? "pending"}`, deduped: false, approvalId: queued.approvalId });
  }
  const threadRun = run as typeof run & { threadKey?: string; continuationKey?: string };
  const { v1RunQueueBody } = await import("./run-intake.js");
  const queued = await ctx.forward(
    "POST",
    "/api/runs",
    v1RunQueueBody(ctx.principal, {
      repoUrl: run.repoUrl,
      task: `Follow-up on run ${id}:\n${text}`,
      ...(threadRun.threadKey ? { threadKey: threadRun.threadKey } : {}),
      ...(threadRun.continuationKey ? { continuesKey: threadRun.continuationKey } : {}),
      ...(clientKey ? { commandId: `v1:msg:${id}:${clientKey}` } : {}),
    }),
  );
  if (!queued.ok) return queued;
  const result = await queued.json() as { approvalId?: string; deduped?: boolean };
  return Response.json({
    id: `adm_${result.approvalId ?? "pending"}`,
    deduped: result.deduped === true,
    approvalId: result.approvalId,
    threadId: id,
  });
}

export async function handleQueuedMessagesList(ctx: V1Context): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/api\/v1\/threads\/([^/]+)\/queued-messages$/);
  if (!match || ctx.request.method !== "GET") return null;
  let id: string;
  try { id = decodeURIComponent(match[1]!); }
  catch { return Response.json({ ok: false, error: "invalid_thread" }, { status: 400 }); }
  const items = await listQueuedMessages(ctx.env, id);
  return Response.json({ ok: true, items });
}
