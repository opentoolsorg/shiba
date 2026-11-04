import { authorizeCollaborationAction } from "@shiba/shared";
import { COLLAB_TENANT_ID, COLLAB_WORKSPACE_ID, ensureCollaborationSchema, getCollaborationMembership, getCollaborationRoom, isCollaborationSlackRoomAudienceAuthorized, type CollaborationScope } from "./collaboration-store.js";
import type { Env } from "./env.js";

export interface CollaborationRoomIdentity {
  tenantId: string;
  workspaceId: string;
  roomId: string;
}

export function collaborationRoomName(identity: CollaborationRoomIdentity): string {
  return JSON.stringify(["shiba:collaboration:v1", identity.tenantId, identity.workspaceId, identity.roomId]);
}

export function isCollaborationRoomIdentity(identity: CollaborationRoomIdentity): boolean {
  return identity.tenantId === COLLAB_TENANT_ID && identity.workspaceId === COLLAB_WORKSPACE_ID &&
    /^room_[a-f0-9]{24}$/.test(identity.roomId);
}

/** Both the upgrade and each live delivery use current grants, never a viewer nonce. */
export async function canReadCollaborationRoom(env: Env, identity: CollaborationRoomIdentity, userId: string): Promise<boolean> {
  if (!isCollaborationRoomIdentity(identity) || !userId || userId.length > 320 || userId !== userId.trim().toLowerCase()) return false;
  const scope: CollaborationScope = { tenantId: identity.tenantId, workspaceId: identity.workspaceId, userId };
  const room = await getCollaborationRoom(env, scope, identity.roomId);
  if (!room) return false;
  const actor = { kind: "human" as const, actorId: `human:${userId}`, ...scope };
  const membership = await getCollaborationMembership(env, scope, identity.roomId, actor.actorId);
  return authorizeCollaborationAction({ ...scope, actor }, room, membership ?? undefined, "room.read").allowed &&
    await isCollaborationSlackRoomAudienceAuthorized(env, scope, identity.roomId);
}

/** Internal settlement hint. The room rechecks each viewer; no output travels here. */
export async function notifyCollaborationHandoffChange(env: Env, handoffId: string): Promise<void> {
  if (!env.ConversationRoom || !env.AGENT_AUDIT || !/^[A-Za-z0-9_-]{1,100}$/.test(handoffId)) return;
  try {
    await ensureCollaborationSchema(env);
    const row = await env.AGENT_AUDIT.prepare("SELECT room_id AS roomId FROM collaboration_handoffs WHERE tenant_id=? AND workspace_id=? AND handoff_id=?")
      .bind(COLLAB_TENANT_ID, COLLAB_WORKSPACE_ID, handoffId).first<{ roomId: string }>();
    if (!row) return;
    const identity = { tenantId: COLLAB_TENANT_ID, workspaceId: COLLAB_WORKSPACE_ID, roomId: row.roomId };
    if (isCollaborationRoomIdentity(identity)) await env.ConversationRoom.getByName(collaborationRoomName(identity)).notifyCollaborationChange(identity);
  } catch {
    // The committed handoff/run remains authoritative. Browser reconnect and
    // polling recover a missed notification without replaying the execution.
    console.warn("Collaboration handoff notification unavailable.");
  }
}
