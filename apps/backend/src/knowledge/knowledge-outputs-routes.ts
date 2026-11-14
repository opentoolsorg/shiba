/**
 * Outputs gallery: run deliverables and generated media (`kind=output` in FILES).
 */
import type { Env } from "../env.js";
import { isAuthorizedRequest, resolveUserId } from "../request-auth.js";
import { resolveOrgForApiRequest } from "../org-request-auth.js";
import { filesBucket } from "./knowledge-ingestion.js";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: {
  "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
} });

export interface OutputItem {
  id: string;
  kind: "run-deliverable" | "output";
  title: string;
  mime: string;
  bytes?: number;
  downloadPath: string;
  createdAt: number;
}

export async function handleKnowledgeOutputs(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/outputs")) return null;
  if (!(await isAuthorizedRequest(request, env))) return json({ error: "Authentication required." }, 401);
  const userId = await resolveUserId(request, env);
  if (!userId) return json({ error: "Authentication required." }, 401);
  const org = await resolveOrgForApiRequest(request, env);
  if (org instanceof Response) return org;
  const workspaceId = org.workspace?.workspaceId ?? org.orgId.replace(/^team:/, "");

  if (url.pathname === "/api/outputs" && request.method === "GET") {
    const type = url.searchParams.get("type");
    const items: OutputItem[] = [];
    if (env.AGENT_AUDIT) {
      const archives = await env.AGENT_AUDIT.prepare(
        `SELECT id, run_id, created_at FROM run_output_archive_reservations
         WHERE owner_id=? AND state='reserved' AND expires_at>? ORDER BY created_at DESC LIMIT 20`,
      ).bind(userId, Date.now()).all<{ id: string; run_id: string; created_at: number }>();
      for (const row of archives.results) {
        if (type && type !== "archive") continue;
        items.push({
          id: row.id,
          kind: "run-deliverable",
          title: `Run ${row.run_id}`,
          mime: "application/zip",
          downloadPath: `/api/run-output-archives/${row.id}`,
          createdAt: row.created_at,
        });
      }
    }
    if (env.AGENT_AUDIT && (!type || type === "output")) {
      const files = await env.AGENT_AUDIT.prepare(
        `SELECT id, name, mime, size, updated_at FROM files
         WHERE workspace_id=? AND archived_at IS NULL AND mime LIKE 'image/%' ORDER BY updated_at DESC LIMIT 40`,
      ).bind(workspaceId).all<{ id: string; name: string; mime: string; size: number; updated_at: number }>();
      for (const row of files.results) {
        items.push({
          id: row.id,
          kind: "output",
          title: row.name,
          mime: row.mime,
          bytes: row.size,
          downloadPath: `/api/files/${row.id}/download`,
          createdAt: row.updated_at,
        });
      }
    }
    return json({ items });
  }

  const downloadMatch = /^\/api\/outputs\/([^/]+)\/download$/.exec(url.pathname);
  if (downloadMatch && request.method === "GET") {
    const key = `outputs/${workspaceId}/${downloadMatch[1]}`;
    const object = await filesBucket(env).get(key);
    if (!object) return json({ error: "Output not found." }, 404);
    return new Response(object.body, { headers: { "Cache-Control": "private, no-store" } });
  }

  return json({ error: "Method not allowed." }, 405);
}