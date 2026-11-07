import { signOperatorRedeemCapability, verifyOperatorRedeemCapability } from "../src/integrations/openconnector-operator-capability.js";
import { OperatorGateway } from "../../../packages/openconnector-read-gateway/src/operator-gateway.js";
import { OperatorInvocationStore, type OperatorSqlStorage } from "../../../packages/openconnector-read-gateway/src/operator-store.js";
import { CoordinatedOwner } from "../../../packages/openconnector-read-gateway/src/coordinated-owner.js";
import { prepareOperatorFigmaRequest } from "../../../packages/openconnector-read-gateway/src/operator-provider.js";
import { operatorEnrollmentConnectionId, type OperatorExecutionEnrollment } from "../src/integrations/openconnector-operator-enrollment.js";
import { UPSTREAM_REVISION } from "../../../packages/openconnector-read-gateway/src/types.js";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { digest, hash } from "../../../packages/openconnector-read-gateway/src/json.js";
import { OPERATOR_INPUT_SCHEMA, operatorRequestDigest, type OperatorExecutionEnvelope } from "../../../packages/openconnector-read-gateway/src/operator-envelope.js";
import {
  OperatorParentAuthority, OPERATOR_PARENT_PRODUCTION_READY, OPERATOR_PARENT_ACTIVATION_BLOCKERS,
  mutateAfterOperatorInvalidation,
  type OperatorAuthorityStorage, type OperatorAuthorityRecord, type OperatorAuthorityReference,
  type OperatorRedeemCapability, type OperatorBarrierReply,
} from "../src/integrations/openconnector-operator-authority.js";

import type { OperatorSourceReference } from "../src/integrations/openconnector-operator-sources.js";

function fixtureSources(record: OperatorAuthorityRecord): OperatorSourceReference[] {
  const ownerId = record.ownerId;
  switch (record.kind) {
    case "enrollment": return [{ generation: 1, source: { kind: "connector_account", storeId: "fixture-native-store",
      personalAlias: record.personalAlias, provider: record.provider } }];
    case "employee": return [{ generation: 1, source: { kind: "employee_definition", workspaceId: "workspace-one", employeeId: record.id } }];
    case "principal": return [{ generation: 1, source: { kind: "principal_token", namespaceId: "fixture-token-store", tokenInstanceId: record.id } }];
    case "execution_context": return [
      { generation: 1, source: { kind: "session", ownerId, sessionId: "session-one" } },
      { generation: 1, source: { kind: "run", ownerId, runId: "run-one" } },
    ];
    default: return [{ generation: 1, source: { kind: "employee_grants", workspaceId: "workspace-one", employeeId: record.employeeId } }];
  }
}
// Defaults exist only in this synthetic fixture. Production installation has a
// mandatory mapping parameter and cannot derive sources from these constants.
class FixtureAuthority extends OperatorParentAuthority {
  override installAuthority(record: OperatorAuthorityRecord, previous: number, sources = fixtureSources(record)) {
    return super.installAuthority(record, previous, sources);
  }
}

