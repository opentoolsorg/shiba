import { isTeamWorkspaceId } from "@shiba/shared";
import {
  COLLAB_TENANT_ID,
  COLLAB_WORKSPACE_ID,
  type CollaborationScope,
} from "./collaboration-store.js";
import type { Env } from "./env.js";
import { canAccess } from "./governance/resource-access.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import { isTeamWorkspaceMember } from "./team-workspaces-store.js";

/** Select a workspace only after authenticating its current human member. */
export async function resolveTeamCollaborationScope(
  request: Request,
  env: Env,
): Promise<CollaborationScope | null> {
  if (!(await isAuthorizedRequest(request, env))) return null;
  const userId = (await resolveUserId(request, env))?.trim().toLowerCase();
  // No default owner, principal header or invitation token can mint an identity.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Rejects control bytes in untrusted identity or portable text input.
  if (!userId || userId.length > 320 || /[\x00-\x20\x7f]/.test(userId)) return null;
  const values = new URL(request.url).searchParams.getAll("workspaceId");
  if (values.length > 1) return null;
  const header = request.headers.get("X-Shiba-Workspace");
  const query = values[0];
  if (header !== null && query !== undefined && header !== query) return null;
  const workspaceId = header ?? query ?? COLLAB_WORKSPACE_ID;
  if (workspaceId !== COLLAB_WORKSPACE_ID && !isTeamWorkspaceId(workspaceId)) return null;
  if (
    workspaceId !== COLLAB_WORKSPACE_ID &&
    (!env.AGENT_AUDIT || !(await isTeamWorkspaceMember(env, workspaceId, userId)))
  )
    return null;
  return { tenantId: COLLAB_TENANT_ID, workspaceId, userId };
}

/** Published hook for WS05/WS07/WS08 resource gates. */
export async function workspaceResourceCanAccess(
  env: Env,
  workspaceId: string,
  userId: string,
  resourceKind: "room" | "file" | "note" | "task" | "chat",
  resourceId: string,
  access: "view" | "comment" | "edit" | "manage",
): Promise<boolean> {
  const result = await canAccess(env, {
    actor: { workspaceId, userId },
    resourceKind,
    resourceId,
    access,
  });
  return result.allowed;
}
