import type { Env } from "../env.js";
import { isAuthorizedRequest, requireSameOriginBrowserMutation, resolveUserId } from "../request-auth.js";
import { resolveOrgForApiRequest } from "../org-request-auth.js";
import { createProject, listProjects } from "./knowledge-projects.js";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: {
  "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
} });

export async function handleKnowledgeProjects(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/projects") return null;
  if (!env.AGENT_AUDIT) return json({ error: "Project storage is unavailable." }, 503);
  if (!(await isAuthorizedRequest(request, env))) return json({ error: "Authentication required." }, 401);
  const userId = await resolveUserId(request, env);
  if (!userId) return json({ error: "Authentication required." }, 401);
  const org = await resolveOrgForApiRequest(request, env);
  if (org instanceof Response) return org;
  const workspaceId = org.workspace?.workspaceId ?? org.orgId.replace(/^team:/, "");
  if (request.method === "GET") return json({ projects: await listProjects(env, workspaceId) });
  if (request.method === "POST") {
    const blocked = requireSameOriginBrowserMutation(request);
    if (blocked) return blocked;
    const body = await request.json().catch(() => null) as { name?: string } | null;
    try {
      const project = await createProject(env, workspaceId, body?.name ?? "");
      return json({ project }, 201);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Could not create project." }, 400);
    }
  }
  return json({ error: "Method not allowed." }, 405);
}
