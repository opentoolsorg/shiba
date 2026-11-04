import { authorizeCollaborationAction, isTeamWorkspaceId } from "@shiba/shared";
import { COLLAB_TENANT_ID, COLLAB_WORKSPACE_ID, ensureCollaborationSchema, getCollaborationMembership, getCollaborationRoom, isCollaborationSlackRoomAudienceAuthorized, type CollaborationScope } from "./collaboration-store.js";
import type { Env } from "./env.js";
import { isTeamWorkspaceMember } from "./team-workspaces-store.js";

export interface CollaborationRoomIdentity {
  tenantId: string;
  workspaceId: string;
  roomId: string;
}

export function collaborationRoomName(identity: CollaborationRoomIdentity): string {
  return JSON.stringify(["shiba:collaboration:v1", identity.tenantId, identity.workspaceId, identity.roomId]);
}

export function isCollaborationRoomIdentity(identity: CollaborationRoomIdentity): boolean {
  return identity.tenantId === COLLAB_TENANT_ID && (identity.workspaceId === COLLAB_WORKSPACE_ID || isTeamWorkspaceId(identity.workspaceId)) &&
    /^room_[a-f0-9]{24}$/.test(identity.roomId);
}

/** Both the upgrade and each live delivery use current grants, never a viewer nonce. */
export async function canReadCollaborationRoom(env: Env, identity: CollaborationRoomIdentity, userId: string): Promise<boolean> {
  if (!isCollaborationRoomIdentity(identity) || !userId || userId.length > 320 || userId !== userId.trim().toLowerCase()) return false;
  if (identity.workspaceId !== COLLAB_WORKSPACE_ID && !await isTeamWorkspaceMember(env, identity.workspaceId, userId)) return false;
  const scope: CollaborationScope = { tenantId: identity.tenantId, workspaceId: identity.workspaceId, userId };
  const room = await getCollaborationRoom(env, scope, identity.roomId);
  if (!room) return false;
  const actor = { kind: "human" as const, actorId: `human:${userId}`, ...scope };
  const membership = await getCollaborationMembership(env, scope, identity.roomId, actor.actorId);
  return authorizeCollaborationAction({ ...scope, actor }, room, membership ?? undefined, "room.read").allowed &&
    await isCollaborationSlackRoomAudienceAuthorized(env, scope, identity.roomId) &&
    (identity.workspaceId === COLLAB_WORKSPACE_ID || await isTeamWorkspaceMember(env, identity.workspaceId, userId));
}

/** Internal settlement hint. The room rechecks each viewer; no output travels here. */
export async function notifyCollaborationHandoffChange(env: Env, handoffId: string): Promise<void> {
  if (!env.ConversationRoom || !env.AGENT_AUDIT || !/^[A-Za-z0-9_-]{1,100}$/.test(handoffId)) return;
  try {
    await ensureCollaborationSchema(env);
    const rows = await env.AGENT_AUDIT.prepare("SELECT tenant_id AS tenantId,workspace_id AS workspaceId,room_id AS roomId FROM collaboration_handoffs WHERE tenant_id=? AND handoff_id=? LIMIT 2")
      .bind(COLLAB_TENANT_ID, handoffId).all<CollaborationRoomIdentity>();
    // Handoff ids normally are unique. Ambiguous legacy rows cannot select a room.
    if (rows.results.length !== 1) return;
    const identity = rows.results[0]!;
    if (isCollaborationRoomIdentity(identity)) await env.ConversationRoom.getByName(collaborationRoomName(identity)).notifyCollaborationChange(identity);
  } catch {
    // The committed handoff/run remains authoritative. Browser reconnect and
    // polling recover a missed notification without replaying the execution.
    console.warn("Collaboration handoff notification unavailable.");
  }
}
