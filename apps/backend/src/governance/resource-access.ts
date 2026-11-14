/**
 * WS06 publishes the full grant-aware implementation in PR #207. Until that
 * merges, WS07 ships a compatible stub so knowledge routes typecheck and call
 * the published `canAccess` shape from `@shiba/shared/governance`.
 */
import type { CanAccessInput, CanAccessResult } from "@shiba/shared";
import type { Env } from "../env.js";
import { getTeamWorkspaceMembership } from "../team-workspaces-store.js";

type AccessEnv = Pick<Env, "AGENT_AUDIT">;

export async function canAccess(env: AccessEnv, input: CanAccessInput): Promise<CanAccessResult> {
  if (!env.AGENT_AUDIT) return { allowed: false, reason: "denied" };
  const membership = await getTeamWorkspaceMembership(env, input.actor.workspaceId, input.actor.userId);
  const membershipVersion = membership?.version;
  if (!membership) return { allowed: false, reason: "denied", membershipVersion };
  if (membership.role === "owner" || membership.role === "admin") {
    return { allowed: true, reason: "workspace_role", membershipVersion };
  }
  if (input.access === "view") {
    return { allowed: true, reason: "member_default", membershipVersion };
  }
  return { allowed: false, reason: "denied", membershipVersion };
}