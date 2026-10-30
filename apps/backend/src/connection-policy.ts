/**
 * Pure connection capability policy primitives for tool dispatch.
 *
 * Callers resolve identity, the connection grant, provider scopes, verification
 * state, current policy and approval from trusted stores before invoking this
 * helper. This module performs no storage, OAuth, provider or network calls.
 */

export type CapabilityKind = "connector" | "skill" | "mcp";

/** A stable, non-secret identifier for one callable capability. */
export interface CapabilityRef {
  kind: CapabilityKind;
  id: string;
}

export type ConnectionOwner =
  | { type: "user"; userId: string; workspaceId: string }
  | { type: "shared_workspace"; workspaceId: string };

export type ConnectionLifecycle = "active" | "revoked" | "expired";
export type ConnectionVerification = "configured" | "live_verified";
export type ActionRisk = "read" | "external_write";

/** Resolved metadata only. Never put access tokens or secrets here. */
export interface ConnectionGrant {
  connectionId: string;
  owner: ConnectionOwner;
  lifecycle: ConnectionLifecycle;
  expiresAt?: number;
  verification: ConnectionVerification;
  verifiedAt?: number;
  verificationExpiresAt?: number;
  capability: CapabilityRef;
  providerScopes: readonly string[];
  /** Exact resource identifiers; empty means no resource-bound access. */
  allowedResources: readonly string[];
  accountId?: string;
  policyVersion: string;
  /** Incremented on reconnect/re-authorization; old approvals cannot revive. */
  generation: number;
}

export interface DispatchPrincipal {
  userId: string;
  workspaceId: string;
}

/** Server-computed SHA-256 of canonical, normalized action arguments. */
export interface CapabilityAction {
  capability: CapabilityRef;
  action: string;
  resourceId?: string;
  accountId?: string;
  argumentDigest: string;
}

/** Action policy is keyed by both capability identity and exact action. */
export interface CapabilityActionRule {
  capability: CapabilityRef;
  action: string;
  risk: ActionRisk;
  requiredProviderScopes?: readonly string[];
  /** True when this action must identify one resource from the grant allowlist. */
  resourceRequired?: boolean;
}

export interface CapabilityPolicy {
  version: string;
  allowlist: readonly CapabilityRef[];
  actions: readonly CapabilityActionRule[];
}

/** Frozen approval evidence. The dispatcher must use exactly the approved args. */
export interface ActionApproval {
  approvalId: string;
  approved: boolean;
  approvedAt: number;
  principalUserId: string;
  workspaceId: string;
  connectionId: string;
  connectionGeneration: number;
  capability: CapabilityRef;
  action: string;
  resourceId?: string;
  accountId?: string;
  argumentDigest: string;
  policyVersion: string;
  expiresAt: number;
}

export interface ConnectionDispatchContext {
  now: number;
  principal: DispatchPrincipal;
  grant: ConnectionGrant;
  policy: CapabilityPolicy;
  request: CapabilityAction;
  approval?: ActionApproval;
  maxVerificationAgeMs?: number;
}

export type DispatchDenialReason =
  | "invalid_time"
  | "workspace_mismatch"
  | "owner_mismatch"
  | "connection_revoked"
  | "connection_expired"
  | "connection_inactive"
  | "live_verification_required"
  | "verification_stale"
  | "policy_stale"
  | "capability_not_allowed"
  | "unsupported_action"
  | "provider_scope_missing"
  | "resource_required"
  | "resource_not_allowed"
  | "account_mismatch"
  | "approval_required"
  | "approval_denied"
  | "approval_stale"
  | "approval_mismatch";

export type ConnectionDispatchDecision =
  | { allowed: true; risk: ActionRisk; approvalId?: string; approvedArgumentDigest?: string }
  | { allowed: false; reason: DispatchDenialReason };

const SHA256_HEX = /^[a-f0-9]{64}$/i;

