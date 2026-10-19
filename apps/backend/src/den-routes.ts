import { getAgentByName } from "agents/routing";
import { buildDenAgentName, parseDenAgentName, sanitizeDenSlug } from "@shiba/shared";
import type { Env } from "./env.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import { signInternalRequest } from "./edge-identity.js";
import { readDenDriveFile, writeDenDriveFile } from "./den/drive.js";

const DEN_API_PREFIX = "/api/dens/";
const LEGACY_CAPTAIN_API_PREFIX = "/api/captains/";

function denApiPrefix(pathname: string): string | null {
  if (pathname.startsWith(DEN_API_PREFIX)) return DEN_API_PREFIX;
  if (pathname.startsWith(LEGACY_CAPTAIN_API_PREFIX)) return LEGACY_CAPTAIN_API_PREFIX;
  return null;
}

export async function handleDenRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const prefix = denApiPrefix(url.pathname);
  if (!prefix) return null;
  if (!(await isAuthorizedRequest(request, env))) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  const userId = (await resolveUserId(request, env)) ?? "default";
  const rest = url.pathname.slice(prefix.length);
  const segments = rest.split("/").filter(Boolean);
  const slugRaw = segments[0];
  if (!slugRaw) {
    return Response.json({ error: "Den slug required." }, { status: 400 });
  }
  let slug: string;
  try {
    slug = decodeURIComponent(slugRaw);
  } catch {
    return Response.json({ error: "Invalid den slug." }, { status: 400 });
  }
  if (!sanitizeDenSlug(slug)) {
    return Response.json({ error: "Invalid den slug." }, { status: 400 });
  }
  const agentName = buildDenAgentName(userId, slug);
  const stub = await getAgentByName(env.CodingOrchestrator, agentName);

  if (segments.length === 1 && request.method === "GET") {
    const internal = new Request("https://internal/internal/den/snapshot", { method: "GET" });
    await signInternalRequest(internal, env);
    const response = await stub.fetch(internal);
    const out = new Response(response.body, response);
    out.headers.set("cache-control", "no-store");
    return out;
  }

  if (segments[1] === "drive" && segments.length >= 3) {
    const drivePath = decodeURIComponent(segments.slice(2).join("/"));
    if (request.method === "GET") {
      const file = await readDenDriveFile(env, agentName, drivePath);
      if (!file) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
      return Response.json({ ok: true, path: drivePath, content: file.content, meta: file.meta });
    }
    if (request.method === "PUT") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON." }, { status: 400 });
      }
      const content =
        typeof body === "object" && body !== null && typeof (body as { content?: unknown }).content === "string"
          ? (body as { content: string }).content
          : null;
      if (content === null) return Response.json({ error: "content string required." }, { status: 400 });
      const meta = await writeDenDriveFile(env, agentName, drivePath, content);
      return Response.json({ ok: true, path: drivePath, meta });
    }
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }

  if (segments[1] === "subagents" && segments.length === 2 && request.method === "POST") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON." }, { status: 400 });
    }
    const internal = new Request("https://internal/api/runs/subagents/spawn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await signInternalRequest(internal, env);
    const response = await stub.fetch(internal);
    const out = new Response(response.body, response);
    out.headers.set("cache-control", "no-store");
    return out;
  }

  return Response.json({ error: "Not found." }, { status: 404 });
}

/** @deprecated Use {@link handleDenRoutes}. */
export const handleCaptainRoutes = handleDenRoutes;

export function isDenAgentName(agentName: string): boolean {
  return parseDenAgentName(agentName) !== null;
}

/** @deprecated Use {@link isDenAgentName}. */
export const isCaptainAgentName = isDenAgentName;
