import type { Env } from "./env.js";
import {
  assertAdminOperator,
  breakGlassAuditRead,
  listAdminTableSizes,
  listAdminWorkspaces,
} from "./governance/admin-console.js";
import { listArchivedCenter } from "./governance/archived-center.js";
import {
  createWorkspaceAuditExport,
  streamWorkspaceAuditExport,
} from "./governance/audit-export-store.js";
import {
  addWorkspaceGroupMember,
  createWorkspaceGroup,
  GovernanceError,
  getWorkspaceSharingPolicy,
  listWorkspaceGroups,
  removeWorkspaceGroupMember,
  revokeResourceGrant,
  updateWorkspaceSharingPolicy,
  upsertResourceGrant,
} from "./governance/governance-store.js";
import { inviteWorkspaceGuest } from "./governance/guests-store.js";
import { revokeShareLink } from "./governance/share-links-store.js";
import {
  isAuthorizedRequest,
  requireJsonContentType,
  requireSameOriginBrowserMutation,
  resolveUserId,
} from "./request-auth.js";
import { publishWorkspaceEvent } from "./platform/workspace-events-do.js";
import { normalizeTeamWorkspaceEmail } from "./team-workspaces-store.js";

const PREFIX = "/api/governance";
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new GovernanceError("JSON body required.");
  return value as Record<string, unknown>;
}

