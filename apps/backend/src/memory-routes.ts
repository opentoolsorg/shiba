/**
 * `/api/memory/*` — owner-scoped source library plus compatibility reads for
 * legacy facts/sessions. Legacy rows have no owner column, so only an exact
 * owner-to-agent name match is exposed; ambiguous global data is never merged.
 */
import type { Env } from "./env.js";
import { MEMORY_REGISTRY_NAME, memoryRegistryStub, memoryStub, ownerMemoryStub } from "./memory-do.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import { hasSameOriginIntent, methodNotAllowed } from "./route-utils.js";

const MEMORY_DO_BASE = "https://internal/internal/memory";

export async function handleMemory(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  const factId = /^\/api\/memory\/facts\/([^/]+)$/.exec(pathname)?.[1];
  const ownerSources = /^\/api\/memory\/sources(?:\/[^/]+)?$/.test(pathname);
  const ownerProjects = /^\/api\/memory\/projects(?:\/[^/]+)?$/.test(pathname);
  const ownerRecall = pathname === "/api/memory/recall";
  if (pathname !== "/api/memory/facts" && pathname !== "/api/memory/sessions" && factId === undefined && !ownerSources && !ownerProjects && !ownerRecall) {
    return null;
  }
  if (!(await isAuthorizedRequest(request, env))) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  if (["POST", "PATCH", "DELETE"].includes(request.method) && !hasSameOriginIntent(request)) {
    return Response.json({ error: "Same-origin request required." }, { status: 403 });
  }
  if (env.Memory === undefined) {
    return Response.json(
      { error: "Memory is not provisioned yet." },
      { status: 503 },
    );
  }
  if (ownerSources || ownerProjects || ownerRecall) {
    const userId = await resolveUserId(request, env);
    // The route has already passed its own auth check. A loopback-only
    // development session has no account identity, so it receives a
    // deliberately local partition that cannot collide with real accounts.
    const owner = userId ?? "local-development-owner";
    const stub = await ownerMemoryStub(env, owner);
    // Scope is derived exclusively from the verified dashboard identity;
    // never relay caller-supplied owner/workspace query params to the DO.
    const target = `https://internal${pathname.replace("/api/memory", "/internal/memory")}${ownerRecall ? url.search : ""}`;
    const init: RequestInit = { method: request.method };
    const contentType = request.headers.get("content-type");
    if (contentType !== null) init.headers = { "Content-Type": contentType };
    if (request.method === "POST" || request.method === "PATCH") init.body = await request.text();
    return stub.fetch(target, init);
  }
  // Legacy Memory facts and session records have only an agent name, not an
  // owner key. Treat exact identity-name matches as the only established
  // ownership relation. The loopback-only development session uses its one
  // local `default` agent partition; it never expands to the global registry.
  const userId = await resolveUserId(request, env);
  const legacyAgent = userId ?? "default";
  if (legacyAgent === MEMORY_REGISTRY_NAME) {
    return Response.json({ error: "No owner-scoped legacy memory partition exists." }, { status: 404 });
  }
  if (factId !== undefined) {
    if (request.method !== "DELETE") return methodNotAllowed();
    // `pathname` is still percent-encoded — forward the segment verbatim:
    // the DO decodes once, so re-encoding here double-encodes caller ids
    // that legitimately contain escapable characters (`bank` allows them).
    return memoryStub(env, legacyAgent).fetch(`${MEMORY_DO_BASE}/facts/${factId}`, {
      method: "DELETE",
    });
  }
  if (request.method !== "GET") return methodNotAllowed();
  const stub = memoryRegistryStub(env);
  const query = new URLSearchParams();
  query.set("agent", legacyAgent);
  for (const key of ["limit"] as const) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== "") {
      query.set(key, value);
    }
  }
  if (pathname === "/api/memory/sessions") {
    return stub.fetch(`${MEMORY_DO_BASE}/sessions?${query.toString()}`);
  }
  // ?q= switches the route from a plain fact listing to recall (T9 contract:
  // hits ranked by score); the Memory DO mirrors mailbox's /emails/search.
  const q = url.searchParams.get("q")?.trim() ?? "";
  const path = q === "" ? `${MEMORY_DO_BASE}/facts` : `${MEMORY_DO_BASE}/facts/search`;
  if (q !== "") {
    query.set("q", q);
  }
  return stub.fetch(`${path}?${query.toString()}`);
}
