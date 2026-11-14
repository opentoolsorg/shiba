import type { Env } from "../env.js";
import { isAuthorizedRequest, resolveUserId } from "../request-auth.js";
import { resolveOrgForApiRequest } from "../org-request-auth.js";
import { hybridKnowledgeSearch } from "./knowledge-search.js";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: {
  "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
} });

export async function handleKnowledge(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/knowledge/search") return null;
  if (!env.AGENT_AUDIT || !env.MEMORY_VECTORS) return json({ error: "Knowledge search is unavailable." }, 503);
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
  if (!(await isAuthorizedRequest(request, env))) return json({ error: "Authentication required." }, 401);
  const userId = await resolveUserId(request, env);
  if (!userId) return json({ error: "Authentication required." }, 401);
  const org = await resolveOrgForApiRequest(request, env);
  if (org instanceof Response) return org;
  const workspaceId = org.workspace?.workspaceId ?? org.orgId.replace(/^team:/, "");
  const query = url.searchParams.get("q") ?? "";
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? 10 : Number(limitRaw);
  if (!query.trim()) return json({ error: "q is required." }, 400);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) return json({ error: "limit must be 1–20." }, 400);
  const hits = await hybridKnowledgeSearch(env, userId, workspaceId, query, limit);
  return json({ query, hits });
}