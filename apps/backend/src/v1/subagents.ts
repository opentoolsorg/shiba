import { requireV1Read, v1Forbidden } from "../v1-auth.js";
import type { V1Context } from "./context.js";
import { readRun } from "./runs.js";

const EMPTY_USAGE = { llmCredits: 0, imageCredits: 0, vmCredits: 0, totalCredits: 0 };

export async function handleSubagents(ctx: V1Context): Promise<Response | null> {
  const threadMatch = ctx.url.pathname.match(/^\/api\/v1\/threads\/([^/]+)\/subagents$/);
  const oneMatch = ctx.url.pathname.match(/^\/api\/v1\/subagents\/([^/]+)(?:\/messages)?$/);
  if (!threadMatch && !oneMatch) return null;
  if (!requireV1Read(ctx.principal)) return v1Forbidden();
  if (ctx.request.method !== "GET") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }
  if (threadMatch) {
    let threadId: string;
    try { threadId = decodeURIComponent(threadMatch[1]!); }
    catch { return Response.json({ _tag: "shiba/ThreadNotFound", threadId: "" }, { status: 400 }); }
    const run = await readRun(ctx, threadId);
    if (run instanceof Response) {
      return Response.json({ _tag: "shiba/ThreadNotFound", threadId }, { status: 404 });
    }
    const limitRaw = ctx.url.searchParams.get("limit") ?? "50";
    if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 100) {
      return Response.json({ ok: false, error: "invalid_limit" }, { status: 400 });
    }
    return Response.json({ items: [], cursor: null });
  }
  let subagentId: string;
  try { subagentId = decodeURIComponent(oneMatch![1]!); }
  catch { return Response.json({ _tag: "shiba/SubagentNotFound", subagentId: "" }, { status: 400 }); }
  if (ctx.url.pathname.endsWith("/messages")) {
    return Response.json({ items: [], cursor: null });
  }
  return Response.json({
    id: subagentId,
    threadId: null,
    parentId: "",
    subagentPath: "",
    taskPath: "",
    projectId: null,
    title: null,
    status: "idle",
    archived: true,
    usage: EMPTY_USAGE,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastActivityAt: null,
    detail: "Subagent trees are not available until Phase 2b lands.",
  }, { status: 404 });
}