function sameCapability(a: CapabilityRef, b: CapabilityRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

function deny(reason: DispatchDenialReason): ConnectionDispatchDecision {
  return { allowed: false, reason };
}

/**
 * Decide whether one exact operation may be dispatched. Returns only stable
 * denial codes. This is a policy decision, not a single-use approval consume.
 */
export function decideConnectionDispatch(
  context: ConnectionDispatchContext,
): ConnectionDispatchDecision {
  const { now, principal, grant, policy, request } = context;

  if (!Number.isFinite(now)) return deny("invalid_time");
  if (
    context.maxVerificationAgeMs !== undefined &&
    (!Number.isFinite(context.maxVerificationAgeMs) || context.maxVerificationAgeMs < 0)
  ) {
    return deny("invalid_time");
  }
  if (!SHA256_HEX.test(request.argumentDigest)) return deny("approval_mismatch");

  if (principal.workspaceId !== grant.owner.workspaceId) return deny("workspace_mismatch");
  if (grant.owner.type === "user" && grant.owner.userId !== principal.userId) {
    return deny("owner_mismatch");
  }
  if (grant.lifecycle === "revoked") return deny("connection_revoked");
  if (grant.lifecycle === "expired") return deny("connection_expired");
  if (grant.lifecycle !== "active") return deny("connection_inactive");
  if (grant.expiresAt !== undefined && (!Number.isFinite(grant.expiresAt) || now >= grant.expiresAt)) {
    return deny("connection_expired");
  }
  if (grant.verification !== "live_verified") return deny("live_verification_required");
  const verifiedAt = grant.verifiedAt;
  const verificationExpiresAt = grant.verificationExpiresAt;
  if (
    verifiedAt === undefined ||
    verificationExpiresAt === undefined ||
    !Number.isFinite(verifiedAt) ||
    !Number.isFinite(verificationExpiresAt) ||
    verifiedAt > now ||
    verifiedAt >= verificationExpiresAt ||
    now >= verificationExpiresAt ||
    (context.maxVerificationAgeMs !== undefined && now - verifiedAt > context.maxVerificationAgeMs)
  ) {
    return deny("verification_stale");
  }
  if (grant.policyVersion !== policy.version) return deny("policy_stale");
  if (!Number.isSafeInteger(grant.generation) || grant.generation < 1) {
    return deny("connection_inactive");
  }
  if (!sameCapability(request.capability, grant.capability)) return deny("capability_not_allowed");
  if (!policy.allowlist.some((item) => sameCapability(item, request.capability))) {
    return deny("capability_not_allowed");
  }

  const matchingRules = policy.actions.filter(
    (rule) => rule.action === request.action && sameCapability(rule.capability, request.capability),
  );
  if (matchingRules.length !== 1) return deny("unsupported_action");
  const rule = matchingRules[0]!;
  if (rule.requiredProviderScopes?.some((scope) => !grant.providerScopes.includes(scope))) {
    return deny("provider_scope_missing");
  }
  if (rule.resourceRequired && request.resourceId === undefined) return deny("resource_required");
  if (
    request.resourceId !== undefined &&
    (grant.allowedResources.length === 0 || !grant.allowedResources.includes(request.resourceId))
  ) {
    return deny("resource_not_allowed");
  }
  if (request.accountId !== grant.accountId) return deny("account_mismatch");

  if (rule.risk === "read") return { allowed: true, risk: rule.risk };

  const approval = context.approval;
  if (!approval) return deny("approval_required");
  if (!approval.approved) return deny("approval_denied");
  if (
    !Number.isFinite(approval.approvedAt) ||
    !Number.isFinite(approval.expiresAt) ||
    approval.approvedAt > now ||
    approval.approvedAt >= approval.expiresAt ||
    now >= approval.expiresAt
  ) {
    return deny("approval_stale");
  }
  if (
    approval.policyVersion !== policy.version ||
    approval.connectionGeneration !== grant.generation
  ) {
    return deny("approval_stale");
  }
  if (
    approval.principalUserId !== principal.userId ||
    approval.workspaceId !== principal.workspaceId ||
    approval.connectionId !== grant.connectionId ||
    !sameCapability(approval.capability, request.capability) ||
    approval.action !== request.action ||
    approval.resourceId !== request.resourceId ||
    approval.accountId !== request.accountId ||
    !SHA256_HEX.test(approval.argumentDigest) ||
    approval.argumentDigest !== request.argumentDigest
  ) {
    return deny("approval_mismatch");
  }
  return {
    allowed: true,
    risk: rule.risk,
    approvalId: approval.approvalId,
    approvedArgumentDigest: approval.argumentDigest,
  };
}
