import { buildCapabilityDirectory } from "./capability-catalog.js";
import type { Env } from "./env.js";
import { isAuthorizedRequest } from "./request-auth.js";

/** Read-only dashboard directory from the same registrations served over MCP. */
export async function handleCapabilityCatalog(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/capabilities") return null;
  if (request.method !== "GET") return Response.json({ error: "Method not allowed." }, { status: 405 });
  if (!(await isAuthorizedRequest(request, env))) return Response.json({ error: "Authentication required." }, { status: 401 });

  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    return Response.json({ error: "limit must be a positive integer." }, { status: 400 });
  }
  try {
    const directory = buildCapabilityDirectory(env, limit === undefined ? {} : { limit });
    return Response.json(directory, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Capability catalog construction failed:", error instanceof Error ? error.message : String(error));
    return Response.json({ error: "Capability catalog is unavailable." }, { status: 503 });
  }
}
