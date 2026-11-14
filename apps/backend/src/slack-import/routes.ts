import { CollaborationStoreError } from "../collaboration-store.js";
import { CollabV2StoreError } from "../collaboration-v2-store.js";
import type { Env } from "../env.js";
import { isAuthorizedRequest, resolveUserId } from "../request-auth.js";
import { resolveTeamCollaborationScope } from "../team-collaboration-scope.js";
import {
  cancelSlackImportJob,
  createSlackImportJob,
  getSlackImportJob,
  SlackImportStoreError,
} from "./store.js";

const PREFIX = "/api/slack-import";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

export async function handleSlackImport(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
  if (!(await isAuthorizedRequest(request, env))) return json({ error: "Authentication required." }, 401);
  if (!env.AGENT_AUDIT) return json({ error: "Slack import storage is unavailable." }, 503);
  const userId = await resolveUserId(request, env);
  if (!userId?.trim()) return json({ error: "Authenticated user required." }, 401);
  let scope;
  try {
    scope = await resolveTeamCollaborationScope(request, env);
  } catch {
    return json({ error: "Workspace scope is unavailable." }, 503);
  }
  if (!scope) return json({ error: "Workspace not found." }, 404);
  if (
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    (request.headers.get("origin") !== url.origin ||
      request.headers.get("sec-fetch-site") === "cross-site")
  ) {
    return json({ error: "Same-origin request required." }, 403);
  }

  const path = url.pathname.slice(PREFIX.length).split("/").filter(Boolean);
  try {
    if (path.length === 0 && request.method === "POST") {
      const body = await request.json().catch(() => null) as Record<string, unknown> | null;
      if (!body) return json({ error: "JSON body required." }, 400);
      const roomId = typeof body.roomId === "string" ? body.roomId : "";
      const slackTeamId = typeof body.slackTeamId === "string" ? body.slackTeamId : "";
      const slackChannelId = typeof body.slackChannelId === "string" ? body.slackChannelId : "";
      if (!roomId || !slackTeamId || !slackChannelId) {
        return json({ error: "roomId, slackTeamId and slackChannelId are required." }, 400);
      }
      const job = await createSlackImportJob(env, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        roomId,
        slackTeamId,
        slackChannelId,
        requestedByUserId: scope.userId,
        createdAt: Date.now(),
      });
      if (env.SLACK_IMPORT_WORKFLOW?.create) {
        const instance = await env.SLACK_IMPORT_WORKFLOW.create({
          id: `slack-import-${job.jobId}`,
          params: { jobId: job.jobId, tenantId: scope.tenantId, workspaceId: scope.workspaceId },
        });
        await env.AGENT_AUDIT.prepare(
          "UPDATE slack_import_jobs SET workflow_instance_id=?, updated_at=? WHERE tenant_id=? AND workspace_id=? AND job_id=?",
        )
          .bind(instance.id, Date.now(), scope.tenantId, scope.workspaceId, job.jobId)
          .run();
        const refreshed = await getSlackImportJob(env, scope.tenantId, scope.workspaceId, job.jobId);
        return json({ job: refreshed ?? job }, 201);
      }
      return json({ job }, 201);
    }
    if (path.length === 1 && request.method === "GET") {
      const job = await getSlackImportJob(env, scope.tenantId, scope.workspaceId, path[0]!);
      if (!job) return json({ error: "Import job not found." }, 404);
      return json({ job });
    }
    if (path.length === 2 && path[1] === "cancel" && request.method === "POST") {
      const cancelled = await cancelSlackImportJob(env, scope.tenantId, scope.workspaceId, path[0]!, Date.now());
      if (!cancelled) return json({ error: "Import job cannot be cancelled." }, 409);
      const job = await getSlackImportJob(env, scope.tenantId, scope.workspaceId, path[0]!);
      return json({ job });
    }
    return json({ error: "Slack import route not found." }, 404);
  } catch (error) {
    if (error instanceof SlackImportStoreError || error instanceof CollabV2StoreError) {
      return json({ error: error.message }, error.status);
    }
    if (error instanceof CollaborationStoreError) return json({ error: error.message }, error.status);
    console.error("slack import route failed", error instanceof Error ? error.message : String(error));
    return json({ error: "Slack import operation failed." }, 503);
  }
}