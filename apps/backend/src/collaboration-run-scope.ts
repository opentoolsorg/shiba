import { isTeamWorkspaceId } from "@shiba/shared";
import type { Env } from "./env.js";
import {
  COLLAB_TENANT_ID, collaborationEmployeeOrgId, ensureCollaborationSchema,
  getActiveCollaborationMembership, getCollaborationHandoff, getCollaborationMembership, humanActorId,
} from "./collaboration-store.js";
import { canReadCollaborationRoom } from "./collaboration-room-access.js";
import { getTeamWorkspaceMembership } from "./team-workspaces-store.js";
import { getCustomAgentVersion } from "./custom-agents-store.js";
import { isCollaborationApprovalDispatchable, isCollaborationContextQueueable } from "./collaboration-context.js";
import { collaborationExecutorIdentity } from "./collaboration-executor.js";

export async function teamHandoffWorkspaceId(env: Env, handoffId: string): Promise<string | null> {
  if (!env.AGENT_AUDIT) return null;
  try {
    await ensureCollaborationSchema(env);
    const rows = await env.AGENT_AUDIT.prepare(
      `SELECT tenant_id,workspace_id FROM collaboration_handoffs WHERE handoff_id=? LIMIT 2`,
    ).bind(handoffId).all<{ tenant_id: string; workspace_id: string }>();
    return rows.results.length === 1 && rows.results[0]!.tenant_id === COLLAB_TENANT_ID && isTeamWorkspaceId(rows.results[0]!.workspace_id)
      ? rows.results[0]!.workspace_id : null;
  } catch { return null; }
}

/** Derive team authority from the saved handoff, independently of client headers/body org labels. */
export async function resolveTeamHandoffRunScope(env: Env, input: {
  handoffId: string; actorId: string; executorAgentName: string; employeeId: string; employeeVersion: number;
  task: string; expectedWorkspaceId?: string; approvalId?: string;
}): Promise<{ orgId: string; workspaceId: string } | null> {
  if (!env.AGENT_AUDIT || !input.actorId || !input.employeeId || !Number.isSafeInteger(input.employeeVersion)) return null;
  try {
    const workspaceId = await teamHandoffWorkspaceId(env, input.handoffId);
    if (!workspaceId || (input.expectedWorkspaceId && input.expectedWorkspaceId !== workspaceId)) return null;
    const userId = input.actorId.trim().toLowerCase();
    if (!await getTeamWorkspaceMembership(env, workspaceId, userId)) return null;
    const scope = { tenantId: COLLAB_TENANT_ID, workspaceId, userId };
    const handoff = await getCollaborationHandoff(env, scope, input.handoffId);
    const executor = handoff ? collaborationExecutorIdentity(handoff) : null;
    if (!handoff || handoff.status !== "active" || handoff.senderUserId !== userId ||
        !executor || executor.ownerId.trim().toLowerCase() !== userId || executor.agentName !== input.executorAgentName ||
        handoff.senderActorId !== humanActorId(userId) || handoff.executorAgentName !== input.executorAgentName ||
        handoff.recipientActorId !== `agent:${input.employeeId}` || handoff.profileVersion !== input.employeeVersion) return null;
    const [sender, recipient, profile] = await Promise.all([
      getCollaborationMembership(env, scope, handoff.roomId, handoff.senderActorId),
      getActiveCollaborationMembership(env, scope, handoff.roomId, handoff.recipientActorId),
      getCustomAgentVersion(env, collaborationEmployeeOrgId(scope), input.employeeId, input.employeeVersion),
    ]);
    if (!sender || sender.status !== "active" || !sender.capabilities.includes("handoff.create") ||
        !recipient || recipient.status !== "active" || recipient.actorKind !== "agent" ||
        recipient.userId !== handoff.recipientUserId || recipient.profileVersion !== input.employeeVersion ||
        !profile || profile.version !== input.employeeVersion ||
        !await getTeamWorkspaceMembership(env, workspaceId, recipient.userId) ||
        !await canReadCollaborationRoom(env, { ...scope, roomId: handoff.roomId }, userId)) return null;
    const contextCurrent = input.approvalId
      ? await isCollaborationApprovalDispatchable(env, { handoffId: input.handoffId, approvalId: input.approvalId,
        employeeId: input.employeeId, employeeVersion: input.employeeVersion, task: input.task })
      : await isCollaborationContextQueueable(env, scope, handoff.roomId, handoff.handoffId, input.task);
    if (!contextCurrent) return null;
    return { orgId: collaborationEmployeeOrgId(scope), workspaceId };
  } catch { return null; }
}
