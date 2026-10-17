import type { DelegatedRun } from "@shiba/shared";
import type { V1Context } from "./context.js";
import { readRun } from "./runs.js";

export async function handleThreads(ctx: V1Context): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/api\/v1\/threads\/([^/]+)(?:\/(questions)(?:\/([^/]+))?|\/(compact))?$/);
  if (!match || (!match[2] && !match[4] && ctx.request.method !== "PATCH")) return null;
  const method = match[2] && !match[3] ? "GET" : match[2] || match[4] ? "POST" : "PATCH";
  if (ctx.request.method !== method) return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  let id: string;
  try { id = decodeURIComponent(match[1]!); if (match[3]) decodeURIComponent(match[3]); }
  catch { return Response.json({ ok: false, error: "invalid_thread" }, { status: 400 }); }
  const run = await readRun(ctx, id);
  if (run instanceof Response) return run;
  // Approval decisions are not arbitrary assistant questions; never bypass their dedicated authorization gate.
  if (match[2] && !match[3]) return Response.json({ ok: true, questions: [] });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await ctx.request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch { return Response.json({ ok: false, error: "invalid_request" }, { status: 400 }); }
  if (match[3]) return Response.json({ ok: false, error: "question_not_found" }, { status: 404 });
  if (match[4]) return Response.json({ ok: false, error: "not_implemented", detail: "The run registry does not support conversation compaction." }, { status: 501 });
  const allowed = new Set(["archived", "status", "title", "spendLimitMicros", "expectedArchiveVersion", "expectedTitleVersion", "expectedVersion", "clientOperationId"]);
  if (Object.keys(body).some((key) => !allowed.has(key)) ||
      (body.archived !== undefined && typeof body.archived !== "boolean") ||
      (body.status !== undefined && body.status !== "archived" && body.status !== "ready") ||
      (body.title !== undefined && body.title !== null && typeof body.title !== "string") ||
      (body.spendLimitMicros !== undefined && body.spendLimitMicros !== null && (!Number.isSafeInteger(body.spendLimitMicros) || Number(body.spendLimitMicros) <= 0)) ||
      ["expectedArchiveVersion", "expectedTitleVersion", "expectedVersion"].some((key) => body[key] !== undefined && (!Number.isSafeInteger(body[key]) || Number(body[key]) < 0)) ||
      (body.clientOperationId !== undefined && (typeof body.clientOperationId !== "string" || !body.clientOperationId.length || body.clientOperationId.length > 64))) {
    return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
  if (body.archived !== undefined && body.status !== undefined && body.archived !== (body.status === "archived")) {
    return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
  const archive = body.archived ?? (body.status === undefined ? undefined : body.status === "archived");
  if (body.title !== undefined || body.spendLimitMicros !== undefined || archive === false ||
      ["expectedArchiveVersion", "expectedTitleVersion", "expectedVersion"].some((key) => body[key] !== undefined)) {
    return Response.json({ ok: false, error: "not_implemented", detail: "Thread metadata, unarchive, and optimistic versions require a thread registry." }, { status: 501 });
  }
  let updated: DelegatedRun = run;
  if (archive === true) {
    const response = await ctx.forward("POST", `/api/runs/${encodeURIComponent(id)}/archive`);
    if (!response.ok) return response;
    updated = (await response.json() as { run: DelegatedRun }).run;
  }
  return Response.json({ ok: true, thread: { id, projectId: updated.repoUrl,
    title: updated.task.split("\n")[0]?.trim().slice(0, 80) || "Untitled thread",
    status: updated.archivedAt !== undefined ? "archived" : updated.status === "completed" ? "ready" : updated.status === "pending" ? "queued" : updated.status === "running" ? "running" : "failed",
    archivedAt: updated.archivedAt === undefined ? null : new Date(updated.archivedAt).toISOString(),
    createdAt: new Date(updated.createdAt).toISOString(), updatedAt: new Date(updated.updatedAt).toISOString() } });
}
