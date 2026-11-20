/**
 * Who pays for a run. Credits belong to a person for personal work and to a
 * team workspace for team work, never to a Durable Object name (one user has
 * many session stores, and team executors get a fresh name per handoff).
 * Both values are derived server-side: the user from the authenticated
 * request or the run's queued owner, the workspace from the run's org.
 */
import { isTeamWorkspaceId } from "@shiba/shared";
import type { DelegatedRun } from "@shiba/shared";
import { initiatorUserIdFromOrchestratorName } from "./subscription-routing.js";

export const TEAM_BILLING_PREFIX = "team:";
export const USER_BILLING_PREFIX = "user:";

export interface BillingSubject {
  /** Ledger key: `user:<id>` or `team:<workspaceId>`. */
  key: string;
  scope: "personal" | "team";
  userId: string | null;
  workspaceId: string | null;
}

function clean(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function personalBillingSubject(userId: string): BillingSubject {
  const id = userId.trim().toLowerCase();
  return { key: `${USER_BILLING_PREFIX}${id}`, scope: "personal", userId: id, workspaceId: null };
}

export function teamBillingSubject(workspaceId: string): BillingSubject {
  if (!isTeamWorkspaceId(workspaceId)) throw new Error("Invalid team workspace id.");
  return { key: `${TEAM_BILLING_PREFIX}${workspaceId}`, scope: "team", userId: null, workspaceId };
}

/** `team:<workspaceId>` org ids (collaborationEmployeeOrgId) are team-funded. */
export function teamWorkspaceFromOrgId(orgId: string | undefined | null): string | null {
  const value = clean(orgId);
  if (value === null || !value.startsWith(TEAM_BILLING_PREFIX)) return null;
  const workspaceId = value.slice(TEAM_BILLING_PREFIX.length);
  return isTeamWorkspaceId(workspaceId) ? workspaceId : null;
}

/**
 * The subject that funds one run: its team workspace when the run carries a
 * team org, otherwise the user who queued it, falling back to the store's own
 * owner for dashboard and Slack lanes.
 */
export function billingSubjectForRun(run: Pick<DelegatedRun, "orgId" | "queuedBy">, storeName: string): BillingSubject | null {
  const workspaceId = teamWorkspaceFromOrgId(run.orgId);
  if (workspaceId !== null) return teamBillingSubject(workspaceId);
  const userId = clean(run.queuedBy) ?? initiatorUserIdFromOrchestratorName(storeName);
  return userId === null || userId === undefined ? null : personalBillingSubject(userId);
}

/** The subject a run store bills to when it has no run to read. */
export function billingSubjectForStore(storeName: string): BillingSubject | null {
  const userId = initiatorUserIdFromOrchestratorName(storeName);
  return userId === undefined ? null : personalBillingSubject(userId);
}
