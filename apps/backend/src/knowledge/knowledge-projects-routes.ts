import type { Env } from "../env.js";
import { getFile } from "../files/files-store.js";
import { getNote } from "../notes/notes-store.js";
import { resolveOrgForApiRequest } from "../org-request-auth.js";
import { requireSameOriginBrowserMutation, resolveRequestIdentity } from "../request-auth.js";
import { assertKnowledgeRead, KnowledgeAccessError } from "./knowledge-access.js";
import {
  assignProjectResource,
  createProject,
  deleteProject,
  getProject,
  listProjectResources,
  listProjects,
  ProjectStoreError,
  renameProject,
} from "./knowledge-projects.js";

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

function storeError(error: unknown): Response | null {
  if (error instanceof ProjectStoreError || error instanceof KnowledgeAccessError) {
    return json({ error: error.message }, error.status);
  }
  return null;
}

export async function handleKnowledgeProjects(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/projects")) return null;
  if (!env.AGENT_AUDIT) return json({ error: "Project storage is unavailable." }, 503);
  const { userId, authorized } = await resolveRequestIdentity(request, env);
  if (!authorized) return json({ error: "Authentication required." }, 401);
  if (!userId) return json({ error: "Authentication required." }, 401);
  const org = await resolveOrgForApiRequest(request, env, { allowMemberWrite: true });
  if (org instanceof Response) return org;
  const workspaceId = org.workspace?.workspaceId ?? org.orgId.replace(/^team:/, "");

  if (url.pathname === "/api/projects") {
    if (request.method === "GET")
      return json({ projects: await listProjects(env, workspaceId, userId) });
    if (request.method === "POST") {
      const blocked = requireSameOriginBrowserMutation(request);
      if (blocked) return blocked;
      const body = (await request.json().catch(() => null)) as { name?: string } | null;
      try {
        const project = await createProject(env, workspaceId, body?.name ?? "");
        return json({ project }, 201);
      } catch (error) {
        return storeError(error) ?? json({ error: "Could not create project." }, 400);
      }
    }
    return json({ error: "Method not allowed." }, 405);
  }

  const match = /^\/api\/projects\/([^/]+)(\/membership)?$/.exec(url.pathname);
  if (!match) return json({ error: "Not found." }, 404);
  const rawProjectId = match[1];
  if (!rawProjectId) return json({ error: "Not found." }, 404);
  const projectId = decodeURIComponent(rawProjectId);
  const project = await getProject(env, workspaceId, projectId);
  if (!project) return json({ error: "Project not found." }, 404);

  if (match[2] === "/membership") {
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
    const blocked = requireSameOriginBrowserMutation(request);
    if (blocked) return blocked;
    const body = (await request.json().catch(() => null)) as {
      resourceKind?: "file" | "note";
      resourceId?: string;
      assign?: boolean;
    } | null;
    if ((body?.resourceKind !== "file" && body?.resourceKind !== "note") || !body.resourceId) {
      return json({ error: "Choose a file or note to add to the project." }, 400);
    }
    try {
      if (body.resourceKind === "file") {
        const file = await getFile(env, body.resourceId);
        if (!file || file.workspaceId !== workspaceId || file.archivedAt)
          return json({ error: "File not found." }, 404);
        await assertKnowledgeRead(env, userId, {
          workspaceId: file.workspaceId,
          scope: file.scope,
          createdBy: file.createdBy,
          resourceId: file.id,
          resourceKind: "file",
        });
      } else {
        const note = await getNote(env, body.resourceId);
        if (!note || note.workspaceId !== workspaceId || note.archivedAt)
          return json({ error: "Note not found." }, 404);
        await assertKnowledgeRead(env, userId, {
          workspaceId: note.workspaceId,
          scope: note.scope,
          createdBy: note.createdBy,
          resourceId: note.id,
          resourceKind: "note",
        });
      }
      const changed = await assignProjectResource(env, {
        workspaceId,
        resourceKind: body.resourceKind,
        resourceId: body.resourceId,
        projectId: body.assign === false ? null : projectId,
      });
      if (!changed) return json({ error: "Resource not found." }, 404);
      const detail = await listProjectResources(env, workspaceId, userId, projectId);
      return json({ project, ...detail });
    } catch (error) {
      const response = storeError(error);
      if (response) return response;
      throw error;
    }
  }

  if (request.method === "GET") {
    const detail = await listProjectResources(env, workspaceId, userId, projectId);
    return json({ project, ...detail });
  }
  if (request.method === "PATCH") {
    const blocked = requireSameOriginBrowserMutation(request);
    if (blocked) return blocked;
    const body = (await request.json().catch(() => null)) as { name?: string } | null;
    try {
      return json({ project: await renameProject(env, workspaceId, projectId, body?.name ?? "") });
    } catch (error) {
      return storeError(error) ?? json({ error: "Could not rename project." }, 400);
    }
  }
  if (request.method === "DELETE") {
    const blocked = requireSameOriginBrowserMutation(request);
    if (blocked) return blocked;
    return json({ deleted: await deleteProject(env, workspaceId, projectId) });
  }
  return json({ error: "Method not allowed." }, 405);
}
