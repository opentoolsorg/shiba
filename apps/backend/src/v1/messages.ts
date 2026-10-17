import type { V1Context } from "./context.js";
import { readRun, runActivity, runMessages, runStatus } from "./runs.js";

export async function handleMessages(ctx: V1Context): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/api\/v1\/threads\/([^/]+)\/(messages|export)$/);
  if (!match) return null;
  if (ctx.request.method !== "GET") return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  let id: string;
  try { id = decodeURIComponent(match[1]!); }
  catch { return Response.json({ ok: false, error: "invalid_thread" }, { status: 400 }); }
  const run = await readRun(ctx, id);
  if (run instanceof Response) return run;
  // This projection contains the stored task and final summary, not an unavailable harness transcript.
  const messages = runMessages(run);
  if (match[2] === "messages") {
    const limitRaw = ctx.url.searchParams.get("limit") ?? "500";
    const activityLimit = ctx.url.searchParams.get("activityLimit") ?? "5000";
    if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || !Number.isSafeInteger(Number(limitRaw)) ||
        !/^\d+$/.test(activityLimit) || !Number.isSafeInteger(Number(activityLimit))) {
      return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
    }
    let end = messages.length;
    const cursor = ctx.url.searchParams.get("cursor");
    if (cursor !== null) {
      try {
        const parsed = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/"))) as { id?: unknown; createdAt?: unknown };
        end = messages.findIndex((message) => message.id === parsed.id && message.createdAt === parsed.createdAt);
        if (end < 0) throw new Error();
      } catch { return Response.json({ ok: false, error: "invalid_cursor" }, { status: 400 }); }
    }
    const page = messages.slice(Math.max(0, end - Math.min(Number(limitRaw), 500)), end);
    const hasMore = page.length < end;
    const first = page[0];
    const nextCursor = hasMore && first ? btoa(JSON.stringify({ id: first.id, createdAt: first.createdAt })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : null;
    return Response.json({ ok: true, messages: page, hasMore, activityHasMore: false, nextCursor });
  }
  const level = ctx.url.searchParams.get("level") ?? "messages";
  const format = ctx.url.searchParams.get("format") ?? "markdown";
  const subagents = ctx.url.searchParams.get("subagents") ?? "true";
  if (!["messages", "activity", "full"].includes(level) || !["markdown", "json"].includes(format) || !["true", "false"].includes(subagents)) {
    return Response.json({ ok: false, error: "invalid_export_options" }, { status: 400 });
  }
  if (level === "full") return Response.json({ ok: false, error: "not_implemented", detail: "Full harness transcripts are not persisted." }, { status: 501 });
  const entries: object[] = messages.map((message) => ({ type: "message", id: message.id, role: message.role,
    author: message.role, content: message.content, createdAt: message.createdAt }));
  if (level === "activity") entries.push(...runActivity(run).map((item) => ({ type: "tool_call", id: item.id,
    createdAt: item.createdAt, toolName: item.toolName, label: item.description, status: item.status })));
  const title = run.task.split("\n")[0]?.trim().slice(0, 80) || "Untitled thread";
  const headers = { "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="transcript.${format === "json" ? "json" : "md"}"` };
  if (format === "json") return Response.json({ schemaVersion: 1, exportedAt: new Date().toISOString(), level,
    includeSubagents: subagents === "true", thread: { id, title, createdAt: new Date(run.createdAt).toISOString() },
    runs: [{ id, status: runStatus(run), createdAt: new Date(run.createdAt).toISOString(), entries }] }, { headers });
  const lines = [`# ${title}`, "", ...messages.flatMap((message) => [`## ${message.role}`, "", message.content, ""])];
  if (level === "activity") lines.push("## Activity", "", ...runActivity(run).map((item) => `- ${item.createdAt} ${item.description}`));
  return new Response(lines.join("\n"), { headers: { ...headers, "Content-Type": "text/markdown; charset=utf-8" } });
}
