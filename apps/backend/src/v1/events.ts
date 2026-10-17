import type { DelegatedRun, SpineEvent } from "@shiba/shared";
import type { V1Context } from "./context.js";

const POLL_MS = 2_000;
const HEARTBEAT_MS = 15_000;
// Outbox kinds carry effect targets (channels, URLs); only resource events are public.
const PUBLIC_KIND = /^(run|approval)\./;
const KIND_STATUS: Record<string, string> = { "run.proposed": "waiting", "run.approved": "queued", "run.rejected": "rejected",
  "run.started": "running", "run.completed": "completed", "run.failed": "failed", "run.cancelled": "cancelled",
  "run.archived": "archived", "approval.requested": "pending" };

interface Spine { events: SpineEvent[]; earliestSeq: number; latestSeq: number }
interface Filters { projectId: string | null; threadId: string | null; runId: string | null; types: Set<string> | null }

async function readSpine(ctx: V1Context, since: number | null): Promise<Spine | Response> {
  const response = await ctx.forward("GET", since === null ? "/api/spine" : `/api/spine?since=${since}`);
  if (!response.ok) return response;
  return await response.json() as Spine;
}

// threads.ts publishes a thread's projectId as its repoUrl; events match it.
async function readProjects(ctx: V1Context, into: Map<string, string>): Promise<Response | null> {
  const response = await ctx.forward("GET", "/api/runs");
  if (!response.ok) return response;
  for (const run of (await response.json() as { runs?: DelegatedRun[] }).runs ?? []) into.set(run.runId, run.repoUrl);
  return null;
}

type PublicEvent = ReturnType<typeof publicEvent>;

function publicEvent(event: SpineEvent, projects: Map<string, string>) {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const status = typeof payload.result === "string" ? payload.result
    : typeof payload.status === "string" ? payload.status : KIND_STATUS[event.kind];
  const at = new Date(event.at).toISOString();
  const runId = event.runId ?? null;
  return { id: `evt_${event.seq}`, orgId: "self-hosted", projectId: runId === null ? null : projects.get(runId) ?? null,
    threadId: runId, runId, sequence: String(event.seq), type: event.kind,
    data: { id: event.runId ?? event.approvalId ?? event.commandId, ...(status ? { status } : {}) },
    occurredAt: at, publishedAt: at, cursor: String(event.seq) };
}

function matches(event: PublicEvent, filters: Filters) {
  return (filters.projectId === null || event.projectId === filters.projectId)
    && (filters.threadId === null || event.threadId === filters.threadId)
    && (filters.runId === null || event.runId === filters.runId)
    && (filters.types === null || filters.types.has(event.type));
}

// Pruned past the cursor: the seven-day contract maps to the spine's MAX_SPINE_EVENTS window.
const expired = (spine: Spine, cursor: number | null) => cursor !== null && spine.earliestSeq > cursor + 1;
const gone = () => Response.json({ ok: false, error: "cursor_expired" }, { status: 410 });

async function project(ctx: V1Context, spine: Spine, projects: Map<string, string>, filters: Filters) {
  const events = spine.events.filter((event) => PUBLIC_KIND.test(event.kind));
  if (events.some((event) => event.runId !== undefined && !projects.has(event.runId))) {
    const failed = await readProjects(ctx, projects);
    if (failed) return failed;
  }
  return events.map((event) => publicEvent(event, projects)).filter((event) => matches(event, filters));
}

export async function handleEvents(ctx: V1Context): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/api\/v1\/events(?:\/(head|stream))?$/);
  if (!match) return null;
  const action = match[1] ?? "list";
  if (ctx.request.method !== "GET") return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  const params = ctx.url.searchParams;
  const types = params.get("types");
  const filters: Filters = { projectId: params.get("projectId"), threadId: params.get("threadId"), runId: params.get("runId"),
    types: types === null ? null : new Set(types.split(",").map((type) => type.trim()).filter(Boolean)) };
  if (action === "head") {
    const spine = await readSpine(ctx, Number.MAX_SAFE_INTEGER);
    if (spine instanceof Response) return spine;
    return Response.json({ ok: true, cursor: String(spine.latestSeq) });
  }
  const limitRaw = params.get("limit") ?? "100";
  if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 500) return Response.json({ ok: false, error: "invalid_limit" }, { status: 400 });
  const limit = Number(limitRaw);
  const cursorRaw = (action === "stream" ? ctx.request.headers.get("Last-Event-ID") : null) ?? params.get("cursor");
  if (cursorRaw !== null && !/^\d+$/.test(cursorRaw)) return Response.json({ ok: false, error: "invalid_cursor" }, { status: 400 });
  const start = cursorRaw === null ? null : Number(cursorRaw);
  const spine = await readSpine(ctx, start);
  if (spine instanceof Response) return spine;
  if (expired(spine, start)) return gone();
  const projects = new Map<string, string>();
  const events = await project(ctx, spine, projects, filters);
  if (events instanceof Response) return events;
  if (action === "list") {
    const page = events.slice(0, limit);
    const hasMore = events.length > limit;
    // Nothing past the snapshot head matched, so a caller resumes from there rather than rescanning.
    return Response.json({ ok: true, events: page, hasMore,
      nextCursor: hasMore ? page.at(-1)!.cursor : String(Math.max(start ?? 0, spine.latestSeq)) });
  }
  return sse(ctx, spine, events, start ?? 0, limit, projects, filters);
}

function sse(ctx: V1Context, first: Spine, initial: PublicEvent[], from: number, limit: number,
  projects: Map<string, string>, filters: Filters): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let wake: (() => void) | undefined;
  const stop = () => { closed = true; wake?.(); };
  ctx.request.signal?.addEventListener("abort", stop);
  const loop = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    let cursor = from;
    let lastWrite = Date.now();
    let spine: Spine | Response = first;
    let batch: PublicEvent[] | Response = initial;
    try {
      while (!closed) {
        if (spine instanceof Response || batch instanceof Response) break;
        // Replay in limit-sized slices; the SSE id is the event cursor, so Last-Event-ID resumes exactly.
        const page = batch.slice(0, limit);
        for (const event of page) controller.enqueue(encoder.encode(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`));
        cursor = batch.length > limit ? Number(page.at(-1)!.cursor) : Math.max(cursor, spine.latestSeq);
        if (page.length > 0) lastWrite = Date.now();
        else if (Date.now() - lastWrite >= HEARTBEAT_MS) { controller.enqueue(encoder.encode(": heartbeat\n\n")); lastWrite = Date.now(); }
        if (batch.length <= limit) await new Promise<void>((resolve) => { const timer = setTimeout(resolve, POLL_MS); wake = () => { clearTimeout(timer); resolve(); }; });
        if (closed) break;
        // Each poll re-runs the signed forward, so a revoked session ends the stream.
        spine = await readSpine(ctx, cursor);
        if (spine instanceof Response || expired(spine, cursor)) break;
        batch = await project(ctx, spine, projects, filters);
      }
    } catch {
      // A thrown forward ends the stream; the client resumes with Last-Event-ID.
    } finally {
      ctx.request.signal?.removeEventListener("abort", stop);
      if (!closed) { closed = true; controller.close(); }
    }
  };
  const body = new ReadableStream<Uint8Array>({ start(controller) { void loop(controller); }, cancel: stop });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
