import type { Env } from "./env.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import { isTeamWorkspaceId } from "@shiba/shared";
import { humanActorId } from "./collaboration-store.js";
import { getTeamWorkspaceMembership, normalizeTeamWorkspaceEmail } from "./team-workspaces-store.js";
import { searchPaletteBots } from "./palette-store.js";
import { searchWorkspace, type WorkspaceSearchHit, type WorkspaceSearchKind } from "./workspace-search-store.js";

const json = (body: unknown, status = 200, extra?: Record<string, string>) =>
  Response.json(body, { headers: { "content-type": "application/json; charset=utf-8", ...extra }, status });

const KINDS: Record<string, readonly WorkspaceSearchKind[]> = {
  chats: ["room", "message"],
  rooms: ["room", "message"],
  tasks: ["task"],
  runs: ["run"],
};

function parseTypes(raw: string | null): { kinds: WorkspaceSearchKind[]; bots: boolean } | { error: string } {
  if (raw === null || raw.trim() === "") return { kinds: ["task", "room", "message", "run"], bots: true };
  const kinds = new Set<WorkspaceSearchKind>();
  let bots = false;
  for (const name of raw.split(",").map((part) => part.trim()).filter(Boolean)) {
    if (name === "bots") { bots = true; continue; }
    if (name === "knowledge") continue;
    const mapped = KINDS[name];
    if (!mapped) return { error: "Invalid types." };
    for (const kind of mapped) kinds.add(kind);
  }
  return { kinds: [...kinds], bots };
}

function chatHit(hit: WorkspaceSearchHit) {
  const roomId = hit.roomId || (hit.kind === "message" ? hit.id.split(":")[0] ?? hit.id : hit.id);
  const messageId = hit.kind === "message" ? hit.id.slice(roomId.length + 1) : null;
  return { roomId, threadRootId: hit.threadRootId, messageId, title: hit.title, snippet: hit.snippet, updatedAt: hit.updatedAt };
}

/** GET /api/search?q=&types=bots,chats,tasks — membership-scoped workspace search. */
export async function handleSearch(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/search") return null;
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
  if (request.headers.has("Authorization") || !(await isAuthorizedRequest(request, env))) {
    return json({ error: "Authenticated human session required." }, 401);
  }
  const workspaceId = request.headers.get("X-Shiba-Workspace") ?? url.searchParams.get("workspaceId") ?? "";
  if (!isTeamWorkspaceId(workspaceId)) return json({ error: "Workspace not found." }, 404);
  const identity = await resolveUserId(request, env);
  if (!identity) return json({ error: "Authenticated human session required." }, 401);
  let userId: string;
  try { userId = normalizeTeamWorkspaceEmail(identity); }
  catch { return json({ error: "Authenticated email identity required." }, 403); }
  if (!(await getTeamWorkspaceMembership(env, workspaceId, userId))) {
    return json({ error: "Workspace membership required." }, 403);
  }
  const parsed = parseTypes(url.searchParams.get("types"));
  if ("error" in parsed) return json({ error: parsed.error }, 400);
  const q = (url.searchParams.get("q") ?? "").trim();
  const empty = { workspaceId, actorId: humanActorId(userId), query: q, tasks: [], rooms: [], runs: [], knowledge: [], bots: [], chats: [], tookMs: 0 };
  if (q.length < 1) return json(empty, 200, { "Server-Timing": "search;dur=0" });
  if (q.length > 200) return json({ error: "Query too long." }, 400);
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? 30 : Number(limitRaw);
  if (!Number.isFinite(limit) || limit < 1 || limit > 50) return json({ error: "Invalid limit." }, 400);
  const started = Date.now();
  try {
    const orgId = `team:${workspaceId}`;
    const [hits, bots] = await Promise.all([
      parsed.kinds.length ? searchWorkspace(env, workspaceId, q, userId, limit, parsed.kinds) : Promise.resolve([]),
      parsed.bots ? searchPaletteBots(env, workspaceId, orgId, userId, q, limit) : Promise.resolve([]),
    ]);
    const tookMs = Date.now() - started;
    const tasks = hits.filter((hit) => hit.kind === "task").map((hit) => ({
      taskId: hit.id, title: hit.title, snippet: hit.snippet, updatedAt: hit.updatedAt, status: hit.taskStatus, ownerId: hit.taskOwnerId,
    }));
    const chats = hits.filter((hit) => hit.kind === "room" || hit.kind === "message").map(chatHit);
    const rooms = chats.map((hit) => ({ roomId: hit.roomId, title: hit.title, snippet: hit.snippet, updatedAt: hit.updatedAt }));
    const runs = hits.filter((hit) => hit.kind === "run").map((hit) => ({ runId: hit.id, title: hit.title, snippet: hit.snippet, updatedAt: hit.updatedAt }));
    return json(
      { workspaceId, actorId: humanActorId(userId), query: q, tasks, rooms, runs, knowledge: [], bots, chats, tookMs },
      200,
      { "Server-Timing": `search;dur=${tookMs}` },
    );
  } catch {
    return json({ error: "Search is temporarily unavailable." }, 503);
  }
}
