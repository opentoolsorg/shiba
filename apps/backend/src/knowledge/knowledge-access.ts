/**
 * Access checks for knowledge-scoped resources (files, notes, search).
 * Uses WS06 `canAccess` when `governance/resource-access` is deployed; otherwise owner/member fallback.
 */
import { type GovernanceAccessLevel, isTeamWorkspaceId, type GovernanceResourceKind, type KnowledgeScope } from "@shiba/shared";
import type { Env } from "../env.js";
import { getTeamWorkspaceMembership } from "../team-workspaces-store.js";

export interface KnowledgeResourceAccess {
  workspaceId: string;
  scope: KnowledgeScope;
  createdBy: string;
  resourceId: string;
  resourceKind: GovernanceResourceKind;
}

export async function canAccessKnowledgeResource(
  env: Env,
  viewerUserId: string,
  resource: KnowledgeResourceAccess,
): Promise<boolean> {
  if (resource.scope === "personal") {
    return viewerUserId.trim().toLowerCase() === resource.createdBy.trim().toLowerCase();
  }
  const governance = await governanceCanAccess(env, viewerUserId, resource);
  if (governance) return true;
  // Outside team workspaces, `workspace` scope is the deployment-wide shared scope.
  if (!isTeamWorkspaceId(resource.workspaceId)) return true;
  const membership = await getTeamWorkspaceMembership(env, resource.workspaceId, viewerUserId);
  return membership?.role === "owner" || membership?.role === "admin" || membership?.role === "member";
}

async function governanceCanAccess(
  env: Env,
  viewerUserId: string,
  resource: KnowledgeResourceAccess,
  access: GovernanceAccessLevel = "view",
): Promise<boolean | null> {
  const { canAccess } = await import("../governance/resource-access.js");
  const membership = await getTeamWorkspaceMembership(env, resource.workspaceId, viewerUserId);
  const result = await canAccess(env, {
    actor: {
      workspaceId: resource.workspaceId,
      userId: viewerUserId.trim().toLowerCase(),
      membershipRole: membership?.role,
      membershipVersion: membership?.version,
    },
    resourceKind: resource.resourceKind,
    resourceId: resource.resourceId,
    access,
  });
  return result.allowed;
}


function sameUser(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * Write authority is narrower than read authority. Members may edit their own
 * shared contributions, while other people's shared resources require an edit
 * grant or a workspace owner/admin role. Personal resources remain creator-only.
 */
export async function canWriteKnowledgeResource(
  env: Env,
  viewerUserId: string,
  resource: KnowledgeResourceAccess,
): Promise<boolean> {
  if (resource.scope === "personal") return sameUser(viewerUserId, resource.createdBy);
  if (!isTeamWorkspaceId(resource.workspaceId)) return true;
  const governance = await governanceCanAccess(env, viewerUserId, resource, "edit");
  if (governance) return true;
  const membership = await getTeamWorkspaceMembership(env, resource.workspaceId, viewerUserId);
  if (membership?.role === "owner" || membership?.role === "admin") return true;
  return membership?.role === "member" && sameUser(viewerUserId, resource.createdBy);
}

export async function assertKnowledgeWrite(
  env: Env,
  viewerUserId: string,
  resource: KnowledgeResourceAccess,
): Promise<void> {
  if (!(await canWriteKnowledgeResource(env, viewerUserId, resource))) {
    throw new KnowledgeAccessError("You do not have permission to edit this resource.", 403);
  }
}

export async function assertKnowledgeRead(
  env: Env,
  viewerUserId: string,
  resource: KnowledgeResourceAccess,
): Promise<void> {
  if (!(await canAccessKnowledgeResource(env, viewerUserId, resource))) {
    throw new KnowledgeAccessError("Resource not found.", 404);
  }
}

export class KnowledgeAccessError extends Error {
  constructor(message: string, readonly status = 403) {
    super(message);
    this.name = "KnowledgeAccessError";
  }
}