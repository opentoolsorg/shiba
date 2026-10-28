import { isSubagentRun, type DelegatedRun } from "@shiba/shared";
import { requireV1Read, v1Forbidden } from "../v1-auth.js";
import type { V1Context } from "./context.js";
import { readRun, runMessages, runStatus } from "./runs.js";

function notFound(id: string): Response {
  return Response.json({ _tag: "shiba/SubagentNotFound", subagentId: id }, { status: 404 });
}

async function visibleRuns(ctx: V1Context): Promise<DelegatedRun[] | Response> {
  const response = await ctx.forward("GET", "/api/runs");
  if (!response.ok) return response;
  const body = await response.json() as { runs?: DelegatedRun[] };
  return body.runs ?? [];
}

/** Resolve only through the caller-visible registry, never an unverified parent id. */
function rootRun(run: DelegatedRun, runs: DelegatedRun[]): DelegatedRun | null {
  const byId = new Map(runs.map((item) => [item.runId, item]));
  const visited = new Set([run.runId]);
  let current = run;
  while (current.parentRunId !== undefined) {
    if (visited.has(current.parentRunId)) return null;
    const parent = byId.get(current.parentRunId);
    if (!parent) return null;
    visited.add(parent.runId);
    current = parent;
  }
  return current;
}

function subagent(run: DelegatedRun, threadId: string) {
  return {
    id: run.runId,
    threadId,
    parentId: run.parentRunId!,
    subagentPath: run.subagentPath!,
    taskPath: run.subagentPath!,
    projectId: run.repoUrl,
    title: run.task.split("\n")[0]?.trim().slice(0, 80) || "Untitled subagent",
    status: runStatus(run),
    archived: run.archivedAt !== undefined,
    // Preserve reported units (tokens and USD); unavailable usage is not free usage.
    usage: run.usage ?? null,
    role: run.role ?? null,
    sandboxMode: run.subagentSandbox ?? null,
    createdAt: new Date(run.createdAt).toISOString(),
    updatedAt: new Date(run.updatedAt).toISOString(),
    lastActivityAt: new Date(run.updatedAt).toISOString(),
  };
}

export async function handleSubagents(ctx: V1Context): Promise<Response | null> {
  const threadMatch = ctx.url.pathname.match(/^\/api\/v1\/threads\/([^/]+)\/subagents$/);
  const oneMatch = ctx.url.pathname.match(/^\/api\/v1\/subagents\/([^/]+)(?:\/(messages))?$/);
  if (!threadMatch && !oneMatch) return null;
  if (!requireV1Read(ctx.principal)) return v1Forbidden();
  if (ctx.request.method !== "GET") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }
  let id: string;
  try { id = decodeURIComponent((threadMatch ?? oneMatch)![1]!); }
  catch { return Response.json({ ok: false, error: "invalid_id" }, { status: 400 }); }
  const run = await readRun(ctx, id);
  if (run instanceof Response) return run;
  if (oneMatch && !isSubagentRun(run)) return notFound(id);

  const runs = await visibleRuns(ctx);
  if (runs instanceof Response) return runs;
  if (oneMatch) {
    const root = rootRun(run, runs);
    if (!root) return notFound(id);
    if (oneMatch[2] === "messages") {
      // The registry stores the approved task and final summary, not a harness transcript.
      return Response.json({ items: runMessages(run), cursor: null });
    }
    return Response.json(subagent(run, root.runId));
  }

  const limitRaw = ctx.url.searchParams.get("limit") ?? "50";
  if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 100) {
    return Response.json({ ok: false, error: "invalid_limit" }, { status: 400 });
  }
  // Walk real lineage, including terminal intermediates; dotted path prefixes
  // alone are not identity and can repeat in independent thread trees.
  const descendants = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of runs) {
      if (!isSubagentRun(item) || descendants.has(item.runId) || !descendants.has(item.parentRunId!)) continue;
      descendants.add(item.runId);
      changed = true;
    }
  }
  const children = runs.filter((item) => item.runId !== id && descendants.has(item.runId))
    .sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId));
  const cursor = ctx.url.searchParams.get("cursor");
  const offset = cursor === null ? 0 : children.findIndex((item) => item.runId === cursor) + 1;
  if (cursor !== null && offset === 0) {
    return Response.json({ ok: false, error: "invalid_cursor" }, { status: 400 });
  }
  const page = children.slice(offset, offset + Number(limitRaw));
  return Response.json({ items: page.map((item) => subagent(item, id)),
    cursor: offset + page.length < children.length ? page.at(-1)!.runId : null });
}
