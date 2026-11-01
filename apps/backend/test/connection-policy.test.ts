import { describe, expect, it } from "vitest";
import {
  decideConnectionDispatch,
  type ActionApproval,
  type ConnectionDispatchContext,
} from "../src/connection-policy.js";

const digest = "a".repeat(64);
const base: ConnectionDispatchContext = {
  now: 1_000,
  principal: { userId: "user-a", workspaceId: "workspace-a" },
  grant: {
    connectionId: "connection-1",
    owner: { type: "user", userId: "user-a", workspaceId: "workspace-a" },
    lifecycle: "active", verification: "live_verified", verifiedAt: 900, verificationExpiresAt: 2_000,
    capability: { kind: "connector", id: "mail" }, providerScopes: ["mail.read", "mail.send"],
    allowedResources: ["mailbox-1"], accountId: "account-1", policyVersion: "v1", generation: 3,
  },
  policy: {
    version: "v1", allowlist: [{ kind: "connector", id: "mail" }],
    actions: [
      { capability: { kind: "connector", id: "mail" }, action: "list", risk: "read", requiredProviderScopes: ["mail.read"], resourceRequired: true },
      { capability: { kind: "connector", id: "mail" }, action: "send", risk: "external_write", requiredProviderScopes: ["mail.send"], resourceRequired: true },
      { capability: { kind: "skill", id: "mail" }, action: "list", risk: "external_write" },
    ],
  },
  request: { capability: { kind: "connector", id: "mail" }, action: "list", resourceId: "mailbox-1", accountId: "account-1", argumentDigest: digest },
};

function approval(overrides: Partial<ActionApproval> = {}): ActionApproval {
  return {
    approvalId: "approval-7", approved: true, approvedAt: 950, principalUserId: "user-a", workspaceId: "workspace-a",
    connectionId: "connection-1", connectionGeneration: 3, capability: { kind: "connector", id: "mail" },
    action: "send", resourceId: "mailbox-1", accountId: "account-1", argumentDigest: digest,
    policyVersion: "v1", expiresAt: 1_500, ...overrides,
  };
}

describe("connection capability policy", () => {
  it("allows verified reads and denies wrong owner or workspace", () => {
    expect(decideConnectionDispatch(base)).toEqual({ allowed: true, risk: "read" });
    expect(decideConnectionDispatch({ ...base, principal: { userId: "other", workspaceId: "workspace-a" } })).toEqual({ allowed: false, reason: "owner_mismatch" });
    expect(decideConnectionDispatch({ ...base, principal: { userId: "user-a", workspaceId: "other" } })).toEqual({ allowed: false, reason: "workspace_mismatch" });
  });

  it("denies configured, revoked, expired, or stale grants", () => {
    expect(decideConnectionDispatch({ ...base, grant: { ...base.grant, verification: "configured" } })).toEqual({ allowed: false, reason: "live_verification_required" });
    expect(decideConnectionDispatch({ ...base, grant: { ...base.grant, lifecycle: "revoked" } })).toEqual({ allowed: false, reason: "connection_revoked" });
    expect(decideConnectionDispatch({ ...base, grant: { ...base.grant, expiresAt: 1_000 } })).toEqual({ allowed: false, reason: "connection_expired" });
    expect(decideConnectionDispatch({ ...base, grant: { ...base.grant, verifiedAt: 1_001 } })).toEqual({ allowed: false, reason: "verification_stale" });
    expect(decideConnectionDispatch({ ...base, grant: { ...base.grant, verifiedAt: 2_000 } })).toEqual({ allowed: false, reason: "verification_stale" });
    expect(decideConnectionDispatch({ ...base, maxVerificationAgeMs: 50 })).toEqual({ allowed: false, reason: "verification_stale" });
  });

  it("rejects empty and nonmatching resource allowlists and missing required resource IDs", () => {
    expect(decideConnectionDispatch({ ...base, grant: { ...base.grant, allowedResources: [] } })).toEqual({ allowed: false, reason: "resource_not_allowed" });
    expect(decideConnectionDispatch({ ...base, request: { ...base.request, resourceId: "other" } })).toEqual({ allowed: false, reason: "resource_not_allowed" });
    expect(decideConnectionDispatch({ ...base, request: { ...base.request, resourceId: undefined } })).toEqual({ allowed: false, reason: "resource_required" });
  });

  it("checks capability-specific rules and provider scopes", () => {
    expect(decideConnectionDispatch({ ...base, request: { ...base.request, capability: { kind: "skill", id: "mail" } } })).toEqual({ allowed: false, reason: "capability_not_allowed" });
    expect(decideConnectionDispatch({ ...base, grant: { ...base.grant, providerScopes: [] } })).toEqual({ allowed: false, reason: "provider_scope_missing" });
    expect(decideConnectionDispatch({ ...base, request: { ...base.request, action: "unknown" } })).toEqual({ allowed: false, reason: "unsupported_action" });
  });

  it("requires an exact, fresh write approval bound to arguments and grant generation", () => {
    const write = { ...base, request: { ...base.request, action: "send" } };
    expect(decideConnectionDispatch(write)).toEqual({ allowed: false, reason: "approval_required" });
    expect(decideConnectionDispatch({ ...write, approval: approval() })).toEqual({ allowed: true, risk: "external_write", approvalId: "approval-7", approvedArgumentDigest: digest });
    expect(decideConnectionDispatch({ ...write, request: { ...write.request, argumentDigest: "b".repeat(64) }, approval: approval() })).toEqual({ allowed: false, reason: "approval_mismatch" });
    expect(decideConnectionDispatch({ ...write, grant: { ...write.grant, generation: 4 }, approval: approval() })).toEqual({ allowed: false, reason: "approval_stale" });
    expect(decideConnectionDispatch({ ...write, approval: approval({ expiresAt: 1_000 }) })).toEqual({ allowed: false, reason: "approval_stale" });
    expect(decideConnectionDispatch({ ...write, approval: approval({ approvedAt: 1_001 }) })).toEqual({ allowed: false, reason: "approval_stale" });
  });

  it("fails closed on NaN and malformed times or digests", () => {
    expect(decideConnectionDispatch({ ...base, now: Number.NaN })).toEqual({ allowed: false, reason: "invalid_time" });
    expect(decideConnectionDispatch({ ...base, grant: { ...base.grant, verifiedAt: Number.NaN } })).toEqual({ allowed: false, reason: "verification_stale" });
    expect(decideConnectionDispatch({ ...base, grant: { ...base.grant, verificationExpiresAt: Number.NaN } })).toEqual({ allowed: false, reason: "verification_stale" });
    expect(decideConnectionDispatch({ ...base, request: { ...base.request, argumentDigest: "not-a-digest" } })).toEqual({ allowed: false, reason: "approval_mismatch" });
    expect(decideConnectionDispatch({ ...base, request: { ...base.request, action: "send" }, approval: approval({ expiresAt: Number.NaN }) })).toEqual({ allowed: false, reason: "approval_stale" });
  });
});
