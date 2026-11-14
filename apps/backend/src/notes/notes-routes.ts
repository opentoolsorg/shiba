import type { KnowledgeScope } from "@shiba/shared";
import type { Env } from "../env.js";
import { isAuthorizedRequest, requireSameOriginBrowserMutation, resolveUserId } from "../request-auth.js";
import { resolveOrgForApiRequest } from "../org-request-auth.js";
import { assertKnowledgeRead, KnowledgeAccessError } from "../knowledge/knowledge-access.js";
import { enqueueIngestion } from "../knowledge/knowledge-ingestion.js";
import { filesBucket } from "../knowledge/knowledge-ingestion.js";
import { createNote, getNote, listNotes, NotesConflictError, NotesStoreError, updateNoteMarkdown } from "./notes-store.js";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: {
  "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
} });

export async function handleNotes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/notes")) return null;
  if (!env.AGENT_AUDIT) return json({ error: "Knowledge storage is unavailable." }, 503);
  if (!(await isAuthorizedRequest(request, env))) return json({ error: "Authentication required." }, 401);
  const userId = await resolveUserId(request, env);
  if (!userId) return json({ error: "Authentication required." }, 401);
  const org = await resolveOrgForApiRequest(request, env);
  if (org instanceof Response) return org;
  const workspaceId = org.workspace?.workspaceId ?? org.orgId.replace(/^team:/, "");
  const scope: KnowledgeScope = url.searchParams.get("scope") === "workspace" ? "workspace" : "personal";

  if (url.pathname === "/api/notes") {
    if (request.method === "GET") return json({ notes: await listNotes(env, workspaceId, scope, userId) });
    if (request.method === "POST") {
      const blocked = requireSameOriginBrowserMutation(request);
      if (blocked) return blocked;
      const body = await request.json().catch(() => null) as { title?: string; markdown?: string; projectId?: string | null } | null;
      try {
        const note = await createNote(env, {
          workspaceId, scope, title: body?.title ?? "Untitled", markdown: body?.markdown ?? "", createdBy: userId,
          projectId: body?.projectId ?? null,
        });
        const jobId = await enqueueIngestion(env, {
          sourceKind: "note", sourceId: note.id, workspaceId, scope, sha256: note.sha256, version: note.version,
          r2Key: note.r2Key, mime: "text/markdown",
        });
        return json({ note, jobId }, 201);
      } catch (error) {
        if (error instanceof NotesStoreError) return json({ error: error.message }, error.status);
        throw error;
      }
    }
    return json({ error: "Method not allowed." }, 405);
  }

  const match = /^\/api\/notes\/([^/]+)(\/body)?$/.exec(url.pathname);
  if (!match) return json({ error: "Not found." }, 404);
  const noteId = match[1]!;
  const note = await getNote(env, noteId);
  if (!note || note.workspaceId !== workspaceId) return json({ error: "Note not found." }, 404);
  try {
    await assertKnowledgeRead(env, userId, {
      workspaceId: note.workspaceId, scope: note.scope, createdBy: note.createdBy, resourceId: note.id, resourceKind: "note",
    });
  } catch (error) {
    if (error instanceof KnowledgeAccessError) return json({ error: error.message }, error.status);
    throw error;
  }

  if (match[2] === "/body" && request.method === "GET") {
    const object = await filesBucket(env).get(note.r2Key);
    if (!object) return json({ error: "Note body missing." }, 404);
    return new Response(object.body, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "private, no-store" } });
  }

  if (!match[2] && request.method === "GET") return json({ note });

  if (!match[2] && request.method === "PATCH") {
    const blocked = requireSameOriginBrowserMutation(request);
    if (blocked) return blocked;
    const body = await request.json().catch(() => null) as {
      markdown?: string; title?: string; expectedVersion?: number;
    } | null;
    try {
      const updated = await updateNoteMarkdown(env, noteId, {
        markdown: body?.markdown ?? "",
        expectedVersion: Number(body?.expectedVersion),
        title: body?.title,
      });
      const jobId = await enqueueIngestion(env, {
        sourceKind: "note", sourceId: updated.id, workspaceId, scope: updated.scope,
        sha256: updated.sha256, version: updated.version, r2Key: updated.r2Key, mime: "text/markdown",
      });
      return json({ note: updated, jobId });
    } catch (error) {
      if (error instanceof NotesConflictError) return json({ error: error.message }, 409);
      if (error instanceof NotesStoreError) return json({ error: error.message }, error.status);
      throw error;
    }
  }

  return json({ error: "Method not allowed." }, 405);
}