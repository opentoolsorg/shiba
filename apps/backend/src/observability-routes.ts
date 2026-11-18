import { dashboardObservationSchema } from "@shiba/shared";
import type { Env } from "./env.js";
import { isAuthorizedRequest } from "./request-auth.js";
import { observabilityStatus, recordDashboardObservation } from "./observability.js";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function handleObservability(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/observability") return null;
  if (!await isAuthorizedRequest(request, env)) return json({ error: "Authentication required." }, 401);
  if (request.method === "GET") return json(observabilityStatus(env));
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  // This endpoint is for the native dashboard only, not bearer clients or forms.
  if (request.headers.get("Origin") !== url.origin || request.headers.get("Sec-Fetch-Site") === "cross-site") {
    return json({ error: "Same-origin request required." }, 403);
  }
  if (request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return json({ error: "Content-Type must be application/json." }, 415);
  }
  const reader = request.body?.getReader();
  if (!reader) return json({ error: "Invalid event." }, 400);
  const bytes = new Uint8Array(256);
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (size + part.value.byteLength > bytes.length) {
        await reader.cancel();
        return json({ error: "Event is too large." }, 413);
      }
      bytes.set(part.value, size);
      size += part.value.byteLength;
    }
  } catch { return json({ error: "Invalid event." }, 400); }
  finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes.subarray(0, size))); }
  catch { return json({ error: "Invalid event." }, 400); }
  const parsed = dashboardObservationSchema.safeParse(body);
  if (!parsed.success) return json({ error: "Invalid event." }, 400);
  if (env.MCP_RATE_LIMIT && !(await env.MCP_RATE_LIMIT.limit({ key: "observability:dashboard" })).success) {
    return json({ error: "Too many events." }, 429);
  }
  const delivery = recordDashboardObservation(env, parsed.data);
  if (ctx) ctx.waitUntil(delivery);
  else await delivery;
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
