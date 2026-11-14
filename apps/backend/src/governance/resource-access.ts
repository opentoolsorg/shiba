import {
  type CanAccessInput,
  type CanAccessResult,
  type GovernanceAccessLevel,
  governanceAccessSatisfies,
} from "@shiba/shared";
import type { Env } from "../env.js";
import { getTeamWorkspaceMembership } from "../team-workspaces-store.js";
import { bestGrantAccess, listActiveGroupIdsForUser } from "./governance-store.js";

type AccessEnv = Pick<Env, "AGENT_AUDIT">;

/**
 * Published access check for rooms, files, notes, and tasks (WS05–WS08).
 * Re-reads membership version on every call.
 */
export async function canAccess(env: AccessEnv, input: CanAccessInput): Promise<CanAccessResult> {
  if (!env.AGENT_AUDIT) return { allowed: false, reason: "denied" };
  const workspaceId = input.actor.workspaceId;
  const userId = input.actor.userId.trim().toLowerCase();
  const membership = await getTeamWorkspaceMembership(env, workspaceId, userId);
  const membershipVersion = membership?.version;
  if (input.actor.guestId) {
    const guestGrant = await bestGrantAccess(
      env,
      workspaceId,
      input.resourceKind,
      input.resourceId,
      [{ kind: "guest", id: input.actor.guestId }],
    );
    if (guestGrant && governanceAccessSatisfies(guestGrant, input.access)) {
      return { allowed: true, reason: "guest_grant", membershipVersion };
    }
    return { allowed: false, reason: "denied", membershipVersion };
  }
  if (!membership) return { allowed: false, reason: "denied" };
  if (membership.role === "owner" || membership.role === "admin") {
    return { allowed: true, reason: "workspace_role", membershipVersion };
  }
  const groups = await listActiveGroupIdsForUser(env, workspaceId, userId);
  const principals: { kind: "user" | "group"; id: string }[] = [
    { kind: "user", id: userId },
    ...groups.map((id) => ({ kind: "group" as const, id })),
  ];
  const granted = await bestGrantAccess(
    env,
    workspaceId,
    input.resourceKind,
    input.resourceId,
    principals,
  );
  if (granted && governanceAccessSatisfies(granted, input.access)) {
    const directOnly = await bestGrantAccess(
      env,
      workspaceId,
      input.resourceKind,
      input.resourceId,
      [{ kind: "user", id: userId }],
    );
    const reason =
      directOnly && governanceAccessSatisfies(directOnly, input.access)
        ? "direct_grant"
        : "group_grant";
    return { allowed: true, reason, membershipVersion };
  }
  return { allowed: false, reason: "denied", membershipVersion };
}

export function collaborationAccessForLevel(level: GovernanceAccessLevel): {
  read: boolean;
  post: boolean;
} {
  if (level === "view") return { read: true, post: false };
  if (level === "comment") return { read: true, post: true };
  return { read: true, post: true };
}
