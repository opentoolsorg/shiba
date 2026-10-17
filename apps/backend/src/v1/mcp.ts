import type { V1Context } from "./context.js";

// shiba's only MCP server is its own gateway (mcp-gateway.ts); oauth-mcp.ts stores the gateway's
// OAuth *clients*, not upstream servers, and harness sessions start with `mcpServers: []`.
const BUILTIN_ID = "shiba";

const notImplemented = (detail: string) =>
  Response.json({ ok: false, error: "not_implemented", code: "not_implemented", detail }, { status: 501 });
const invalid = () => Response.json({ ok: false, error: "invalid_request" }, { status: 400 });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function jsonBody(ctx: V1Context): Promise<Record<string, unknown> | null> {
  try {
    const text = await ctx.request.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    return isObject(parsed) ? parsed : null;
  } catch { return null; }
}

function validKey(ctx: V1Context, body: Record<string, unknown>): boolean {
  const key = ctx.request.headers.get("Idempotency-Key");
  const op = body.clientOperationId;
  return (key === null || (key.length > 0 && key.length <= 128)) &&
    (op === undefined || (typeof op === "string" && op.length > 0 && op.length <= 64));
}

// Credentials live in the bearer token the client already holds; nothing secret is echoed.
const builtin = (ctx: V1Context) => ({ id: BUILTIN_ID, projectId: null, name: "shiba",
  config: { transport: "http", url: `${ctx.url.origin}/mcp`, needsAuth: true }, enabled: true });

export async function handleMcp(ctx: V1Context): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/api\/v1\/mcp\/servers(?:\/([^/]+))?$/);
  if (!match) return null;
  const allowed = match[1] === undefined ? ["GET", "POST"] : ["PATCH", "DELETE"];
  if (!allowed.includes(ctx.request.method)) return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  // Global servers apply to every project, so a projectId filter still returns the gateway.
  if (ctx.request.method === "GET") return Response.json({ ok: true, servers: [builtin(ctx)] });
  const body = ctx.request.method === "DELETE" ? {} : await jsonBody(ctx);
  if (!body || !validKey(ctx, body)) return invalid();
  if (body.projectId !== undefined && body.projectId !== null && typeof body.projectId !== "string") return invalid();
  if (match[1] === undefined) {
    if (typeof body.name !== "string" || !body.name || !isObject(body.config) ||
        (body.enabled !== undefined && typeof body.enabled !== "boolean")) return invalid();
    return notImplemented("shiba has no upstream MCP server registry; harness sessions do not mount external MCP servers.");
  }
  let id: string;
  try { id = decodeURIComponent(match[1]); } catch { return invalid(); }
  if (ctx.request.method === "PATCH" && ((body.name !== undefined && (typeof body.name !== "string" || !body.name)) ||
      (body.config !== undefined && !isObject(body.config)) ||
      ["replaceConfig", "enabled"].some((key) => body[key] !== undefined && typeof body[key] !== "boolean"))) return invalid();
  if (id !== BUILTIN_ID) return Response.json({ ok: false, error: "mcp_server_not_found" }, { status: 404 });
  return Response.json({ ok: false, error: "mcp_server_read_only", detail: "The built-in shiba gateway cannot be edited or removed." }, { status: 409 });
}
