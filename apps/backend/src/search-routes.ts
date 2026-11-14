import type { Env } from "./env.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import { isTeamWorkspaceId } from "@shiba/shared";
import { humanActorId } from "./collaboration-store.js";
import { getTeamWorkspaceMembership, normalizeTeamWorkspaceEmail } from "./team-workspaces-store.js";
import { searchWorkspace } from "./workspace-search-store.js";

const json = (body: unknown, status = 200) =>
  Response.json(body, { headers: { "content-type": "application/json; charset=utf-8" }, status });

/** GET /api/search?q= — workspace FTS; merges knowledge hits when WS07 exposes them. */
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
  try {
    userId = normalizeTeamWorkspaceEmail(identity);
  } catch {
    return json({ error: "Authenticated email identity required." }, 403);
  }
  if (!(await getTeamWorkspaceMembership(env, workspaceId, userId))) {
    return json({ error: "Workspace membership required." }, 403);
  }
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 1) return json({ workspaceId, actorId: humanActorId(userId), query: q, tasks: [], rooms: [], runs: [], knowledge: [] });
  if (q.length > 200) return json({ error: "Query too long." }, 400);
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? 30 : Number(limitRaw);
  if (!Number.isFinite(limit) || limit < 1 || limit > 50) return json({ error: "Invalid limit." }, 400);
  try {
    const hits = await searchWorkspace(env, workspaceId, q, limit);
    const tasks = hits.filter((h) => h.kind === "task").map((h) => ({ taskId: h.id, title: h.title, snippet: h.snippet, updatedAt: h.updatedAt }));
    const rooms = hits.filter((h) => h.kind === "room" || h.kind === "message").map((h) => ({
      roomId: h.kind === "message" ? h.id.split(":")[0] ?? h.id : h.id,
      title: h.title,
      snippet: h.snippet,
      updatedAt: h.updatedAt,
    }));
    const runs = hits.filter((h) => h.kind === "run").map((h) => ({ runId: h.id, title: h.title, snippet: h.snippet, updatedAt: h.updatedAt }));
    // WS07 merges knowledge_search here when that route ships; until then return [].
    const knowledge: unknown[] = [];
    return json({ workspaceId, actorId: humanActorId(userId), query: q, tasks, rooms, runs, knowledge });
  } catch {
    return json({ error: "Search is temporarily unavailable." }, 503);
  }
}