export async function handleGovernance(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(PREFIX)) return null;

  if (path === "/api/governance/admin/workspaces" && request.method === "GET") {
    try {
      await assertAdminOperator(request, env);
      const rows = await listAdminWorkspaces(env);
      return json({ workspaces: rows });
    } catch (error) {
      if (error instanceof GovernanceError) return json({ error: error.message }, error.status);
      throw error;
    }
  }
  if (path === "/api/governance/admin/table-sizes" && request.method === "GET") {
    try {
      await assertAdminOperator(request, env);
      const rows = await listAdminTableSizes(env);
      return json({ tables: rows });
    } catch (error) {
      if (error instanceof GovernanceError) return json({ error: error.message }, error.status);
      throw error;
    }
  }
  if (path === "/api/governance/admin/audit" && request.method === "GET") {
    try {
      const payload = await breakGlassAuditRead(env, request);
      return json(payload);
    } catch (error) {
      if (error instanceof GovernanceError) return json({ error: error.message }, error.status);
      throw error;
    }
  }

  if (!(await isAuthorizedRequest(request, env)))
    return json({ error: "Authentication required." }, 401);
  const identity = await resolveUserId(request, env);
  if (!identity) return json({ error: "Authentication required." }, 401);
  let user: string;
  try {
    user = normalizeTeamWorkspaceEmail(identity);
  } catch {
    return json({ error: "Verified email required." }, 403);
  }
  const originError = requireSameOriginBrowserMutation(request);
  if (originError && request.method !== "GET") return originError;

  const workspaceMatch = /^\/api\/governance\/(ws_[a-f0-9]{24})(?:\/(.*))?$/.exec(path);
  if (!workspaceMatch) return json({ error: "Not found." }, 404);
  const workspaceId = workspaceMatch[1]!;
  const rest = workspaceMatch[2] ?? "";

  try {
    if (rest === "groups" && request.method === "GET") {
      return json({ groups: await listWorkspaceGroups(env, workspaceId, user) });
    }
    if (rest === "groups" && request.method === "POST") {
      const contentError = requireJsonContentType(request);
      if (contentError) return contentError;
      const body = await readBody(request);
      const group = await createWorkspaceGroup(env, workspaceId, user, { name: body.name });
      await publishWorkspaceEvent(env, workspaceId, {
        type: "governance.group",
        resourceId: group.groupId,
        version: group.version,
      });
      return json({ group }, 201);
    }
    const groupMemberMatch = /^groups\/([^/]+)\/members(?:\/([^/]+))?$/.exec(rest);
    if (groupMemberMatch?.[2] && request.method === "DELETE") {
      const contentError = requireJsonContentType(request);
      if (contentError) return contentError;
      await removeWorkspaceGroupMember(
        env,
        workspaceId,
        user,
        groupMemberMatch[1]!,
        decodeURIComponent(groupMemberMatch[2]!),
      );
      return json({ removed: true });
    }
    if (groupMemberMatch?.[1] && !groupMemberMatch[2] && request.method === "POST") {
      const contentError = requireJsonContentType(request);
      if (contentError) return contentError;
      const body = await readBody(request);
      if (typeof body.userId !== "string") throw new GovernanceError("userId required.");
      await addWorkspaceGroupMember(env, workspaceId, user, groupMemberMatch[1]!, body.userId);
      return json({ added: true }, 201);
    }
    if (rest === "grants" && request.method === "POST") {
      const contentError = requireJsonContentType(request);
      if (contentError) return contentError;
      const body = await readBody(request);
      const principalKind =
        body.principalKind === "group" ||
        body.principalKind === "guest" ||
        body.principalKind === "user"
          ? body.principalKind
          : (() => {
              throw new GovernanceError("principalKind required.");
            })();
      return json(
        await upsertResourceGrant(env, workspaceId, user, {
          resourceKind: body.resourceKind,
          resourceId: body.resourceId,
          principalKind,
          principalId: body.principalId,
          access: body.access,
        }),
        201,
      );
    }
    const grantRevoke = /^grants\/([^/]+)$/.exec(rest);
    if (grantRevoke && request.method === "DELETE") {
      await revokeResourceGrant(env, workspaceId, user, grantRevoke[1]!);
      return json({ revoked: true });
    }
    if (rest === "policy" && request.method === "GET") {
      return json({ policy: await getWorkspaceSharingPolicy(env, workspaceId, user) });
    }
    if (rest === "policy" && request.method === "PATCH") {
      const contentError = requireJsonContentType(request);
      if (contentError) return contentError;
      const body = await readBody(request);
      return json({
        policy: await updateWorkspaceSharingPolicy(env, workspaceId, user, {
          publicLinksAllowed:
            typeof body.publicLinksAllowed === "boolean" ? body.publicLinksAllowed : undefined,
          guestInvitesAllowed:
            typeof body.guestInvitesAllowed === "boolean" ? body.guestInvitesAllowed : undefined,
          defaultResourceAccess:
            body.defaultResourceAccess === null
              ? null
              : body.defaultResourceAccess === "view" ||
                  body.defaultResourceAccess === "comment" ||
                  body.defaultResourceAccess === "edit" ||
                  body.defaultResourceAccess === "manage"
                ? body.defaultResourceAccess
                : undefined,
          expectedVersion: body.expectedVersion,
        }),
      });
    }
    if (rest === "guests" && request.method === "POST") {
      const contentError = requireJsonContentType(request);
      if (contentError) return contentError;
      const body = await readBody(request);
      return json(
        await inviteWorkspaceGuest(env, workspaceId, user, {
          email: body.email,
          resourceKind: body.resourceKind,
          resourceId: body.resourceId,
          access: body.access,
          ttlMs: typeof body.ttlMs === "number" ? body.ttlMs : undefined,
        }),
        201,
      );
    }
    if (rest === "archived" && request.method === "GET") {
      return json({ items: await listArchivedCenter(env, workspaceId, user) });
    }
    const auditExportDownload = /^audit-export\/([^/]+)\/download$/.exec(rest);
    if (auditExportDownload && request.method === "GET") {
      return await streamWorkspaceAuditExport(env, workspaceId, user, auditExportDownload[1]!);
    }
    if (rest === "audit-export" && request.method === "POST") {
      return json(await createWorkspaceAuditExport(env, workspaceId, user), 201);
    }
    const shareRevoke = /^share-links\/([^/]+)$/.exec(rest);
    if (shareRevoke && request.method === "DELETE") {
      await revokeShareLink(env, workspaceId, user, shareRevoke[1]!);
      return json({ revoked: true });
    }
    return json({ error: "Not found." }, 404);
  } catch (error) {
    if (error instanceof GovernanceError) return json({ error: error.message }, error.status);
    throw error;
  }
}
