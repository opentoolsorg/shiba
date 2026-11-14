import type { GovernanceResourceKind, ShareLinkSummary } from "@shiba/shared";
import { COLLAB_TENANT_ID } from "../collaboration-store.js";
import type { Env } from "../env.js";
import { randomHex } from "../mailbox-store.js";
import { getTeamWorkspaceMembership } from "../team-workspaces-store.js";
import { canAccess } from "./resource-access.js";
import {
  GovernanceError,
  getWorkspaceSharingPolicy,
  hashOpaqueToken,
  newShareLinkId,
} from "./governance-store.js";

type StoreEnv = Pick<Env, "AGENT_AUDIT">;

const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function mintShareToken(): string {
  return randomHex(32);
}

export async function createShareLink(
  env: StoreEnv,
  workspaceId: string,
  userId: string,
  input: { resourceKind: GovernanceResourceKind; resourceId: string; ttlSeconds?: number },
  now = Date.now(),
): Promise<{ token: string; summary: ShareLinkSummary; urlPath: string }> {
  if (!/^ws_[a-f0-9]{24}$/.test(workspaceId))
    throw new GovernanceError("Workspace not found.", 404);
  const membership = await getTeamWorkspaceMembership(env, workspaceId, userId);
  if (!membership) throw new GovernanceError("Workspace not found.", 404);
  const access = await canAccess(env, {
    actor: { workspaceId, userId },
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    access: "view",
  });
  if (!access.allowed) throw new GovernanceError("Resource not found.", 404);
  const policy = await getWorkspaceSharingPolicy(env, workspaceId, userId);
  if (!policy.publicLinksAllowed)
    throw new GovernanceError("Public share links are disabled for this workspace.", 403);
  const ttl = Math.min(Math.max(input.ttlSeconds ?? SHARE_TTL_MS / 1000, 60), SHARE_TTL_MS / 1000);
  const token = mintShareToken();
  const tokenHash = await hashOpaqueToken(token);
  const linkId = newShareLinkId();
  const expiresAt = now + ttl * 1000;
  const result = await env
    .AGENT_AUDIT!.prepare(
      `INSERT INTO share_links(tenant_id,workspace_id,link_id,token_hash,resource_kind,resource_id,created_by,created_at,expires_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      COLLAB_TENANT_ID,
      workspaceId,
      linkId,
      tokenHash,
      input.resourceKind,
      input.resourceId,
      userId,
      now,
      expiresAt,
    )
    .run();
  if (Number(result.meta?.changes ?? 0) !== 1)
    throw new GovernanceError("Share link could not be created.", 409);
  const summary: ShareLinkSummary = {
    linkId,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    createdAt: now,
    expiresAt,
    revokedAt: null,
  };
  const pathPrefix = input.resourceKind === "file" ? "f" : "c";
  return { token, summary, urlPath: `/share/${pathPrefix}/${token}` };
}

interface ShareRow {
  linkId: string;
  workspaceId: string;
  resourceKind: GovernanceResourceKind;
  resourceId: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

export async function resolveShareLinkByToken(
  env: StoreEnv,
  token: string,
  now = Date.now(),
): Promise<ShareRow | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = await hashOpaqueToken(token);
  const row = await env
    .AGENT_AUDIT!.prepare(
      `SELECT link_id AS linkId, workspace_id AS workspaceId, resource_kind AS resourceKind, resource_id AS resourceId,
            created_by AS createdBy, created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt
     FROM share_links WHERE tenant_id=? AND token_hash=? LIMIT 1`,
    )
    .bind(COLLAB_TENANT_ID, tokenHash)
    .first<ShareRow>();
  if (!row || row.revokedAt !== null) return null;
  if (row.expiresAt !== null && row.expiresAt <= now) return null;
  const access = await canAccess(env, {
    actor: { workspaceId: row.workspaceId, userId: row.createdBy },
    resourceKind: row.resourceKind,
    resourceId: row.resourceId,
    access: "view",
  });
  if (!access.allowed) return null;
  return row;
}

export async function revokeShareLink(
  env: StoreEnv,
  workspaceId: string,
  userId: string,
  linkId: string,
  now = Date.now(),
): Promise<void> {
  const membership = await getTeamWorkspaceMembership(env, workspaceId, userId);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    throw new GovernanceError("Workspace admin required.", 403);
  }
  const result = await env
    .AGENT_AUDIT!.prepare(
      `UPDATE share_links SET revoked_at=? WHERE tenant_id=? AND workspace_id=? AND link_id=? AND revoked_at IS NULL`,
    )
    .bind(now, COLLAB_TENANT_ID, workspaceId, linkId)
    .run();
  if (Number(result.meta?.changes ?? 0) !== 1)
    throw new GovernanceError("Share link not found.", 404);
}