class FixtureStorage implements OperatorAuthorityStorage {
  db = new DatabaseSync(":memory:");
  transactionOpen = false;
  failCommitAcknowledgment = false;
  failNextWrite = false;
  sql = {
    exec: <T extends Record<string, unknown>>(query: string, ...bindings: (string | number | null)[]) => {
      if (this.failNextWrite && /^\s*(INSERT|UPDATE)/.test(query)) { this.failNextWrite = false; throw Error("fixture write failed"); }
      const rows = this.db.prepare(query).all(...bindings) as T[];
      return { toArray: () => rows };
    },
  };
  async sync() {}
  transactionSync<T>(callback: () => T): T {
    if (this.transactionOpen) throw Error("nested fixture transaction");
    this.db.exec("BEGIN"); this.transactionOpen = true;
    let result: T;
    try { result = callback(); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
    finally { this.transactionOpen = false; }
    if (this.failCommitAcknowledgment) { this.failCommitAcknowledgment = false; throw Error("fixture lost acknowledgment"); }
    return result;
  }
}
function required<T>(value: T | undefined): T { if (value === undefined) throw Error("fixture value missing"); return value; }
const NOW = 2_000_000_000_000;
async function fixture() {
  const storage = new FixtureStorage();
  let now = NOW;
  const envelope: OperatorExecutionEnvelope = {
    format: "shiba.operator-execute.v1", invocationId: "inv-one", approvalId: "approval-one", requestDigest: "0".repeat(64),
    enrollmentId: "enrollment-one", enrollmentGeneration: 1, connectionId: `oco_${"1".repeat(64)}`,
    ownerId: "owner-one", personalAlias: `u_${(await digest("owner-one")).slice(0, 16)}`, provider: "figma",
    rawConnectionId: "raw-one", upstreamRevision: "revision-one", deploymentEpoch: "epoch-one",
    versionId: "11111111-1111-4111-8111-111111111111", manifestDigest: "2".repeat(64),
    principalId: "principal-one", employeeId: "employee-one", employeeVersion: 1, executionContextId: "context-one",
    grantVersions: [
      { kind: "actor_grant", id: "actor-one", version: 1 },
      { kind: "resource_grant", id: "resource-one", version: 1 },
      { kind: "role_grant", id: "role-one", version: 1 },
    ],
    actionId: "figma.get_file_metadata", inputSchemaHash: await hash(OPERATOR_INPUT_SCHEMA),
    arguments: { fileKey: "file-one" }, argumentDigest: await hash({ fileKey: "file-one" }),
    expiresAt: NOW + 10_000, maxDurationMs: 1000, maxBytes: 1024,
  };
  const provenance: OperatorExecutionEnrollment = {
    format: "shiba.operator-execution-enrollment.v1", enrollmentId: envelope.enrollmentId,
    enrollmentGeneration: 1, recordVersion: 1, ownerId: envelope.ownerId, personalAlias: envelope.personalAlias,
    provider: envelope.provider, rawConnectionId: envelope.rawConnectionId, upstreamRevision: envelope.upstreamRevision,
    deploymentEpoch: envelope.deploymentEpoch, versionId: envelope.versionId, upstreamSourceRevision: UPSTREAM_REVISION,
    manifestDigest: envelope.manifestDigest, operations: [{ actionId: envelope.actionId, inputSchemaHash: envelope.inputSchemaHash, executorHash: "3".repeat(64) }],
    expiresAt: NOW + 20_000, proposal: { proposalId: "proposal-one", operatorId: "operator-one", proposedAt: NOW - 1000 },
    acceptance: { acceptanceId: "acceptance-one", ownerId: envelope.ownerId, acceptedAt: NOW - 500, purpose: "operator_execution" },
    lifecycle: "active", revocationTombstone: null,
  };
  envelope.connectionId = await operatorEnrollmentConnectionId(provenance);
  envelope.requestDigest = await operatorRequestDigest(envelope);
  const capability: OperatorRedeemCapability = {
    stage: "redeem", invocationId: envelope.invocationId, approvalId: envelope.approvalId,
    requestDigest: envelope.requestDigest, deploymentEpoch: envelope.deploymentEpoch, expiresAt: NOW + 9000,
  };
  const verifyCapability = vi.fn(async (token: string) => { if (token !== "fixture-redeem-capability") throw Error("invalid"); return { ...capability }; });
  const options = { verifyCapability, now: () => now };
  const authority = new FixtureAuthority(storage, options);
  const base = { ownerId: envelope.ownerId, expiresAt: NOW + 20_000, version: 1 };
  const records: OperatorAuthorityRecord[] = [
    { ...base, kind: "enrollment", provenance, id: envelope.enrollmentId, enrollmentGeneration: 1, connectionId: envelope.connectionId,
      personalAlias: envelope.personalAlias, provider: envelope.provider, rawConnectionId: envelope.rawConnectionId,
      upstreamRevision: envelope.upstreamRevision, deploymentEpoch: envelope.deploymentEpoch,
      versionId: envelope.versionId, manifestDigest: envelope.manifestDigest,
      operations: [{ actionId: envelope.actionId, inputSchemaHash: envelope.inputSchemaHash }] },
    { ...base, kind: "employee", id: envelope.employeeId },
    { ...base, kind: "principal", id: envelope.principalId },
    { ...base, kind: "execution_context", id: envelope.executionContextId, principalId: envelope.principalId, employeeId: envelope.employeeId },
    ...envelope.grantVersions.map(grant => ({ ...base, ...grant,
      principalId: envelope.principalId, employeeId: envelope.employeeId, enrollmentId: envelope.enrollmentId,
      connectionId: envelope.connectionId, actionIds: [envelope.actionId],
    })),
  ];
  const registered = new Set<string>();
  for (const record of records) {
    for (const ref of fixtureSources(record)) {
      const key = JSON.stringify(ref.source);
      if (registered.has(key)) continue;
      await authority.registerLegacySource({ ...ref, revision: record.kind === "enrollment" ? record.upstreamRevision : "source-revision-one",
        ...(record.kind === "enrollment" ? { rawConnectionId: record.rawConnectionId } : {}) });
      registered.add(key);
    }
    await authority.installAuthority(record, 0);
  }
  const sourceRefs = (refs: OperatorAuthorityReference[]) => {
    const result = refs.flatMap(ref => fixtureSources(required(records.find(record => record.kind === ref.kind && record.id === ref.id))));
    return [...new Map(result.map(ref => [JSON.stringify(ref), ref])).values()];
  };
  const refs: OperatorAuthorityReference[] = records.map(({ kind, id, version }) => ({ kind, id, version }));
  const approval = { envelope, dependencies: refs, approvedBy: envelope.ownerId, approvedAt: NOW, expiresAt: NOW + 8000 };
  const approve = () => authority.recordHumanApproval(approval);
  const request = () => ({ envelope, requestDigest: envelope.requestDigest, capability: "fixture-redeem-capability", tokenExpiresAt: NOW + 7000 });
  const redeem = () => authority.redeem(request());
  const barrier = vi.fn(async (input: { deploymentEpoch: string; revocationId: string }): Promise<OperatorBarrierReply> => {
    expect(storage.transactionOpen).toBe(false);
    return { ...input, status: "complete" };
  });
  return { storage, authority, sourceRefs, options, envelope, capability, verifyCapability, records, refs, approval, approve, request, redeem, barrier, setNow: (value: number) => { now = value; } };
}

describe("operator parent admission authority (isolated SQLite fixture only)", () => {
  it("is not production-ready and cannot activate via a feature flag", () => {
    expect(OPERATOR_PARENT_PRODUCTION_READY).toBe(false);
    expect(OPERATOR_PARENT_ACTIVATION_BLOCKERS.length).toBeGreaterThanOrEqual(5);
  });
  it("does not use missing authority or a missing human approval as a permissive fallback", async () => {
    const f = await fixture();
    expect(await f.redeem()).toEqual({ status: "rejected" });
    f.approval.dependencies = f.refs.filter(ref => ref.kind !== "principal");
    await expect(f.approve()).rejects.toThrow();
    expect(await f.redeem()).toEqual({ status: "rejected" });
  });
  it("atomically consumes one exact frozen human approval and binds the earliest expiry", async () => {
    const f = await fixture(); await f.approve();
    expect(await f.redeem()).toEqual({ status: "admitted", effectiveDeadline: NOW + 7000 });
    expect(await f.redeem()).toEqual({ status: "unknown" });
    const row = f.storage.db.prepare("SELECT * FROM operator_parent_approvals").get();
    expect(row?.consumed_invocation_id).toBe(f.envelope.invocationId);
    expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM operator_parent_admissions").get()?.n).toBe(1);
  });
  it("never turns a concurrent redeem into another admission", async () => {
    const f = await fixture(); await f.approve();
    const results = await Promise.all([f.redeem(), f.redeem()]);
    expect(results.map(result => result.status).sort()).toEqual(["admitted", "unknown"]);
  });
  it("rejects wrong human identity, missing grant kinds and caller-selected dependency subsets", async () => {
    for (const change of [
      (f: Awaited<ReturnType<typeof fixture>>) => { f.approval.approvedBy = "other-owner"; },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.approval.dependencies = f.refs.filter(ref => ref.kind !== "role_grant"); },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.approval.dependencies = [...f.refs, { kind: "principal", id: "other-principal", version: 1 }]; },
    ]) {
      const f = await fixture(); change(f); await expect(f.approve()).rejects.toThrow();
      expect(await f.redeem()).toEqual({ status: "rejected" });
    }
  });
  it.each(["enrollment", "employee", "principal", "execution_context", "actor_grant", "resource_grant", "role_grant"] as const)(
    "a %s invalidation wins over later redemption without waiting for a sibling", async kind => {
      const f = await fixture(); await f.approve();
      const revocation = await f.authority.beginInvalidation(`revocation-${kind}`, [required(f.refs.find(ref => ref.kind === kind))]);
      expect(revocation.status).toBe("revoking");
      expect(revocation.deploymentEpochs).toEqual(["epoch-one"]);
      expect(await f.redeem()).toEqual({ status: "rejected" });
      expect(f.barrier).not.toHaveBeenCalled();
    },
  );
  it("reads expiry and current authority after the last capability await", async () => {
    const f = await fixture(); await f.approve();
    f.verifyCapability.mockImplementationOnce(async () => {
      await f.authority.beginInvalidation("while-verifying", [required(f.refs[1])]);
      return f.capability;
    });
    expect(await f.redeem()).toEqual({ status: "rejected" });
    const g = await fixture(); await g.approve();
    g.verifyCapability.mockImplementationOnce(async () => { g.setNow(NOW + 8000); return g.capability; });
    expect(await g.redeem()).toEqual({ status: "rejected" });
  });
  it.each(["stage", "invocationId", "approvalId", "requestDigest", "deploymentEpoch", "expiresAt"] as const)(
    "fails closed on wrong %s in the stage-scoped capability", async field => {
      const f = await fixture(); await f.approve();
      Object.assign(f.capability, { [field]: field === "expiresAt" ? NOW - 1 : "wrong" });
      expect(await f.redeem()).toEqual({ status: "rejected" });
    },
  );
  it("cannot change a bound operation, limits or account after approval", async () => {
    for (const field of ["rawConnectionId", "upstreamRevision", "connectionId", "enrollmentGeneration", "maxBytes", "maxDurationMs"] as const) {
      const f = await fixture(); await f.approve();
      Object.assign(f.envelope, { [field]: typeof f.envelope[field] === "number" ? Number(f.envelope[field]) + 1 : "other" });
      f.envelope.requestDigest = await operatorRequestDigest(f.envelope);
      f.capability.requestDigest = f.envelope.requestDigest;
      expect(await f.redeem()).toEqual({ status: "rejected" });
    }
  });
  it("retains approval consumption after an admission row is pruned or a commit acknowledgment is lost", async () => {
    const f = await fixture(); await f.approve(); f.storage.failCommitAcknowledgment = true;
    await expect(f.redeem()).rejects.toThrow("lost acknowledgment");
    f.storage.db.exec("DELETE FROM operator_parent_admissions");
    const restarted = new FixtureAuthority(f.storage, f.options);
    expect(await restarted.redeem(f.request())).toEqual({ status: "unknown" });
  });
  it("does not consume an approval if the transaction rolls back", async () => {
    const f = await fixture(); await f.approve(); f.storage.failNextWrite = true;
    await expect(f.redeem()).rejects.toThrow("fixture write failed");
    expect(f.storage.db.prepare("SELECT consumed_invocation_id FROM operator_parent_approvals").get()?.consumed_invocation_id).toBeNull();
    // Only the fixture demonstrates rollback. A production caller cannot infer
    // this from a transport failure and must never automatically retry it.
  });
  it("does not change a live authority or revive an old generation", async () => {
    const f = await fixture();
    await expect(f.authority.installAuthority({ ...required(f.records[1]), version: 2 }, 1)).rejects.toThrow();
    await f.authority.beginInvalidation("employee-change", [required(f.refs[1])]);
    await expect(f.authority.installAuthority(required(f.records[1]), 1)).rejects.toThrow();
    await f.authority.finishInvalidation("employee-change", f.barrier);
    await f.authority.installAuthority({ ...required(f.records[1]), version: 2 }, 1);
    await expect(f.authority.beginInvalidation("stale-writer", [required(f.refs[1])])).rejects.toThrow();
  });
  it("snapshots caller data before awaits and keeps mutable references out of durable approval", async () => {
    const f = await fixture(); await f.approve();
    f.verifyCapability.mockImplementationOnce(async () => {
      f.envelope.rawConnectionId = "mutated-after-parse";
      f.approval.dependencies.length = 0;
      return f.capability;
    });
    expect(await f.redeem()).toEqual({ status: "admitted", effectiveDeadline: NOW + 7000 });
  });
});

