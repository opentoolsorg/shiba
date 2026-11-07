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
  const authority = new OperatorParentAuthority(storage, options);
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
  for (const record of records) await authority.installAuthority(record, 0);
  const refs: OperatorAuthorityReference[] = records.map(({ kind, id, version }) => ({ kind, id, version }));
  const approval = { envelope, dependencies: refs, approvedBy: envelope.ownerId, approvedAt: NOW, expiresAt: NOW + 8000 };
  const approve = () => authority.recordHumanApproval(approval);
  const request = () => ({ envelope, requestDigest: envelope.requestDigest, capability: "fixture-redeem-capability", tokenExpiresAt: NOW + 7000 });
  const redeem = () => authority.redeem(request());
  const barrier = vi.fn(async (input: { deploymentEpoch: string; revocationId: string }): Promise<OperatorBarrierReply> => {
    expect(storage.transactionOpen).toBe(false);
    return { ...input, status: "complete" };
  });
  return { storage, authority, options, envelope, capability, verifyCapability, records, refs, approval, approve, request, redeem, barrier, setNow: (value: number) => { now = value; } };
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
    const restarted = new OperatorParentAuthority(f.storage, f.options);
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
      const restarted = new OperatorParentAuthority(f.storage, f.options);
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
    const result = await mutateAfterOperatorInvalidation({ authority: f.authority, revocationId: "source-revoke", references: [required(f.refs[2])], mutate,
      barrier: async () => { throw Error("lost barrier reply"); } });
    expect(mutate).toHaveBeenCalledOnce();
    expect(result.result).toBe("source-updated"); expect(result.revocation.status).toBe("revocation_outcome_unknown");
  });
  it("does not mutate the source after an uncertain tombstone commit and leaves failed source updates denied", async () => {
    const f = await fixture(); await f.approve(); const mutate = vi.fn(async () => "changed");
    f.storage.failCommitAcknowledgment = true;
    await expect(mutateAfterOperatorInvalidation({ authority: f.authority, revocationId: "lost-tombstone", references: [required(f.refs[2])], mutate, barrier: f.barrier })).rejects.toThrow();
    expect(mutate).not.toHaveBeenCalled(); expect((await f.redeem()).status).toBe("rejected");
    const g = await fixture(); await g.approve();
    await expect(mutateAfterOperatorInvalidation({ authority: g.authority, revocationId: "source-failed", references: [required(g.refs[2])], mutate: async () => { throw Error("source unavailable"); }, barrier: g.barrier })).rejects.toThrow();
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
    const restarted = new OperatorParentAuthority(f.storage, f.options);
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
    const input = { authority: f.authority, revocationId: "token-revoke", references: refs, mutate, barrier: f.barrier };
    const pending = mutateAfterOperatorInvalidation(input);
    await writing;
    const restarted = new OperatorParentAuthority(f.storage, f.options);
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
      references: [required(f.refs[2])], mutate: async () => "source-updated", barrier: f.barrier });
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
    const input = { authority: f.authority, revocationId: "uncertain-source", references: [required(f.refs[2])], mutate, barrier: f.barrier };
    await expect(mutateAfterOperatorInvalidation(input)).rejects.toThrow("source outcome uncertain");
    const restarted = new OperatorParentAuthority(f.storage, f.options);
    await expect(mutateAfterOperatorInvalidation({ ...input, authority: restarted })).rejects.toThrow("already_started");
    expect((await restarted.finishInvalidation(input.revocationId, f.barrier)).status).toBe("revocation_outcome_unknown");
    expect(f.barrier).not.toHaveBeenCalled(); expect(mutate).toHaveBeenCalledOnce();
    expect(writes).toBe(phase === "after-write" ? 1 : 0);
    expect((await f.redeem()).status).toBe("rejected");
  });

  it("retains the one-shot source claim after lost tombstone durability acknowledgment", async () => {
    const f = await fixture(); await f.approve(); const mutate = vi.fn(async () => "source-updated");
    const input = { authority: f.authority, revocationId: "uncertain-tombstone", references: [required(f.refs[2])], mutate, barrier: f.barrier };
    f.storage.sync = async () => { throw Error("lost durability acknowledgment"); };
    await expect(mutateAfterOperatorInvalidation(input)).rejects.toThrow("lost durability acknowledgment");
    f.storage.sync = async () => {};
    const restarted = new OperatorParentAuthority(f.storage, f.options);
    await expect(mutateAfterOperatorInvalidation({ ...input, authority: restarted })).rejects.toThrow("already_started");
    expect((await restarted.finishInvalidation(input.revocationId, f.barrier)).status).toBe("revocation_outcome_unknown");
    expect(mutate).not.toHaveBeenCalled(); expect(f.barrier).not.toHaveBeenCalled();
  });

  it("recovers a lost source acknowledgment by draining only, never repeating the source write", async () => {
    const f = await fixture(); await f.approve(); let calls = 0;
    const mutate = vi.fn(async () => "source-updated");
    const input = { authority: f.authority, revocationId: "source-ack-lost", references: [required(f.refs[2])], mutate, barrier: f.barrier };
    f.storage.sync = async () => { if (++calls === 2) throw Error("lost source acknowledgment"); };
    await expect(mutateAfterOperatorInvalidation(input)).rejects.toThrow("lost source acknowledgment");
    const restarted = new OperatorParentAuthority(f.storage, f.options);
    await expect(mutateAfterOperatorInvalidation({ ...input, authority: restarted })).rejects.toThrow("already_started");
    expect((await restarted.finishInvalidation(input.revocationId, f.barrier)).status).toBe("complete");
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("allows only barrier recovery after a source write succeeded but the sibling reply was lost", async () => {
    const f = await fixture(); await f.approve(); const mutate = vi.fn(async () => "source-updated");
    const input = { authority: f.authority, revocationId: "source-done", references: [required(f.refs[2])], mutate,
      barrier: async (): Promise<OperatorBarrierReply> => { throw Error("lost sibling reply"); } };
    expect((await mutateAfterOperatorInvalidation(input)).revocation.status).toBe("revocation_outcome_unknown");
    const restarted = new OperatorParentAuthority(f.storage, f.options);
    await expect(mutateAfterOperatorInvalidation({ ...input, authority: restarted })).rejects.toThrow("already_started");
    expect((await restarted.finishInvalidation(input.revocationId, f.barrier)).status).toBe("complete");
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("rejects attaching a source write to an old completed revocation or stale generation", async () => {
    const f = await fixture(); await f.approve(); const refs = [required(f.refs[2])];
    await f.authority.beginInvalidation("old-revocation", refs);
    await f.authority.finishInvalidation("old-revocation", f.barrier);
    const mutate = vi.fn(async () => "source-updated");
    const input = { authority: f.authority, revocationId: "old-revocation", references: refs, mutate, barrier: f.barrier };
    await expect(mutateAfterOperatorInvalidation(input)).rejects.toThrow("already_started");
    await expect(mutateAfterOperatorInvalidation({ ...input, revocationId: "new-id" })).rejects.toThrow();
    await f.authority.installAuthority({ ...required(f.records[2]), version: 2 }, 1);
    await expect(mutateAfterOperatorInvalidation({ ...input, revocationId: "stale-source" })).rejects.toThrow();
    expect(mutate).not.toHaveBeenCalled();
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
    await expect(mutateAfterOperatorInvalidation({ authority: g.authority, revocationId: "flush-failed", references: [required(g.refs[2])], mutate, barrier: g.barrier })).rejects.toThrow();
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
