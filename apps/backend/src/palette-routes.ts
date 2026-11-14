import { isTeamWorkspaceId } from "@shiba/shared";
import type { Env } from "./env.js";
import { getCustomAgentById } from "./custom-agents-store.js";
import { clearPalettePin, listPaletteBots, setPalettePin } from "./palette-store.js";
import { isAuthorizedRequest, requireApplicationJson, requireSameOriginBrowserMutation, resolveUserId } from "./request-auth.js";
import { getTeamWorkspaceMembership, normalizeTeamWorkspaceEmail } from "./team-workspaces-store.js";

const json = (body: unknown, status = 200) =>
  Response.json(body, { headers: { "content-type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, status });

async function viewer(request: Request, env: Env): Promise<{ workspaceId: string; userId: string; orgId: string } | Response> {
  if (request.headers.has("Authorization") || !(await isAuthorizedRequest(request, env))) {
    return json({ error: "Authenticated human session required." }, 401);
  }
  const url = new URL(request.url);
  const workspaceId = request.headers.get("X-Shiba-Workspace") ?? url.searchParams.get("workspaceId") ?? "";
  if (!isTeamWorkspaceId(workspaceId)) return json({ error: "Workspace not found." }, 404);
  const identity = await resolveUserId(request, env);
  if (!identity) return json({ error: "Authenticated human session required." }, 401);
  let userId: string;
  try { userId = normalizeTeamWorkspaceEmail(identity); }
  catch { return json({ error: "Authenticated email identity required." }, 403); }
  if (!(await getTeamWorkspaceMembership(env, workspaceId, userId))) return json({ error: "Workspace membership required." }, 403);
  if (!env.AGENT_AUDIT) return json({ error: "Palette storage is unavailable." }, 503);
  return { workspaceId, userId, orgId: `team:${workspaceId}` };
}

function slotFrom(pathname: string): number | null {
  const match = pathname.match(/^\/api\/palette\/pins\/([1-9])$/);
  if (!match) return null;
  const slot = Number(match[1]);
  return slot >= 1 && slot <= 9 ? slot : null;
}

/** GET /api/palette/bots and PUT/DELETE /api/palette/pins/:slot. */
export async function handlePalette(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/palette/bots") {
    if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
    const scope = await viewer(request, env);
    if (scope instanceof Response) return scope;
    try {
      const bots = await listPaletteBots(env, scope.workspaceId, scope.orgId, scope.userId);
      return json({ workspaceId: scope.workspaceId, bots });
    } catch {
      return json({ error: "Palette is temporarily unavailable." }, 503);
    }
  }
  const slot = slotFrom(url.pathname);
  if (slot === null) return null;
  if (request.method !== "PUT" && request.method !== "DELETE") return json({ error: "Method not allowed." }, 405);
  const origin = requireSameOriginBrowserMutation(request);
  if (origin) return origin;
  const scope = await viewer(request, env);
  if (scope instanceof Response) return scope;
  if (request.method === "DELETE") {
    await clearPalettePin(env, scope.workspaceId, scope.userId, slot);
    return json({ slot, actorId: null });
  }
  const type = requireApplicationJson(request);
  if (type) return type;
  let body: unknown;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON." }, 400); }
  const actorId = typeof body === "object" && body && "actorId" in body ? String((body as { actorId?: unknown }).actorId ?? "") : "";
  if (!actorId.startsWith("agent:")) return json({ error: "A bot actor is required." }, 400);
  const agent = await getCustomAgentById(env, scope.orgId, actorId.slice("agent:".length));
  if (!agent) return json({ error: "Bot not found." }, 404);
  try {
    await setPalettePin(env, scope.workspaceId, scope.userId, actorId, slot);
  } catch {
    return json({ error: "Pin could not be saved." }, 409);
  }
  return json({ slot, actorId });
}