describe("operator revocation barrier participation", () => {
  it("releases the parent transaction while a sibling drains earlier work", async () => {
    const f = await fixture(); await f.approve(); expect((await f.redeem()).status).toBe("admitted");
    await f.authority.beginInvalidation("revoke-owner", [required(f.refs[0])]);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const completing = f.authority.finishInvalidation("revoke-owner", async request => {
      expect(f.storage.transactionOpen).toBe(false);
      // An in-flight sibling can finish its parent check without deadlock.
      expect((await f.redeem()).status).toBe("unknown");
      await held; return { ...request, status: "complete" };
    });
    await Promise.resolve();
    expect(f.authority.getRevocation("revoke-owner")?.status).toBe("revoking");
    release(); expect((await completing).status).toBe("complete");
  });
  it("reports unknown on timeout, wrong epoch or unrelated barrier acknowledgment", async () => {
    for (const failure of ["timeout", "epoch", "revocation"]) {
      const f = await fixture(); await f.approve(); await f.authority.beginInvalidation("revoke", [required(f.refs[1])]);
      const result = await f.authority.finishInvalidation("revoke", async request => {
        if (failure === "timeout") throw Error("timeout");
        return { ...request, status: "complete", ...(failure === "epoch" ? { deploymentEpoch: "other" } : { revocationId: "other" }) };
      });
      expect(result.status).toBe("revocation_outcome_unknown");
      expect((await f.redeem()).status).toBe("rejected");
      const restarted = new FixtureAuthority(f.storage, f.options);
      expect((await restarted.finishInvalidation("revoke", f.barrier)).status).toBe("complete");
    }
  });
  it("does not regress a confirmed complete barrier after another request times out", async () => {
    const f = await fixture(); await f.approve(); await f.authority.beginInvalidation("revoke", [required(f.refs[1])]);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const late = f.authority.finishInvalidation("revoke", async () => { await held; throw Error("late timeout"); });
    expect((await f.authority.finishInvalidation("revoke", f.barrier)).status).toBe("complete");
    release(); expect((await late).status).toBe("complete");
  });
  it("performs the source mutation only after the durable tombstone and reports barrier uncertainty", async () => {
    const f = await fixture(); await f.approve();
    const mutate = vi.fn(async () => {
      expect(f.storage.transactionOpen).toBe(false);
      expect((await f.redeem()).status).toBe("rejected");
      return "source-updated";
    });
    const result = await mutateAfterOperatorInvalidation({ authority: f.authority, revocationId: "source-revoke", sources: f.sourceRefs([required(f.refs[2])]), mutate,
      barrier: async () => { throw Error("lost barrier reply"); } });
    expect(mutate).toHaveBeenCalledOnce();
    expect(result.result).toBe("source-updated"); expect(result.revocation.status).toBe("revocation_outcome_unknown");
  });
  it("does not mutate the source after an uncertain tombstone commit and leaves failed source updates denied", async () => {
    const f = await fixture(); await f.approve(); const mutate = vi.fn(async () => "changed");
    f.storage.failCommitAcknowledgment = true;
    await expect(mutateAfterOperatorInvalidation({ authority: f.authority, revocationId: "lost-tombstone", sources: f.sourceRefs([required(f.refs[2])]), mutate, barrier: f.barrier })).rejects.toThrow();
    expect(mutate).not.toHaveBeenCalled(); expect((await f.redeem()).status).toBe("rejected");
    const g = await fixture(); await g.approve();
    await expect(mutateAfterOperatorInvalidation({ authority: g.authority, revocationId: "source-failed", sources: g.sourceRefs([required(g.refs[2])]), mutate: async () => { throw Error("source unavailable"); }, barrier: g.barrier })).rejects.toThrow();
    expect((await g.redeem()).status).toBe("rejected"); expect(g.authority.getRevocation("source-failed")?.status).toBe("revoking");
  });
  it("makes idempotent invalidation IDs immutable and rolls back a mixed stale invalidation", async () => {
    const f = await fixture(); await f.approve();
    await f.authority.beginInvalidation("once", [required(f.refs[1])]);
    await expect(f.authority.beginInvalidation("once", [required(f.refs[2])])).rejects.toThrow();
    const g = await fixture(); await g.approve();
    await expect(g.authority.beginInvalidation("mixed", [required(g.refs[1]), { ...required(g.refs[2]), version: 2 }])).rejects.toThrow();
    expect((await g.redeem()).status).toBe("admitted");
  });
});


