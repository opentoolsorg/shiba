/** Dedicated owner-only Gmail routes, always mounted after the global auth gate. */
import { verifiedAccessOwner } from "./access-jwt.js";
import { betterAuthFor, ensureBetterAuthSchema, isBetterAuthConfigured } from "./better-auth.js";
import type { Env } from "./env.js";
import { beginGmailConnect, cancelGmailConnect, disconnectGmail, finishGmailConnect, GMAIL_BASE, GmailError,
  gmailStatus, grantGmail, revokeGmailGrant } from "./gmail.js";
import { isAccessConfigured, isAuthorizedRequest } from "./request-auth.js";

/** Separate resolver: do not change resolveUserId's legacy session/email semantics. */
export async function gmailOwner(request: Request, env: Env): Promise<string | null> {
  if (isAccessConfigured(env)) {
    return env.ACCESS_AUD ? verifiedAccessOwner(request, env.ACCESS_AUD) : null;
  }
  if (!isBetterAuthConfigured(env) || !env.AGENT_AUDIT) return null;
  try {
    await ensureBetterAuthSchema(env);
    const session = await betterAuthFor(env).api.getSession({ headers: request.headers });
    const id = session?.user?.id;
    return typeof id === "string" && id.trim() !== "" ? JSON.stringify(["better-auth", id]) : null;
  } catch { return null; }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}
function requireSameOrigin(request: Request): void {
  // Cookie-authenticated mutations require explicit same-origin intent. OAuth GET
  // callbacks instead use the single-use owner-bound state + PKCE capability.
  if (request.headers.get("origin") !== new URL(request.url).origin ||
      request.headers.get("sec-fetch-site") === "cross-site") {
    throw new GmailError("Same-origin request required.", 403);
  }
}

async function grantBody(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 1024)) throw new GmailError("Invalid grant request.");
  if (!request.body) throw new GmailError("Invalid grant request.");
  const reader = request.body.getReader();
  const bytes = new Uint8Array(1024);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > bytes.length) throw new GmailError("Invalid grant request.");
      bytes.set(value, size);
      size += value.length;
    }
    try { return JSON.parse(new TextDecoder().decode(bytes.subarray(0, size))); }
    catch { throw new GmailError("Invalid grant request."); }
  } finally { await reader.cancel().catch(() => {}); }
}

export async function handleGmail(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== GMAIL_BASE && !url.pathname.startsWith(`${GMAIL_BASE}/`)) return null;
  try {
    if (!(await isAuthorizedRequest(request, env))) return json({ error: "Authentication required." }, 401);
    // Fails closed either way; this just tells the operator why.
    if (isAccessConfigured(env) && !env.ACCESS_AUD) {
      return json({ error: "Gmail requires ACCESS_AUD when Cloudflare Access is enabled." }, 503);
    }
    const owner = await gmailOwner(request, env);
    if (!owner) return json({ error: "Authenticated owner required." }, 401);
    const path = url.pathname.slice(GMAIL_BASE.length);
    if (request.method !== "GET") requireSameOrigin(request);
    if (path === "" && request.method === "GET") return json(await gmailStatus(env, owner));
    if (path === "/connect" && request.method === "POST") return json(await beginGmailConnect(env, owner));
    if (path === "/callback" && request.method === "GET") {
      const states = url.searchParams.getAll("state");
      if (url.searchParams.has("error") && states.length === 1) await cancelGmailConnect(env, owner, states[0]!);
      if (url.searchParams.has("error") || states.length !== 1 ||
          url.searchParams.getAll("code").length !== 1) throw new GmailError("Gmail authorization was not completed.");
      const connection = await finishGmailConnect(env, owner, url.searchParams.get("state")!, url.searchParams.get("code")!);
      return json({ connection });
    }
    if (path === "" && request.method === "DELETE") return json(await disconnectGmail(env, owner));
    if (path === "/grants" && request.method === "POST") {
      // Bound bytes while streaming, before decoding or parsing JSON.
      const body = await grantBody(request);
      if (typeof body !== "object" || body === null || Array.isArray(body) ||
          Object.keys(body).length !== 1 || !("token" in body) || typeof body.token !== "string") {
        throw new GmailError("Only an agent token is accepted.");
      }
      return json(await grantGmail(env, owner, body.token));
    }
    if (path.startsWith("/grants/") && request.method === "DELETE") {
      let principal: string;
      try { principal = decodeURIComponent(path.slice("/grants/".length)); }
      catch { throw new GmailError("Invalid principal."); }
      await revokeGmailGrant(env, owner, principal);
      return json({ revoked: true });
    }
    return json({ error: "Gmail route or method not found." }, 404);
  } catch (error) {
    return error instanceof GmailError
      ? json({ error: error.message }, error.status)
      : json({ error: "Gmail connection unavailable." }, 503);
  }
}
