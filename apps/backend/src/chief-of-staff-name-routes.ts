import type { Env } from "./env.js";
import { isAuthorizedRequest, requireJsonContentType, requireSameOriginBrowserMutation, resolveUserId } from "./request-auth.js";

const MAX_NAME = 40;
// Control and bidi-override characters could spoof the name in the UI.
const UNSAFE_NAME = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Personal Chief of Staff display name; a label only, it never carries authority. */
export async function handleChiefOfStaffName(request: Request, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/chief-of-staff") return null;
  if (request.method !== "GET" && request.method !== "PUT") return json({ error: "Method not allowed." }, 405);
  if (request.headers.has("Authorization") || !(await isAuthorizedRequest(request, env))) {
    return json({ error: "Authenticated human session required." }, 401);
  }
  if (request.method === "PUT") {
    const blocked = requireSameOriginBrowserMutation(request) ?? requireJsonContentType(request);
    if (blocked) return blocked;
  }
  const owner = await resolveUserId(request, env);
  if (!owner || !env.AGENT_AUDIT) return json({ error: "Authenticated human session required." }, 401);
  if (request.method === "GET") {
    const row = await env.AGENT_AUDIT.prepare("SELECT name FROM chief_of_staff_names WHERE owner_id = ?").bind(owner).first<{ name: string }>();
    return json({ name: row?.name ?? null });
  }
  const body = await request.json().catch(() => null) as { name?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > MAX_NAME || UNSAFE_NAME.test(name)) return json({ error: `Name must be 1-${MAX_NAME} characters.` }, 400);
  await env.AGENT_AUDIT.prepare(
    "INSERT INTO chief_of_staff_names (owner_id, name, updated_at) VALUES (?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at",
  ).bind(owner, name, Date.now()).run();
  return json({ name });
}
