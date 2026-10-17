import type { DelegatedRun } from "@shiba/shared";
import type { V1Context } from "./context.js";
import { readRun } from "./runs.js";

type FileState = "added" | "modified" | "deleted" | "renamed" | "copied";

export function parseUnifiedDiff(diff: string) {
  return diff.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith("diff --git ")).map((chunk) => {
    const header = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const renameFrom = chunk.match(/^(?:rename|copy) from (.+)$/m)?.[1];
    const state: FileState = /^new file mode/m.test(chunk) ? "added" : /^deleted file mode/m.test(chunk) ? "deleted"
      : /^rename from/m.test(chunk) ? "renamed" : /^copy from/m.test(chunk) ? "copied" : "modified";
    const path = (state === "deleted" ? chunk.match(/^--- a\/(.+)$/m)?.[1] : chunk.match(/^\+\+\+ b\/(.+)$/m)?.[1])
      ?? chunk.match(/^(?:rename|copy) to (.+)$/m)?.[1] ?? header?.[2] ?? "";
    let additions = 0;
    let deletions = 0;
    const hunks = chunk.indexOf("\n@@");
    for (const line of hunks === -1 ? [] : chunk.slice(hunks + 1).split("\n")) {
      if (line.startsWith("+")) additions++;
      else if (line.startsWith("-")) deletions++;
    }
    const binary = /^Binary files .* differ$/m.test(chunk);
    return { path, ...(renameFrom ? { previousPath: renameFrom } : {}), state, additions, deletions, patch: chunk,
      ...(binary ? { truncated: true, truncatedReason: "binary" as const } : {}) };
  });
}

// T44 checkpoint refs are only durable as `checkpoint.captured` signals; the id is the ref's seq tail.
export function runCheckpoints(run: DelegatedRun) {
  return (run.signals ?? []).filter((signal) => signal.kind === "checkpoint.captured" && typeof signal.detail === "string")
    .map((signal, index) => ({ id: signal.detail!.split("/").at(-1)!, ref: signal.detail!, threadId: run.runId, runId: run.runId,
      label: index === 0 ? "baseline" : "settle", gitCommitSha: null, createdAt: new Date(signal.at).toISOString() }));
}

export async function handleDiffs(ctx: V1Context): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/api\/v1\/threads\/([^/]+)\/(diff|checkpoints)(?:\/([^/]+)\/(restore))?$/);
  if (!match || (match[2] === "diff" && match[3])) return null;
  const restore = match[4] === "restore";
  if (ctx.request.method !== (restore ? "POST" : "GET")) return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  let id: string;
  let checkpointId: string | undefined;
  try { id = decodeURIComponent(match[1]!); checkpointId = match[3] ? decodeURIComponent(match[3]) : undefined; }
  catch { return Response.json({ ok: false, error: "invalid_thread" }, { status: 400 }); }
  if (match[2] === "diff") {
    const mode = ctx.url.searchParams.get("mode") ?? "uncommitted";
    if (mode !== "uncommitted" && mode !== "base" && mode !== "pr") return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
    const run = await readRun(ctx, id);
    if (run instanceof Response) return run;
    const files = parseUnifiedDiff(run.diff ?? "");
    // The only persisted diff is baseline -> settle (T44), i.e. against the clone base.
    const exported = run.signals?.some((signal) => signal.kind === "diff.exported") ?? false;
    return Response.json({ ok: true, diff: { threadId: id, mode, files,
      stats: { files: files.length, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) },
      source: exported ? "run_inline_tail" : "run_inline", effectiveMode: "base", isFallback: mode !== "base",
      ...(run.diff ? {} : { unavailableReason: "no_diff_recorded" }) } });
  }
  if (!restore) {
    const limitRaw = ctx.url.searchParams.get("limit") ?? "100";
    if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 100) return Response.json({ ok: false, error: "invalid_limit" }, { status: 400 });
    const run = await readRun(ctx, id);
    if (run instanceof Response) return run;
    const all = runCheckpoints(run).map(({ ref: _ref, ...checkpoint }) => checkpoint);
    const cursor = ctx.url.searchParams.get("cursor");
    const offset = cursor === null ? 0 : all.findIndex((checkpoint) => checkpoint.id === cursor) + 1;
    if (cursor !== null && offset === 0) return Response.json({ ok: false, error: "invalid_cursor" }, { status: 400 });
    const page = all.slice(offset, offset + Number(limitRaw));
    return Response.json({ ok: true, nextCursor: offset + page.length < all.length ? page.at(-1)!.id : null, checkpoints: page });
  }
  let body: Record<string, unknown>;
  try {
    const text = await ctx.request.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch { return Response.json({ ok: false, error: "invalid_request" }, { status: 400 }); }
  const key = ctx.request.headers.get("Idempotency-Key") ?? body.clientOperationId;
  if (key !== undefined && (typeof key !== "string" || !key.trim() || key.length > 128)) {
    return Response.json({ ok: false, error: "invalid_idempotency_key" }, { status: 400 });
  }
  const run = await readRun(ctx, id);
  if (run instanceof Response) return run;
  const checkpoint = runCheckpoints(run).find((candidate) => candidate.id === checkpointId);
  if (!checkpoint) return Response.json({ ok: false, error: "checkpoint_not_found" }, { status: 404 });
  // In-place restore is refused by every harness (no conversation rollback); fork mints an approval-gated run from the ref.
  const response = await ctx.forward("POST", `/api/runs/${encodeURIComponent(id)}/fork`, {
    checkpoint: checkpoint.ref, ...(key ? { commandId: `v1:restore:${id}:${checkpoint.id}:${key}` } : {}),
  });
  if (!response.ok) return response;
  const queued = await response.json() as { approvalId?: string };
  return Response.json({ ok: true, result: { threadId: id, checkpointId: checkpoint.id, status: "waiting", approvalId: queued.approvalId } }, { status: 202 });
}