describe("coordinated legacy source mutation fencing", () => {
  it("blocks regrant during a pending or uncertain barrier, including after restart", async () => {
    const f = await fixture(); await f.approve();
    const record = required(f.records[2]), refs = [required(f.refs[2])];
    await f.authority.beginInvalidation("principal-revoke", refs);
    const replacement = { ...record, version: 2 };
    await expect(f.authority.installAuthority(replacement, 1)).rejects.toThrow();
    expect((await f.authority.finishInvalidation("principal-revoke", async () => { throw Error("timeout"); })).status)
      .toBe("revocation_outcome_unknown");
    const restarted = new FixtureAuthority(f.storage, f.options);
    await expect(restarted.installAuthority(replacement, 1)).rejects.toThrow();
    await restarted.finishInvalidation("principal-revoke", f.barrier);
    await restarted.installAuthority(replacement, 1);
    expect((await f.redeem()).status).toBe("rejected");
  });

  it("does not let completion of one invalidation bypass another incomplete invalidation", async () => {
    const f = await fixture(); await f.approve(); const refs = [required(f.refs[2])];
    await f.authority.beginInvalidation("first", refs);
    await f.authority.beginInvalidation("second", refs);
    await f.authority.finishInvalidation("second", f.barrier);
    await expect(f.authority.installAuthority({ ...required(f.records[2]), version: 2 }, 1)).rejects.toThrow();
    await f.authority.finishInvalidation("first", f.barrier);
    await f.authority.installAuthority({ ...required(f.records[2]), version: 2 }, 1);
  });

  it("claims a source write once before concurrent callers or recovery can complete revocation", async () => {
    const f = await fixture(); await f.approve(); const refs = [required(f.refs[2])];
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const writing = new Promise<void>(resolve => { reached = resolve; });
    const mutate = vi.fn(async () => { reached(); await held; return "source-updated"; });
    const input = { authority: f.authority, revocationId: "token-revoke", sources: f.sourceRefs(refs), mutate, barrier: f.barrier };
    const pending = mutateAfterOperatorInvalidation(input);
    await writing;
    const restarted = new FixtureAuthority(f.storage, f.options);
    try {
      await expect(mutateAfterOperatorInvalidation({ ...input, authority: restarted })).rejects.toThrow("already_started");
      await expect(mutateAfterOperatorInvalidation({ ...input, revocationId: "different-id" })).rejects.toThrow();
      expect((await restarted.finishInvalidation(input.revocationId, f.barrier)).status).toBe("revocation_outcome_unknown");
      expect(f.barrier).not.toHaveBeenCalled();
      await expect(restarted.installAuthority({ ...required(f.records[2]), version: 2 }, 1)).rejects.toThrow();
      expect((await f.redeem()).status).toBe("rejected");
    } finally { release(); }
    expect((await pending).revocation.status).toBe("complete");
    expect(mutate).toHaveBeenCalledOnce();
    await expect(mutateAfterOperatorInvalidation(input)).rejects.toThrow("already_started");
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("cannot revive a generation while the source write durability acknowledgment is held", async () => {
    const f = await fixture(); await f.approve(); let release!: () => void, reached!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { reached = resolve; });
    let calls = 0;
    f.storage.sync = async () => { if (++calls === 2) { reached(); await held; } };
    const pending = mutateAfterOperatorInvalidation({ authority: f.authority, revocationId: "held-source-ack",
      sources: f.sourceRefs([required(f.refs[2])]), mutate: async () => "source-updated", barrier: f.barrier });
    await waiting;
    try {
      expect(f.barrier).not.toHaveBeenCalled();
      await expect(f.authority.installAuthority({ ...required(f.records[2]), version: 2 }, 1)).rejects.toThrow();
    } finally { release(); }
    expect((await pending).revocation.status).toBe("complete");
  });

  it.each(["before-write", "after-write"])("does not repeat a failed source mutation %s", async phase => {
    const f = await fixture(); await f.approve(); let writes = 0;
    const mutate = vi.fn(async () => { if (phase === "after-write") writes++; throw Error("source outcome uncertain"); });
    const input = { authority: f.authority, revocationId: "uncertain-source", sources: f.sourceRefs([required(f.refs[2])]), mutate, barrier: f.barrier };
    await expect(mutateAfterOperatorInvalidation(input)).rejects.toThrow("source outcome uncertain");
    const restarted = new FixtureAuthority(f.storage, f.options);
    await expect(mutateAfterOperatorInvalidation({ ...input, authority: restarted })).rejects.toThrow("already_started");
    expect((await restarted.finishInvalidation(input.revocationId, f.barrier)).status).toBe("revocation_outcome_unknown");
    expect(f.barrier).not.toHaveBeenCalled(); expect(mutate).toHaveBeenCalledOnce();
    expect(writes).toBe(phase === "after-write" ? 1 : 0);
    expect((await f.redeem()).status).toBe("rejected");
  });

  it("retains the one-shot source claim after lost tombstone durability acknowledgment", async () => {
    const f = await fixture(); await f.approve(); const mutate = vi.fn(async () => "source-updated");
    const input = { authority: f.authority, revocationId: "uncertain-tombstone", sources: f.sourceRefs([required(f.refs[2])]), mutate, barrier: f.barrier };
    f.storage.sync = async () => { throw Error("lost durability acknowledgment"); };
    await expect(mutateAfterOperatorInvalidation(input)).rejects.toThrow("lost durability acknowledgment");
    f.storage.sync = async () => {};
    const restarted = new FixtureAuthority(f.storage, f.options);
    await expect(mutateAfterOperatorInvalidation({ ...input, authority: restarted })).rejects.toThrow("already_started");
    expect((await restarted.finishInvalidation(input.revocationId, f.barrier)).status).toBe("revocation_outcome_unknown");
    expect(mutate).not.toHaveBeenCalled(); expect(f.barrier).not.toHaveBeenCalled();
  });

  it("recovers a lost source acknowledgment by draining only, never repeating the source write", async () => {
    const f = await fixture(); await f.approve(); let calls = 0;
    const mutate = vi.fn(async () => "source-updated");
    const input = { authority: f.authority, revocationId: "source-ack-lost", sources: f.sourceRefs([required(f.refs[2])]), mutate, barrier: f.barrier };
    f.storage.sync = async () => { if (++calls === 2) throw Error("lost source acknowledgment"); };
    await expect(mutateAfterOperatorInvalidation(input)).rejects.toThrow("lost source acknowledgment");
    const restarted = new FixtureAuthority(f.storage, f.options);
    await expect(mutateAfterOperatorInvalidation({ ...input, authority: restarted })).rejects.toThrow("already_started");
    expect((await restarted.finishInvalidation(input.revocationId, f.barrier)).status).toBe("complete");
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("allows only barrier recovery after a source write succeeded but the sibling reply was lost", async () => {
    const f = await fixture(); await f.approve(); const mutate = vi.fn(async () => "source-updated");
    const input = { authority: f.authority, revocationId: "source-done", sources: f.sourceRefs([required(f.refs[2])]), mutate,
      barrier: async (): Promise<OperatorBarrierReply> => { throw Error("lost sibling reply"); } };
    expect((await mutateAfterOperatorInvalidation(input)).revocation.status).toBe("revocation_outcome_unknown");
    const restarted = new FixtureAuthority(f.storage, f.options);
    await expect(mutateAfterOperatorInvalidation({ ...input, authority: restarted })).rejects.toThrow("already_started");
    expect((await restarted.finishInvalidation(input.revocationId, f.barrier)).status).toBe("complete");
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("rejects old revocation IDs and resolves current authority instead of stale caller versions", async () => {
    const f = await fixture(); await f.approve(); const refs = [required(f.refs[2])];
    await f.authority.beginInvalidation("old-revocation", refs);
    await f.authority.finishInvalidation("old-revocation", f.barrier);
    const mutate = vi.fn(async () => "source-updated");
    const input = { authority: f.authority, revocationId: "old-revocation", sources: f.sourceRefs(refs), mutate, barrier: f.barrier };
    await expect(mutateAfterOperatorInvalidation(input)).rejects.toThrow("already_started");
    await f.authority.installAuthority({ ...required(f.records[2]), version: 2 }, 1);
    const changed = await mutateAfterOperatorInvalidation({ ...input, revocationId: "new-id" });
    expect(changed.revocation.references).toEqual([{ ...required(f.refs[2]), version: 2 }]);
    await expect(mutateAfterOperatorInvalidation({ ...input, revocationId: "stale-source" })).rejects.toThrow();
    expect(mutate).toHaveBeenCalledOnce();
  });
});


describe("strict accepted execution provenance and parent capabilities", () => {
  it("hashes the full immutable tuple without accepting review-only consent", async () => {
    const f = await fixture(), record = f.records.find(record => record.kind === "enrollment");
    if (record?.kind !== "enrollment") throw Error("fixture enrollment missing");
    const p = record.provenance;
    expect(await operatorEnrollmentConnectionId(p)).toBe(f.envelope.connectionId);
    for (const change of [
      { recordVersion: 2 }, { enrollmentGeneration: 2 }, { rawConnectionId: "other-account" },
      { upstreamRevision: "other-revision" }, { deploymentEpoch: "other-epoch" }, { manifestDigest: "4".repeat(64) },
      { expiresAt: p.expiresAt + 1 }, { proposal: { ...p.proposal, proposalId: "proposal-two" } },
      { acceptance: { ...p.acceptance, acceptanceId: "acceptance-two" } },
      { operations: [{ ...p.operations[0], executorHash: "5".repeat(64) }] },
    ]) expect(await operatorEnrollmentConnectionId({ ...p, ...change } as OperatorExecutionEnrollment)).not.toBe(f.envelope.connectionId);
    await expect(operatorEnrollmentConnectionId({ ...p, acceptance: { ...p.acceptance, purpose: "review_only" } } as unknown as OperatorExecutionEnrollment)).rejects.toThrow();
    await expect(operatorEnrollmentConnectionId({ ...p, reviewOnly: true } as OperatorExecutionEnrollment)).rejects.toThrow();
    await expect(operatorEnrollmentConnectionId({ ...p, apiKey: "fixture-not-real" } as OperatorExecutionEnrollment)).rejects.toThrow();
  });
  it("requires a new proposal, owner acceptance and enrollment generation on regrant", async () => {
    const f = await fixture(), record = f.records.find(record => record.kind === "enrollment");
    if (record?.kind !== "enrollment") throw Error("fixture enrollment missing");
    await f.authority.beginInvalidation("regrant", [{ kind: record.kind, id: record.id, version: record.version }]);
    const provenance = { ...record.provenance, recordVersion: 2 };
    await expect(f.authority.installAuthority({ ...record, version: 2, provenance, connectionId: await operatorEnrollmentConnectionId(provenance) }, 1)).rejects.toThrow();
    const accepted = { ...provenance, enrollmentGeneration: 2,
      proposal: { ...provenance.proposal, proposalId: "proposal-two" },
      acceptance: { ...provenance.acceptance, acceptanceId: "acceptance-two" } };
    await f.authority.finishInvalidation("regrant", f.barrier);
    await f.authority.installAuthority({ ...record, version: 2, enrollmentGeneration: 2, provenance: accepted, connectionId: await operatorEnrollmentConnectionId(accepted) }, 1);
  });
  it("authenticates stage-scoped capabilities with an existing parent key and rejects tampering", async () => {
    const f = await fixture();
    const key = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(7), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    const otherKey = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(8), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    const capability = await signOperatorRedeemCapability(key, f.capability);
    expect(await verifyOperatorRedeemCapability(key, capability)).toEqual(f.capability);
    await expect(verifyOperatorRedeemCapability(otherKey, capability)).rejects.toThrow();
    const pieces = capability.split(".");
    await expect(verifyOperatorRedeemCapability(key, `v2.${pieces[1]}.${pieces[2]}`)).rejects.toThrow();
    await expect(verifyOperatorRedeemCapability(key, `${capability}.extra`)).rejects.toThrow();
    await expect(signOperatorRedeemCapability(key, { ...f.capability, stage: "status" } as unknown as OperatorRedeemCapability)).rejects.toThrow();
  });
  it("requires durable acknowledgment before returning admission or starting a source mutation", async () => {
    const f = await fixture(); await f.approve();
    f.storage.sync = async () => { throw Error("durability unconfirmed"); };
    await expect(f.redeem()).rejects.toThrow("durability unconfirmed");
    const g = await fixture(); await g.approve(); const mutate = vi.fn(async () => "changed");
    g.storage.sync = async () => { throw Error("durability unconfirmed"); };
    await expect(mutateAfterOperatorInvalidation({ authority: g.authority, revocationId: "flush-failed", sources: g.sourceRefs([required(g.refs[2])]), mutate, barrier: g.barrier })).rejects.toThrow();
    expect(mutate).not.toHaveBeenCalled();
  });
});

class SiblingStorage implements OperatorSqlStorage {
  readonly db = new DatabaseSync(":memory:");
  syncHook?: () => Promise<void>;
  readonly sql = { exec: <T extends Record<string, unknown>>(query: string, ...values: unknown[]): Iterable<T> =>
    this.db.prepare(query).all(...values as (string | number | null)[]) as T[] };
  transactionSync<T>(work: () => T): T {
    this.db.exec("BEGIN"); try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  async sync() { await this.syncHook?.(); }
}
async function jointFixture() {
  const f = await fixture(), siblingStorage = new SiblingStorage(), store = new OperatorInvocationStore(siblingStorage), owner = new CoordinatedOwner();
  store.recover(); store.initializeEpoch(f.envelope.deploymentEpoch);
  const provider = vi.fn<typeof fetch>(async () => Response.json({ file: { name: "Synthetic Figma", last_touched_at: "2026-11-07T00:00:00Z" } }));
  const gateway = new OperatorGateway({
    owner, store, deploymentEpoch: f.envelope.deploymentEpoch, versionId: f.envelope.versionId, manifestDigest: f.envelope.manifestDigest,
    parent: f.authority, now: () => NOW,
    capture: async input => ({ tokenExpiresAt: NOW + 7000,
      request: prepareOperatorFigmaRequest(input,
        { id: input.rawConnectionId, revision: input.upstreamRevision, service: "figma", connection_name: input.personalAlias, source: "local", value: "enc:worker:v1:fixture" },
        { id: input.rawConnectionId, revision: input.upstreamRevision, service: "figma", connectionName: input.personalAlias,
          credential: { authType: "api_key", apiKey: "figd_fixture_key_not_real_123456789", values: { apiKey: "figd_fixture_key_not_real_123456789" } } }, provider) }),
  });
  return { ...f, siblingStorage, gateway, provider, store, execute: () => gateway.execute(f.envelope, `oct_${"a".repeat(43)}`, "fixture-redeem-capability") };
}

describe("joint parent and sibling SQLite protocol fixtures", () => {
  it("dispatches a frozen human-approved operation once across both durable stores", async () => {
    const f = await jointFixture(); await f.approve();
    expect((await f.execute()).state).toBe("completed");
    expect((await f.execute()).state).toBe("completed"); expect(f.provider).toHaveBeenCalledOnce();
    expect((await f.redeem()).status).toBe("unknown");
  });
  it.each(["missing", "revoked"])("never reaches provider with %s parent authority", async state => {
    const f = await jointFixture();
    if (state === "revoked") { await f.approve(); await f.authority.beginInvalidation("revoke", [required(f.refs[1])]); }
    expect((await f.execute()).state).toBe("rejected_before_admission"); expect(f.provider).not.toHaveBeenCalled();
  });
  it("does not deadlock when revocation wins before the sibling asks for admission", async () => {
    const f = await jointFixture(); await f.approve();
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    f.siblingStorage.syncHook = async () => { if (++calls === 1) { entered(); await held; } };
    const running = f.execute(); await reached;
    await f.authority.beginInvalidation("revoke-before-redeem", [required(f.refs[2])]);
    let complete = false;
    const barrier = f.authority.finishInvalidation("revoke-before-redeem", request => f.gateway.barrier(request)).then(value => { complete = true; return value; });
    await Promise.resolve(); expect(complete).toBe(false);
    release(); expect((await running).state).toBe("rejected_before_admission");
    expect((await barrier).status).toBe("complete"); expect(f.provider).not.toHaveBeenCalled();
  });
  it("does not report revocation complete while an earlier admitted call can still begin transport", async () => {
    const f = await jointFixture(); await f.approve();
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    f.siblingStorage.syncHook = async () => { if (++calls === 3) { entered(); await held; } };
    const running = f.execute(); await reached;
    await f.authority.beginInvalidation("revoke-after-redeem", [required(f.refs[2])]);
    const barrier = f.authority.finishInvalidation("revoke-after-redeem", request => f.gateway.barrier(request));
    await Promise.resolve(); expect(f.authority.getRevocation("revoke-after-redeem")?.status).toBe("revoking");
    expect(f.provider).not.toHaveBeenCalled(); release();
    expect((await running).state).toBe("completed"); expect((await barrier).status).toBe("complete");
    expect(f.provider).toHaveBeenCalledOnce();
  });
  it("retains uncertainty on both sides after an admitted acknowledgment is lost", async () => {
    const f = await jointFixture(); await f.approve(); f.storage.failCommitAcknowledgment = true;
    expect((await f.execute()).state).toBe("unknown"); expect((await f.execute()).state).toBe("unknown");
    expect((await f.redeem()).status).toBe("unknown"); expect(f.provider).not.toHaveBeenCalled();
  });
});


describe("authoritative legacy source registry (fixture-only migration prerequisite)", () => {
  it("requires mandatory source mapping on the real writer; legacy references cannot select a source-write subset", async () => {
    const f = await fixture(); const parent = new OperatorParentAuthority(f.storage, f.options);
    await expect(parent.installAuthority({ ...required(f.records[1]), id: "new-employee" }, 0,
      undefined as unknown as OperatorSourceReference[])).rejects.toThrow();
    await expect(parent.beginSourceMutation("old-reference-api", f.refs as unknown as OperatorSourceReference[])).rejects.toThrow();
    expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM operator_parent_source_mutations").get()?.n).toBe(0);
  });

  it("resolves all actor, resource and role grants across actors, without truncating at approval's 32-reference bound", async () => {
    const f = await fixture(); await f.approve(); const grant = required(f.records[4]);
    for (let n = 0; n < 40; n++) {
      if (grant.kind !== "actor_grant") throw Error("fixture grant missing");
      await f.authority.installAuthority({ ...grant, id: `other-actor-${n}`, principalId: `other-principal-${n}` }, 0);
    }
    const revocation = await f.authority.beginSourceMutation("workspace-grant-replacement", fixtureSources(grant));
    expect(revocation.references).toHaveLength(43);
    expect(new Set(revocation.references.map(ref => ref.kind))).toEqual(new Set(["actor_grant", "resource_grant", "role_grant"]));
    expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM operator_parent_authority WHERE state='tombstoned'").get()?.n).toBe(43);
    expect(await f.redeem()).toEqual({ status: "rejected" });
    expect(revocation.deploymentEpochs).toEqual(["epoch-one"]);
  });

  it("fences even an unused source before a new authority ID can be installed", async () => {
    const f = await fixture(); const employee = { ...required(f.records[1]), id: "unused-employee" };
    const source = required(fixtureSources(employee)[0]);
    await f.authority.registerLegacySource({ ...source, revision: "definition-one" });
    const revocation = await f.authority.beginSourceMutation("unused-change", [source]);
    expect(revocation.references).toEqual([]);
    await expect(f.authority.installAuthority(employee, 0)).rejects.toThrow();
    const restarted = new FixtureAuthority(f.storage, f.options);
    await expect(restarted.installAuthority(employee, 0)).rejects.toThrow();
    expect((await restarted.finishInvalidation("unused-change", f.barrier)).status).toBe("revocation_outcome_unknown");
    await restarted.acknowledgeSourceMutation("unused-change");
    await restarted.finishInvalidation("unused-change", f.barrier);
    await expect(restarted.installAuthority(employee, 0)).rejects.toThrow();
    await restarted.advanceLegacySource({ ...source, generation: 2, revision: "definition-two" }, 1);
    await restarted.installAuthority(employee, 0, [{ ...source, generation: 2 }]);
    await expect(restarted.beginSourceMutation("stale-unused-change", [source])).rejects.toThrow();
  });

  it("blocks new grant IDs while source acknowledgment or barriers are unresolved", async () => {
    const f = await fixture(); await f.approve(); const grant = required(f.records[4]), sources = fixtureSources(grant);
    await f.authority.beginSourceMutation("grant-change", sources);
    await expect(f.authority.installAuthority({ ...grant, id: "fresh-grant" }, 0)).rejects.toThrow();
    await expect(f.authority.advanceLegacySource({ ...required(sources[0]), generation: 2, revision: "two" }, 1)).rejects.toThrow();
    await f.authority.acknowledgeSourceMutation("grant-change");
    await f.authority.finishInvalidation("grant-change", async () => { throw Error("barrier unavailable"); });
    await expect(f.authority.advanceLegacySource({ ...required(sources[0]), generation: 2, revision: "two" }, 1)).rejects.toThrow();
    await f.authority.finishInvalidation("grant-change", f.barrier);
    await expect(f.authority.installAuthority({ ...grant, id: "fresh-grant" }, 0)).rejects.toThrow();
    const next = { ...required(sources[0]), generation: 2 };
    await f.authority.advanceLegacySource({ ...next, revision: "two" }, 1);
    await f.authority.installAuthority({ ...grant, id: "fresh-grant" }, 0, [next]);
    expect(await f.redeem()).toEqual({ status: "rejected" });
    await expect(f.authority.beginSourceMutation("old-generation", sources)).rejects.toThrow();
  });

  it("rolls back both authority and links if any source is unknown or a write fails", async () => {
    const f = await fixture(); const context = { ...required(f.records[3]), id: "new-context" };
    const sources = fixtureSources(context); required(sources[1]).generation = 2;
    await expect(f.authority.installAuthority(context, 0, sources)).rejects.toThrow();
    expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM operator_authority_sources WHERE id='new-context'").get()?.n).toBe(0);
    expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM operator_parent_authority WHERE id='new-context'").get()?.n).toBe(0);
    const sql = f.storage.sql.exec;
    f.storage.sql.exec = (query, ...bindings) => {
      if (query.includes("INSERT INTO operator_parent_authority")) throw Error("fixture authority write failed");
      return sql(query, ...bindings);
    };
    await expect(f.authority.installAuthority(context, 0)).rejects.toThrow("fixture authority write failed");
    expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM operator_authority_sources WHERE id='new-context'").get()?.n).toBe(0);
  });

  it("rolls back a multi-source claim if one generation is stale, without issuing a write permit", async () => {
    const f = await fixture(); await f.approve();
    const sources = fixtureSources(required(f.records[3])); required(sources[1]).generation = 2;
    await expect(f.authority.beginSourceMutation("mixed-sources", sources)).rejects.toThrow();
    expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM operator_legacy_sources WHERE state='changing'").get()?.n).toBe(0);
    expect(f.authority.getRevocation("mixed-sources")).toBeNull();
    expect((await f.redeem()).status).toBe("admitted");
  });

  it("requires both session and run mappings and denies a missing map at redemption", async () => {
    const f = await fixture(); await f.approve(); const context = { ...required(f.records[3]), id: "new-context" };
    await expect(f.authority.installAuthority(context, 0, fixtureSources(context).slice(0, 1))).rejects.toThrow();
    f.storage.db.prepare("DELETE FROM operator_authority_sources WHERE kind='execution_context' AND source_key LIKE '%session%'").run();
    expect(await f.redeem()).toEqual({ status: "rejected" });
    await expect(f.authority.recordHumanApproval({ ...f.approval, envelope: { ...f.envelope, approvalId: "new-approval" } })).rejects.toThrow();
  });

  it.each(["session", "run"])("a %s mutation resolves every dependent execution context", async kind => {
    const f = await fixture(); await f.approve();
    await f.authority.installAuthority({ ...required(f.records[3]), id: "other-context" }, 0);
    const sources = fixtureSources(required(f.records[3])).filter(ref => ref.source.kind === kind);
    expect((await f.authority.beginSourceMutation(`${kind}-deletion`, sources)).references.map(ref => ref.id).sort())
      .toEqual(["context-one", "other-context"]);
    expect(await f.redeem()).toEqual({ status: "rejected" });
  });

  it("does not confuse owner, workspace, token instances or source generations", async () => {
    const f = await fixture(); const token = required(fixtureSources(required(f.records[2]))[0]);
    if (token.source.kind !== "principal_token") throw Error("fixture token missing");
    for (const bad of [
      { ...token, source: { ...token.source, namespaceId: "other-namespace" } },
      { ...token, source: { ...token.source, tokenInstanceId: "other-token" } },
      { ...token, generation: 2 },
    ]) await expect(f.authority.beginSourceMutation("bad-token", [bad])).rejects.toThrow();
    const grant = required(f.records[4]); const source = required(fixtureSources(grant)[0]);
    if (source.source.kind !== "employee_grants") throw Error("fixture grant source missing");
    await expect(f.authority.beginSourceMutation("bad-workspace", [{ ...source, source: { ...source.source, workspaceId: "other-workspace" } }])).rejects.toThrow();
    expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM operator_parent_source_mutations").get()?.n).toBe(0);
  });

  it("checks exact connector identity and upstream revision before creating an enrollment mapping", async () => {
    const f = await fixture(); const enrollment = required(f.records[0]);
    if (enrollment.kind !== "enrollment") throw Error("fixture enrollment missing");
    await f.authority.beginInvalidation("regrant-exact", [required(f.refs[0])]); await f.authority.finishInvalidation("regrant-exact", f.barrier);
    const provenance = { ...enrollment.provenance, recordVersion: 2, enrollmentGeneration: 2,
      proposal: { ...enrollment.provenance.proposal, proposalId: "proposal-two" },
      acceptance: { ...enrollment.provenance.acceptance, acceptanceId: "acceptance-two" } };
    const replacement = { ...enrollment, version: 2, enrollmentGeneration: 2, provenance, connectionId: await operatorEnrollmentConnectionId(provenance) };
    const source = required(fixtureSources(enrollment)[0]);
    if (source.source.kind !== "connector_account") throw Error("fixture connector missing");
    const wrong = { ...source, source: { ...source.source, provider: "other-provider" } };
    await f.authority.registerLegacySource({ ...wrong, revision: enrollment.upstreamRevision, rawConnectionId: enrollment.rawConnectionId });
    await expect(f.authority.installAuthority(replacement, 1, [wrong])).rejects.toThrow();
    f.storage.db.prepare("UPDATE operator_legacy_sources SET revision='rotated' WHERE source_key LIKE '%connector_account%'").run();
    await expect(f.authority.installAuthority(replacement, 1, [source])).rejects.toThrow();
  });

  it("snapshots mappings before async enrollment validation and rechecks source fencing afterward", async () => {
    const f = await fixture(); const enrollment = required(f.records[0]);
    if (enrollment.kind !== "enrollment") throw Error("fixture enrollment missing");
    const provenance = { ...enrollment.provenance, enrollmentId: "new-enrollment" };
    const fresh = { ...enrollment, id: "new-enrollment", provenance, connectionId: await operatorEnrollmentConnectionId(provenance) };
    const sources = fixtureSources(enrollment);
    const pending = f.authority.installAuthority(fresh, 0, sources);
    const revocation = f.authority.beginSourceMutation("racing-enrollment", sources);
    sources.length = 0;
    await revocation;
    await expect(pending).rejects.toThrow();
    expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM operator_parent_authority WHERE id='new-enrollment'").get()?.n).toBe(0);
  });

  it("recognizes equivalent source keys irrespective of object property insertion order", async () => {
    const f = await fixture(); const ref = required(fixtureSources(required(f.records[2]))[0]);
    const source = Object.fromEntries(Object.entries(ref.source).reverse()) as typeof ref.source;
    expect((await f.authority.beginSourceMutation("canonical-source", [{ ...ref, source }])).references).toEqual([required(f.refs[2])]);
    await expect(f.authority.registerLegacySource({ source, generation: 1, revision: "another" })).rejects.toThrow();
  });

  it("rejects duplicate/unknown fields and never stores secret-shaped extra metadata", async () => {
    const f = await fixture(), source = required(fixtureSources(required(f.records[2]))[0]);
    await expect(f.authority.beginSourceMutation("duplicate", [source, source])).rejects.toThrow();
    await expect(f.authority.beginSourceMutation("extra", [{ ...source, references: [] } as OperatorSourceReference])).rejects.toThrow();
    await expect(f.authority.registerLegacySource({ ...source, revision: "one", apiKey: "fixture-secret-must-not-store" } as Parameters<OperatorParentAuthority["registerLegacySource"]>[0])).rejects.toThrow();
    await expect(f.authority.beginSourceMutation("token-label", [{ ...source, source: { ...source.source, label: "label-only" } } as unknown as OperatorSourceReference])).rejects.toThrow();
    expect(JSON.stringify(f.storage.db.prepare("SELECT * FROM operator_legacy_sources").all())).not.toContain("fixture-secret");
  });

  it("does not silently backfill a populated legacy store or treat a schema marker as activation", async () => {
    const f = await fixture(); await f.approve();
    f.storage.db.exec("DROP TABLE operator_source_registry_meta; DROP TABLE operator_legacy_sources; DROP TABLE operator_authority_sources;");
    const restarted = new OperatorParentAuthority(f.storage, f.options);
    expect(restarted.sourceRegistryInitialized()).toBe(false);
    expect(await restarted.redeem(f.request())).toEqual({ status: "rejected" });
    const source = required(fixtureSources(required(f.records[2]))[0]);
    await expect(restarted.registerLegacySource({ ...source, revision: "cannot-import" })).rejects.toThrow();
    await expect(restarted.beginSourceMutation("cannot-guess", [source])).rejects.toThrow();
    expect(OPERATOR_PARENT_PRODUCTION_READY).toBe(false);
  });

  it("rejects a newer/unknown registry format instead of attempting an implicit migration", async () => {
    const f = await fixture(); await f.approve();
    f.storage.db.exec("UPDATE operator_source_registry_meta SET format='future-unknown-format'");
    const restarted = new OperatorParentAuthority(f.storage, f.options);
    expect(restarted.sourceRegistryInitialized()).toBe(false);
    expect(await restarted.redeem(f.request())).toEqual({ status: "rejected" });
  });

  it("shares one durable deny before provider admission and preserves one-shot replay after restart", async () => {
    const f = await jointFixture(); await f.approve(); const sources = fixtureSources(required(f.records[4]));
    const mutate = vi.fn(async () => "updated-workspace-grants");
    const result = await mutateAfterOperatorInvalidation({ authority: f.authority, sources, revocationId: "joint-source-change", mutate, barrier: f.barrier });
    expect(result.revocation.references).toHaveLength(3);
    expect((await f.execute()).state).toBe("rejected_before_admission");
    expect(f.provider).not.toHaveBeenCalled();
    const restarted = new OperatorParentAuthority(f.storage, f.options);
    await expect(mutateAfterOperatorInvalidation({ authority: restarted, sources, revocationId: "joint-source-change", mutate, barrier: f.barrier })).rejects.toThrow("already_started");
    expect(mutate).toHaveBeenCalledOnce();
    expect(f.provider).not.toHaveBeenCalled();
  });
});

describe("physical legacy identity, not authority ownership or runtime labels", () => {
  it("fences one credential slot across deployment epochs and includes both sibling barriers", async () => {
    const f = await fixture(), enrollment = required(f.records[0]);
    if (enrollment.kind !== "enrollment") throw Error("fixture enrollment missing");
    const provenance = { ...enrollment.provenance, enrollmentId: "enrollment-epoch-two", deploymentEpoch: "epoch-two" };
    const other = { ...enrollment, id: provenance.enrollmentId, deploymentEpoch: provenance.deploymentEpoch,
      provenance, connectionId: await operatorEnrollmentConnectionId(provenance) };
    await f.authority.installAuthority(other, 0);
    expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM operator_legacy_sources WHERE source_key LIKE '%connector_account%'").get()?.n).toBe(1);
    const revocation = await f.authority.beginSourceMutation("rotate-shared-slot", fixtureSources(enrollment));
    expect(revocation.references.map(ref => ref.id).sort()).toEqual(["enrollment-epoch-two", "enrollment-one"]);
    expect(revocation.deploymentEpochs).toEqual(["epoch-one", "epoch-two"]);
    const freshProvenance = { ...provenance, enrollmentId: "fresh-epoch-two" };
    await expect(f.authority.installAuthority({ ...other, id: freshProvenance.enrollmentId, provenance: freshProvenance,
      connectionId: await operatorEnrollmentConnectionId(freshProvenance) }, 0)).rejects.toThrow();
    await f.authority.acknowledgeSourceMutation("rotate-shared-slot");
    await f.authority.finishInvalidation("rotate-shared-slot", f.barrier);
    expect(f.barrier.mock.calls.map(([request]) => request.deploymentEpoch)).toEqual(["epoch-one", "epoch-two"]);
  });

  it("invalidates workspace policy shared across authority owners, including employee definitions", async () => {
    for (const kind of ["employee", "actor_grant"] as const) {
      const f = await fixture(), original = required(f.records.find(record => record.kind === kind));
      // The physical employee definition ID is immutable, so separate owner
      // grants (which can have independent authority IDs) demonstrate fanout.
      if (kind === "employee") {
        await expect(f.authority.registerLegacySource({ ...required(fixtureSources(original)[0]), revision: "duplicate-owner-label" })).rejects.toThrow();
        continue;
      }
      const other = { ...original, id: "owner-two-actor-grant", ownerId: "owner-two" };
      await f.authority.installAuthority(other, 0);
      const revocation = await f.authority.beginSourceMutation("shared-policy-change", fixtureSources(original));
      expect(revocation.references.map(ref => ref.id)).toContain(other.id);
      expect(revocation.references).toHaveLength(4);
      await expect(f.authority.installAuthority({ ...other, id: "fresh-owner-two-grant" }, 0)).rejects.toThrow();
    }
  });

  it("retains the same slot fence when native deletion/recreation changes the raw row ID", async () => {
    const f = await fixture(), old = required(f.records[0]);
    if (old.kind !== "enrollment") throw Error("fixture enrollment missing");
    const source = required(fixtureSources(old)[0]);
    await f.authority.beginSourceMutation("delete-recreate", [source]);
    await f.authority.acknowledgeSourceMutation("delete-recreate"); await f.authority.finishInvalidation("delete-recreate", f.barrier);
    const nextSource = { ...source, generation: 2 };
    await f.authority.advanceLegacySource({ ...nextSource, revision: "revision-recreated", rawConnectionId: "raw-recreated" }, 1);
    const provenance = { ...old.provenance, recordVersion: 2, enrollmentGeneration: 2,
      rawConnectionId: "raw-recreated", upstreamRevision: "revision-recreated",
      proposal: { ...old.provenance.proposal, proposalId: "recreated-proposal" },
      acceptance: { ...old.provenance.acceptance, acceptanceId: "recreated-acceptance" } };
    const next = { ...old, version: 2, enrollmentGeneration: 2, provenance,
      rawConnectionId: provenance.rawConnectionId, upstreamRevision: provenance.upstreamRevision,
      connectionId: await operatorEnrollmentConnectionId(provenance) };
    await expect(f.authority.installAuthority(next, 1, [source])).rejects.toThrow();
    await f.authority.installAuthority(next, 1, [nextSource]);
    await expect(f.authority.beginSourceMutation("stale-native-row", [source])).rejects.toThrow();
    expect((await f.authority.beginSourceMutation("recreated-mutation", [nextSource])).references)
      .toEqual([{ kind: "enrollment", id: old.id, version: 2 }]);
    expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM operator_legacy_sources WHERE source_key LIKE '%connector_account%'").get()?.n).toBe(1);
  });
});

describe("registered-source admission races", () => {
  it("keeps the real sibling barrier pending without deadlock when source mutation wins", async () => {
    const f = await jointFixture(); await f.approve();
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    f.siblingStorage.syncHook = async () => { if (++calls === 1) { entered(); await held; } };
    const running = f.execute(); await reached;
    const sources = fixtureSources(required(f.records[4]));
    let complete = false;
    const mutation = mutateAfterOperatorInvalidation({ authority: f.authority, sources, revocationId: "source-wins", mutate: async () => "fixture-written",
      barrier: request => f.gateway.barrier(request) }).then(value => { complete = true; return value; });
    await Promise.resolve(); await Promise.resolve();
    expect(complete).toBe(false);
    release(); expect((await running).state).toBe("rejected_before_admission");
    expect((await mutation).revocation.status).toBe("complete");
    expect(f.provider).not.toHaveBeenCalled();
  });

  it("does not report source revocation complete until an admitted sibling has begun or lost dispatch", async () => {
    const f = await jointFixture(); await f.approve();
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    f.siblingStorage.syncHook = async () => { if (++calls === 3) { entered(); await held; } };
    const running = f.execute(); await reached;
    let complete = false;
    const mutation = mutateAfterOperatorInvalidation({ authority: f.authority, sources: fixtureSources(required(f.records[4])), revocationId: "admission-wins",
      mutate: async () => "fixture-written", barrier: request => f.gateway.barrier(request) }).then(value => { complete = true; return value; });
    await Promise.resolve(); await Promise.resolve();
    expect(complete).toBe(false); expect(f.provider).not.toHaveBeenCalled();
    release(); expect((await running).state).toBe("completed");
    expect((await mutation).revocation.status).toBe("complete");
    expect(f.provider).toHaveBeenCalledOnce();
    await f.execute(); expect(f.provider).toHaveBeenCalledOnce();
  });

  it("never implicitly migrates a store containing only permanent old tombstones", async () => {
    const f = await fixture(); await f.authority.beginInvalidation("retained-deny", [required(f.refs[1])]);
    f.storage.db.exec("DELETE FROM operator_parent_authority; DROP TABLE operator_source_registry_meta; DROP TABLE operator_legacy_sources; DROP TABLE operator_authority_sources;");
    const restarted = new OperatorParentAuthority(f.storage, f.options);
    expect(restarted.sourceRegistryInitialized()).toBe(false);
    await expect(restarted.registerLegacySource({ ...required(fixtureSources(required(f.records[1]))[0]), revision: "old-store" })).rejects.toThrow();
  });

  it("retains generation CAS after a lost advance acknowledgment and cannot reissue an old source mutation", async () => {
    const f = await fixture(), source = required(fixtureSources(required(f.records[2]))[0]);
    await f.authority.beginSourceMutation("source-cas", [source]);
    await f.authority.acknowledgeSourceMutation("source-cas"); await f.authority.finishInvalidation("source-cas", f.barrier);
    f.storage.sync = async () => { throw Error("lost generation acknowledgment"); };
    await expect(f.authority.advanceLegacySource({ ...source, generation: 2, revision: "second" }, 1)).rejects.toThrow("lost generation acknowledgment");
    f.storage.sync = async () => {};
    const restarted = new OperatorParentAuthority(f.storage, f.options);
    await expect(restarted.advanceLegacySource({ ...source, generation: 2, revision: "second" }, 1)).rejects.toThrow();
    await expect(restarted.beginSourceMutation("old-source-generation", [source])).rejects.toThrow();
    expect(f.storage.db.prepare("SELECT generation FROM operator_legacy_sources WHERE source_key LIKE '%principal_token%'").get()?.generation).toBe(2);
  });
});


describe("source identity lookup", () => {
  it("returns only non-secret generation metadata, never a stale-snapshot mutation permit", async () => {
    const f = await fixture(), ref = required(fixtureSources(required(f.records[2]))[0]);
    if (ref.source.kind !== "principal_token") throw Error("fixture source missing");
    const snapshot = f.authority.lookupLegacySource(ref.source);
    expect(snapshot).toEqual({ ...ref, revision: "source-revision-one", state: "active", revocationId: null });
    expect(f.authority.lookupLegacySource({ ...ref.source, tokenInstanceId: "unknown-token" })).toBeNull();
    await f.authority.beginSourceMutation("lookup-change", [ref]);
    expect(f.authority.lookupLegacySource(ref.source)?.state).toBe("changing");
    await expect(f.authority.beginSourceMutation("stale-lookup", [ref])).rejects.toThrow();
    expect(snapshot?.state).toBe("active"); // Returned objects are detached snapshots.
    await f.authority.acknowledgeSourceMutation("lookup-change"); await f.authority.finishInvalidation("lookup-change", f.barrier);
    await f.authority.advanceLegacySource({ ...ref, generation: 2, revision: "second" }, 1);
    expect(f.authority.lookupLegacySource(ref.source)?.generation).toBe(2);
    await expect(f.authority.beginSourceMutation("stale-generation-lookup", [ref])).rejects.toThrow();
  });
});
