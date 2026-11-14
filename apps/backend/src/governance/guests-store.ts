import { COLLAB_TENANT_ID } from "../collaboration-store.js";
import type { Env } from "../env.js";
import { randomHex } from "../mailbox-store.js";
import { enqueue } from "../platform/queues.js";
import {
  getTeamWorkspaceMembership,
  normalizeTeamWorkspaceEmail,
} from "../team-workspaces-store.js";
import {
  GovernanceError,
  getWorkspaceSharingPolicy,
  hashOpaqueToken,
  newGuestId,
  upsertResourceGrant,
} from "./governance-store.js";

type StoreEnv = Pick<Env, "AGENT_AUDIT" | "EMAIL_QUEUE">;

export async function inviteWorkspaceGuest(
  env: StoreEnv,
  workspaceId: string,
  actorId: string,
  input: {
    email: unknown;
    resourceKind: unknown;
    resourceId: unknown;
    access: unknown;
    ttlMs?: number;
  },
  now = Date.now(),
): Promise<{ guestId: string; token: string }> {
  if (!/^ws_[a-f0-9]{24}$/.test(workspaceId))
    throw new GovernanceError("Workspace not found.", 404);
  const membership = await getTeamWorkspaceMembership(env, workspaceId, actorId);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    throw new GovernanceError("Workspace admin required.", 403);
  }
  const policy = await getWorkspaceSharingPolicy(env, workspaceId, actorId);
  if (!policy.guestInvitesAllowed)
    throw new GovernanceError("Guest invites are disabled for this workspace.", 403);
  const email = normalizeTeamWorkspaceEmail(input.email);
  const guestId = newGuestId();
  const token = randomHex(32);
  const tokenHash = await hashOpaqueToken(token);
  const expiresAt = input.ttlMs ? now + input.ttlMs : null;
  await env
    .AGENT_AUDIT!.prepare(
      `INSERT INTO workspace_guests(tenant_id,workspace_id,guest_id,email,invited_by,token_hash,expires_at,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    )
    .bind(COLLAB_TENANT_ID, workspaceId, guestId, email, actorId, tokenHash, expiresAt, now)
    .run();
  await upsertResourceGrant(
    env,
    workspaceId,
    actorId,
    {
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      principalKind: "guest",
      principalId: guestId,
      access: input.access,
    },
    now,
  );
  // WS02's EMAIL_QUEUE consumer sends the invitation. Missing binding is not a failure.
  if (env.EMAIL_QUEUE) {
    await enqueue(
      "EMAIL_QUEUE",
      {
        template: "workspace_guest_invite",
        workspaceId,
        guestId,
        email,
        invitedBy: actorId,
      },
      env as Env,
    ).catch(() => {});
  }
  return { guestId, token };
}

export async function acceptGuestToken(
  env: StoreEnv,
  token: string,
  now = Date.now(),
): Promise<{ guestId: string; workspaceId: string; email: string } | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = await hashOpaqueToken(token);
  const row = await env
    .AGENT_AUDIT!.prepare(
      `SELECT guest_id AS guestId, workspace_id AS workspaceId, email, expires_at AS expiresAt, revoked_at AS revokedAt
     FROM workspace_guests WHERE tenant_id=? AND token_hash=? LIMIT 1`,
    )
    .bind(COLLAB_TENANT_ID, tokenHash)
    .first<{
      guestId: string;
      workspaceId: string;
      email: string;
      expiresAt: number | null;
      revokedAt: number | null;
    }>();
  if (!row || row.revokedAt !== null) return null;
  if (row.expiresAt !== null && row.expiresAt <= now) return null;
  await env
    .AGENT_AUDIT!.prepare(
      `UPDATE workspace_guests SET accepted_at=? WHERE tenant_id=? AND guest_id=? AND accepted_at IS NULL`,
    )
    .bind(now, COLLAB_TENANT_ID, row.guestId)
    .run();
  return row;
}
