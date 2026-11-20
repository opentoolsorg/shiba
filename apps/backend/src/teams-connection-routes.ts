import { teamsGeneration, teamsSettings, teamsSettingsKey } from "./channels/teams/connection.js";
import { requestTeamsToken } from "./channels/teams/index.js";
import { COLLAB_TENANT_ID } from "./collaboration-store.js";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "./dashboard-mutation.js";
import type { Env } from "./env.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { parseApproverAllowlist } from "./slack-approval.js";
import { nativeWorkspaceAccountSql, resolveWorkspaceNativeMember } from "./workspace-native-authority.js";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function handleTeamsConnection(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (request.method === "POST") {
    const denied = rejectCrossOriginMutation(request) ?? rejectNonJsonMutation(request);
    if (denied) return denied;
  }
  const auth = await resolveOrgForApiRequest(request, env);
  if (auth instanceof Response) return auth;
  if (auth.principal || auth.workspace?.role !== "owner") return json({ error: "A native workspace owner is required." }, 403);
  const member = await resolveWorkspaceNativeMember(request, env, auth.workspace);
  if (!member) return json({ error: "A native workspace owner is required." }, 403);

  const settings = teamsSettings(env);
  if (!settings || member.workspaceId !== settings.workspaceId) {
    const error = "The deployment operator hasn't configured a Teams bot for this workspace.";
    return request.method === "GET" ? json({ status: "not_configured", installed: false, error }) : json({ error }, 409);
  }

  try {
    const installed = Boolean(await env.AGENT_AUDIT.prepare(`SELECT 1 FROM teams_installations
      WHERE workspace_id=? AND app_id=? AND tenant_id=? AND installed=1 LIMIT 1`)
      .bind(...teamsSettingsKey(settings)).first());
    if (request.method === "POST") {
      const body = await request.json().catch(() => null) as { action?: unknown } | null;
      if (body?.action !== "connect" && body?.action !== "disconnect") return json({ error: "Choose connect or disconnect." }, 400);
      if (body.action === "connect") {
        if (!parseApproverAllowlist(env.TEAMS_APPROVERS).length) return json({ error: "Configure TEAMS_APPROVERS before connecting." }, 409);
        try {
          await requestTeamsToken(settings);
        } catch {
          return json({ error: "Microsoft couldn't issue a bot token. Check the Entra app ID, tenant ID and client secret, then retry." }, 502);
        }
      }
      const guard = nativeWorkspaceAccountSql(member);
      const result = await env.AGENT_AUDIT.prepare(`INSERT INTO teams_connections (workspace_id, app_id, tenant_id, generation)
        SELECT ?,?,?,? WHERE ${guard.sql} AND EXISTS (
          SELECT 1 FROM team_workspace_memberships WHERE tenant_id=? AND workspace_id=? AND user_id=?
            AND role='owner' AND status='active' AND version=?
        ) ON CONFLICT(workspace_id,app_id,tenant_id) DO UPDATE SET generation=
          CASE WHEN excluded.generation IS NULL THEN NULL ELSE coalesce(teams_connections.generation, excluded.generation) END`)
        .bind(...teamsSettingsKey(settings), body.action === "connect" ? crypto.randomUUID() : null,
          ...guard.values, COLLAB_TENANT_ID, member.workspaceId, member.userId, member.version).run();
      if (result.meta.changes !== 1) return json({ error: "Workspace owner authority changed. Refresh and try again." }, 403);
    }
    const connected = Boolean(await teamsGeneration(env, settings));
    return json({ status: connected ? "connected" : "disconnected", installed });
  } catch {
    return json({ status: "error", installed: false, error: "Teams connection storage is unavailable. Try again." }, request.method === "GET" ? 200 : 503);
  }
}
