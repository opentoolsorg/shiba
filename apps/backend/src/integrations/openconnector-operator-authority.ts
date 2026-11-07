/**
 * Parent half of the coordinated operator protocol. This is an unbound runtime
 * primitive, NOT a route or a migration of permissive legacy policy snapshots.
 * Do not activate it until every authority writer participates in this owner.
 */
import {
  parseOperatorEnvelope, operatorExact, operatorRecord,
  type OperatorExecutionEnvelope,
} from "@shiba/openconnector-read-gateway";

import { operatorEnrollmentConnectionId, type OperatorExecutionEnrollment } from "./openconnector-operator-enrollment.js";

export const OPERATOR_PARENT_PRODUCTION_READY = false as const;
export const OPERATOR_PARENT_ACTIVATION_BLOCKERS = [
  "owner enrollment and human approval must be owned by this coordinator",
  "employee, actor/resource/role grant and principal writers must invalidate first",
  "session deletion and run cancellation must invalidate first",
  "all legacy writers and older deployments must be drained",
  "sibling deployment epoch and authenticated barrier transport must be bound",
] as const;

export type OperatorAuthorityKind = "enrollment" | "employee" | "principal" | "execution_context"
  | "actor_grant" | "resource_grant" | "role_grant";
export interface OperatorAuthorityReference { kind: OperatorAuthorityKind; id: string; version: number }
interface AuthorityBase extends OperatorAuthorityReference { ownerId: string; expiresAt: number }
export interface OperatorEnrollmentAuthority extends AuthorityBase {
  kind: "enrollment";
  provenance: OperatorExecutionEnrollment;
  enrollmentGeneration: number; connectionId: string; personalAlias: string;
  provider: string; rawConnectionId: string; upstreamRevision: string;
  deploymentEpoch: string; versionId: string; manifestDigest: string;
  operations: Array<{ actionId: string; inputSchemaHash: string }>;
}
export interface OperatorEmployeeAuthority extends AuthorityBase { kind: "employee" }
export interface OperatorPrincipalAuthority extends AuthorityBase { kind: "principal" }
export interface OperatorContextAuthority extends AuthorityBase {
  kind: "execution_context"; principalId: string; employeeId: string;
}
export interface OperatorGrantAuthority extends AuthorityBase {
  kind: "actor_grant" | "resource_grant" | "role_grant";
  principalId: string; employeeId: string; enrollmentId: string; connectionId: string;
  actionIds: string[];
}
export type OperatorAuthorityRecord = OperatorEnrollmentAuthority | OperatorEmployeeAuthority
  | OperatorPrincipalAuthority | OperatorContextAuthority | OperatorGrantAuthority;

/** The decision must originate in an authenticated human approval route, not a sibling or model. */
export interface OperatorHumanApproval {
  envelope: OperatorExecutionEnvelope;
  dependencies: OperatorAuthorityReference[];
  approvedBy: string;
  approvedAt: number;
  expiresAt: number;
}
export interface OperatorRedeemCapability {
  stage: "redeem"; invocationId: string; approvalId: string; requestDigest: string;
  deploymentEpoch: string; expiresAt: number;
}
export interface OperatorAuthoritySql {
  exec<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string, ...bindings: (string | number | null)[]
  ): { toArray(): T[] };
}
/** Compatible with one SQLite-backed Durable Object; never implement with a lease. */
export interface OperatorAuthorityStorage {
  sql: OperatorAuthoritySql;
  transactionSync<T>(callback: () => T): T;
  sync(): Promise<void>;
}
export interface OperatorAuthorityOptions {
  verifyCapability(capability: string): Promise<OperatorRedeemCapability>;
  now?: () => number;
}
export type OperatorRedemption = { status: "admitted"; effectiveDeadline: number }
  | { status: "rejected" | "unknown" };
export interface OperatorBarrierRequest { deploymentEpoch: string; revocationId: string }
export interface OperatorBarrierReply extends OperatorBarrierRequest { status: "complete" }
export type OperatorRevocationStatus = "revoking" | "revocation_outcome_unknown" | "complete";
export interface OperatorRevocation {
  revocationId: string; status: OperatorRevocationStatus;
  references: OperatorAuthorityReference[]; deploymentEpochs: string[];
}

type AuthorityRow = Record<string, unknown> & { version: number; state: string; record_json: string };
type ApprovalRow = Record<string, unknown> & { record_json: string; consumed_invocation_id: string | null };
type AdmissionRow = Record<string, unknown> & { invocation_id: string; approval_id: string; request_digest: string; deployment_epoch: string };
type RevocationRow = Record<string, unknown> & { record_json: string; status: OperatorRevocationStatus };
const kinds: OperatorAuthorityKind[] = ["enrollment", "employee", "principal", "execution_context", "actor_grant", "resource_grant", "role_grant"];
const idPattern = /^[A-Za-z0-9_.:@/-]{1,200}$/;
const validId = (id: string) => typeof id === "string" && idPattern.test(id);
const validVersion = (version: number) => Number.isSafeInteger(version) && version > 0;
const validExpiry = (expiry: number) => Number.isSafeInteger(expiry) && expiry > 0;
const refKey = (ref: OperatorAuthorityReference) => JSON.stringify([ref.kind, ref.id]);
const sameRef = (a: OperatorAuthorityReference, b: OperatorAuthorityReference) => a.kind === b.kind && a.id === b.id && a.version === b.version;
const invalid = () => new Error("operator_parent_authority_invalid");
function references(value: OperatorAuthorityReference[]): OperatorAuthorityReference[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) throw invalid();
  const result = value.map(ref => {
    if (!ref || !kinds.includes(ref.kind) || !validId(ref.id) || !validVersion(ref.version)) throw invalid();
    operatorExact(operatorRecord(ref), ["kind", "id", "version"]);
    return { kind: ref.kind, id: ref.id, version: ref.version };
  }).sort((a, b) => refKey(a).localeCompare(refKey(b)));
  if (new Set(result.map(refKey)).size !== result.length) throw invalid();
  return result;
}
function validateRecord(record: OperatorAuthorityRecord): void {
  references([{ kind: record.kind, id: record.id, version: record.version }]);
  const fields = ["kind", "id", "version", "ownerId", "expiresAt"];
  if (record.kind === "enrollment") fields.push("provenance", "enrollmentGeneration", "connectionId", "personalAlias", "provider", "rawConnectionId", "upstreamRevision", "deploymentEpoch", "versionId", "manifestDigest", "operations");
  else if (record.kind === "execution_context") fields.push("principalId", "employeeId");
  else if (isGrant(record)) fields.push("principalId", "employeeId", "enrollmentId", "connectionId", "actionIds");
  operatorExact(operatorRecord(record), fields);
  if (!validId(record.ownerId) || !validExpiry(record.expiresAt)) throw invalid();
  if (record.kind === "enrollment") {
    if (!validVersion(record.enrollmentGeneration) || !/^oco_[a-f0-9]{64}$/.test(record.connectionId)
      || !/^u_[a-f0-9]{16}$/.test(record.personalAlias) || !validId(record.provider)
      || !validId(record.rawConnectionId) || !validId(record.upstreamRevision)
      || !validId(record.deploymentEpoch) || !validId(record.versionId) || !/^[a-f0-9]{64}$/.test(record.manifestDigest)
      || !record.operations.length || record.operations.length > 20
      || new Set(record.operations.map(op => op.actionId)).size !== record.operations.length
      || record.operations.some(op => !validId(op.actionId) || !/^[a-f0-9]{64}$/.test(op.inputSchemaHash))) throw invalid();
  } else if (record.kind === "execution_context") {
    if (!validId(record.principalId) || !validId(record.employeeId)) throw invalid();
  } else if (isGrant(record)) {
    if (![record.principalId, record.employeeId, record.enrollmentId, record.connectionId].every(validId)
      || !record.actionIds.length || record.actionIds.length > 20 || !record.actionIds.every(validId)
      || new Set(record.actionIds).size !== record.actionIds.length) throw invalid();
  }
}
function isGrant(record: OperatorAuthorityRecord): record is OperatorGrantAuthority {
  return record.kind === "actor_grant" || record.kind === "resource_grant" || record.kind === "role_grant";
}
function matches(record: OperatorAuthorityRecord, envelope: OperatorExecutionEnvelope): boolean {
  if (record.ownerId !== envelope.ownerId) return false;
  switch (record.kind) {
    case "enrollment": return record.id === envelope.enrollmentId
      && record.enrollmentGeneration === envelope.enrollmentGeneration
      && record.connectionId === envelope.connectionId && record.personalAlias === envelope.personalAlias
      && record.provider === envelope.provider && record.rawConnectionId === envelope.rawConnectionId
      && record.upstreamRevision === envelope.upstreamRevision && record.deploymentEpoch === envelope.deploymentEpoch
      && record.versionId === envelope.versionId && record.manifestDigest === envelope.manifestDigest
      && record.operations.some(op => op.actionId === envelope.actionId && op.inputSchemaHash === envelope.inputSchemaHash);
    case "employee": return record.id === envelope.employeeId && record.version === envelope.employeeVersion;
    case "principal": return record.id === envelope.principalId;
    case "execution_context": return record.id === envelope.executionContextId
      && record.principalId === envelope.principalId && record.employeeId === envelope.employeeId;
    default: return record.principalId === envelope.principalId && record.employeeId === envelope.employeeId
      && record.enrollmentId === envelope.enrollmentId && record.connectionId === envelope.connectionId
      && record.actionIds.includes(envelope.actionId);
  }
}

export class OperatorParentAuthority {
  private readonly now: () => number;
  constructor(private readonly storage: OperatorAuthorityStorage, private readonly options: OperatorAuthorityOptions) {
    this.now = options.now ?? Date.now;
    storage.transactionSync(() => {
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS operator_parent_authority (
        kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL,
        record_json TEXT NOT NULL, PRIMARY KEY(kind,id))`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS operator_parent_approvals (
        approval_id TEXT PRIMARY KEY, invocation_id TEXT NOT NULL UNIQUE, request_digest TEXT NOT NULL,
        record_json TEXT NOT NULL, consumed_invocation_id TEXT, consumed_at INTEGER)`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS operator_parent_admissions (
        invocation_id TEXT PRIMARY KEY, approval_id TEXT NOT NULL UNIQUE, request_digest TEXT NOT NULL,
        deployment_epoch TEXT NOT NULL, effective_deadline INTEGER NOT NULL, admitted_at INTEGER NOT NULL)`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS operator_parent_revocations (
        revocation_id TEXT PRIMARY KEY, status TEXT NOT NULL, record_json TEXT NOT NULL)`);
    });
  }

  /** Trusted coordinator writer only. A live generation can never be overwritten. */
  async installAuthority(input: OperatorAuthorityRecord, expectedPreviousVersion: number): Promise<void> {
    const record = structuredClone(input);
    validateRecord(record);
    if (record.kind === "enrollment") {
      const p = record.provenance;
      if (await operatorEnrollmentConnectionId(p) !== record.connectionId || p.enrollmentId !== record.id
        || p.recordVersion !== record.version || p.ownerId !== record.ownerId || p.expiresAt !== record.expiresAt
        || p.enrollmentGeneration !== record.enrollmentGeneration || p.personalAlias !== record.personalAlias
        || p.provider !== record.provider || p.rawConnectionId !== record.rawConnectionId || p.upstreamRevision !== record.upstreamRevision
        || p.deploymentEpoch !== record.deploymentEpoch || p.versionId !== record.versionId || p.manifestDigest !== record.manifestDigest
        || JSON.stringify(p.operations.map(({ actionId, inputSchemaHash }) => ({ actionId, inputSchemaHash }))) !== JSON.stringify(record.operations)) throw invalid();
    }
    if (!Number.isSafeInteger(expectedPreviousVersion) || expectedPreviousVersion < 0
      || record.version <= expectedPreviousVersion) throw invalid();
    this.storage.transactionSync(() => {
      const previous = this.authority(record);
      if ((!previous && expectedPreviousVersion !== 0)
        || (previous && (previous.version !== expectedPreviousVersion || previous.state !== "tombstoned"))) throw invalid();
      if (record.expiresAt <= this.now()) throw invalid();
      if (record.kind === "enrollment" && previous) {
        const old = JSON.parse(previous.record_json) as OperatorEnrollmentAuthority;
        if (record.enrollmentGeneration <= old.enrollmentGeneration || record.connectionId === old.connectionId
          || record.provenance.acceptance.acceptanceId === old.provenance.acceptance.acceptanceId
          || record.provenance.proposal.proposalId === old.provenance.proposal.proposalId) throw invalid();
      }
      this.storage.sql.exec(`INSERT INTO operator_parent_authority(kind,id,version,state,record_json)
        VALUES(?,?,?,'active',?) ON CONFLICT(kind,id) DO UPDATE SET
        version=excluded.version,state=excluded.state,record_json=excluded.record_json`,
      record.kind, record.id, record.version, JSON.stringify(record));
    });
    await this.storage.sync();
  }

  /** No import from legacy approvals/review snapshots. This lane's human decision is immutable. */
  async recordHumanApproval(input: OperatorHumanApproval): Promise<void> {
    const approval = structuredClone(input);
    operatorExact(operatorRecord(approval), ["envelope", "dependencies", "approvedBy", "approvedAt", "expiresAt"]);
    approval.envelope = await parseOperatorEnvelope(approval.envelope);
    approval.dependencies = references(approval.dependencies);
    const e = approval.envelope;
    if (approval.approvedBy !== e.ownerId || !validExpiry(approval.approvedAt)
      || !validExpiry(approval.expiresAt) || approval.approvedAt >= approval.expiresAt) throw invalid();
    this.storage.transactionSync(() => {
      const now = this.now();
      if (approval.approvedAt > now || approval.expiresAt <= now || !this.currentAuthority(approval, now)) throw invalid();
      this.storage.sql.exec(`INSERT INTO operator_parent_approvals
        (approval_id,invocation_id,request_digest,record_json) VALUES(?,?,?,?)`,
      e.approvalId, e.invocationId, e.requestDigest, JSON.stringify(approval));
    });
    await this.storage.sync();
  }

  /**
   * The sole admission linearization point. No network/callback/await occurs in
   * the transaction, and lost acknowledgments never yield another permit.
   */
  async redeem(input: {
    envelope: OperatorExecutionEnvelope; requestDigest: string; capability: string; tokenExpiresAt: number | null;
  }): Promise<OperatorRedemption> {
    const snapshot = structuredClone(input);
    let e: OperatorExecutionEnvelope, capability: OperatorRedeemCapability;
    try {
      e = await parseOperatorEnvelope(snapshot.envelope);
      if (e.requestDigest !== snapshot.requestDigest || typeof snapshot.capability !== "string"
        || !snapshot.capability || snapshot.capability.length > 4096
        || (snapshot.tokenExpiresAt !== null && !validExpiry(snapshot.tokenExpiresAt))) return { status: "rejected" };
      capability = await this.options.verifyCapability(snapshot.capability);
      if (capability.stage !== "redeem" || capability.invocationId !== e.invocationId
        || capability.approvalId !== e.approvalId || capability.requestDigest !== e.requestDigest
        || capability.deploymentEpoch !== e.deploymentEpoch || !validExpiry(capability.expiresAt)) return { status: "rejected" };
    } catch { return { status: "rejected" }; }
    // This is deliberately outside the catch above. A persistence failure can
    // have committed; its caller must retain unknown and never retry dispatch.
    const result: OperatorRedemption = this.storage.transactionSync(() => {
      const previous = this.storage.sql.exec<AdmissionRow>(
        "SELECT * FROM operator_parent_admissions WHERE invocation_id=? OR approval_id=?", e.invocationId, e.approvalId,
      ).toArray();
      if (previous.length) return { status: previous.length === 1 && previous[0]?.invocation_id === e.invocationId
        && previous[0]?.approval_id === e.approvalId && previous[0]?.request_digest === e.requestDigest ? "unknown" : "rejected" };
      const row = this.storage.sql.exec<ApprovalRow>(
        "SELECT record_json,consumed_invocation_id FROM operator_parent_approvals WHERE approval_id=?", e.approvalId,
      ).toArray()[0];
      if (!row) return { status: "rejected" };
      if (row.consumed_invocation_id !== null) return { status: "unknown" };
      const approval = JSON.parse(row.record_json) as OperatorHumanApproval;
      if (approval.envelope.invocationId !== e.invocationId || approval.envelope.requestDigest !== e.requestDigest) return { status: "rejected" };
      const now = this.now(), authority = this.currentAuthority(approval, now);
      if (!authority) return { status: "rejected" };
      const effectiveDeadline = Math.min(e.expiresAt, approval.expiresAt, capability.expiresAt,
        snapshot.tokenExpiresAt ?? Number.MAX_SAFE_INTEGER, ...authority.map(record => record.expiresAt));
      if (effectiveDeadline <= now) return { status: "rejected" };
      this.storage.sql.exec(`UPDATE operator_parent_approvals SET consumed_invocation_id=?,consumed_at=?
        WHERE approval_id=? AND consumed_invocation_id IS NULL`, e.invocationId, now, e.approvalId);
      this.storage.sql.exec(`INSERT INTO operator_parent_admissions
        (invocation_id,approval_id,request_digest,deployment_epoch,effective_deadline,admitted_at) VALUES(?,?,?,?,?,?)`,
      e.invocationId, e.approvalId, e.requestDigest, e.deploymentEpoch, effectiveDeadline, now);
      return { status: "admitted", effectiveDeadline };
    });
    await this.storage.sync();
    return result;
  }

  /** Commit and flush the denial FIRST. No transaction is held over an await. */
  async beginInvalidation(revocationId: string, input: OperatorAuthorityReference[]): Promise<OperatorRevocation> {
    if (!validId(revocationId)) throw invalid();
    const refs = references(input);
    const result = this.storage.transactionSync(() => {
      const existing = this.getRevocation(revocationId);
      if (existing) {
        if (JSON.stringify(existing.references) !== JSON.stringify(refs)) throw invalid();
        return existing;
      }
      const epochs = new Set<string>();
      for (const ref of refs) {
        const row = this.authority(ref);
        // Stale writers may not tombstone a newer generation by accident.
        if (!row || row.version !== ref.version) throw invalid();
        const record = JSON.parse(row.record_json) as OperatorAuthorityRecord;
        if (record.kind === "enrollment") epochs.add(record.deploymentEpoch);
        this.storage.sql.exec("UPDATE operator_parent_authority SET state='tombstoned' WHERE kind=? AND id=? AND version=?", ref.kind, ref.id, ref.version);
      }
      // Frozen dependencies are the source of affected epochs. A caller cannot
      // omit a deployment or use a caller-selected current snapshot instead.
      const approvals = this.storage.sql.exec<Record<string, unknown> & { record_json: string }>(
        "SELECT record_json FROM operator_parent_approvals",
      ).toArray();
      for (const row of approvals) {
        const approval = JSON.parse(row.record_json) as OperatorHumanApproval;
        if (approval.dependencies.some(dependency => refs.some(ref => sameRef(ref, dependency)))) epochs.add(approval.envelope.deploymentEpoch);
      }
      const revocation: OperatorRevocation = {
        revocationId, status: "revoking", references: refs, deploymentEpochs: [...epochs].sort(),
      };
      this.storage.sql.exec("INSERT INTO operator_parent_revocations(revocation_id,status,record_json) VALUES(?,?,?)", revocationId, revocation.status, JSON.stringify(revocation));
      return revocation;
    });
    await this.storage.sync();
    return result;
  }

  /** May be retried after process loss; barriers never redeem or issue transport. */
  async finishInvalidation(
    revocationId: string, barrier: (input: OperatorBarrierRequest) => Promise<OperatorBarrierReply>,
  ): Promise<OperatorRevocation> {
    const revocation = this.getRevocation(revocationId);
    if (!revocation) throw invalid();
    await this.storage.sync();
    if (revocation.status === "complete") return revocation;
    let complete = true;
    // No SQL transaction or authority lock is held across the sibling call.
    for (const deploymentEpoch of revocation.deploymentEpochs) {
      try {
        const reply = await barrier({ deploymentEpoch, revocationId });
        if (reply.status !== "complete" || reply.deploymentEpoch !== deploymentEpoch || reply.revocationId !== revocationId) complete = false;
      } catch { complete = false; }
    }
    const result = this.storage.transactionSync(() => {
      const current = this.getRevocation(revocationId);
      if (!current) throw invalid();
      if (current.status !== "complete") {
        current.status = complete ? "complete" : "revocation_outcome_unknown";
        this.storage.sql.exec("UPDATE operator_parent_revocations SET status=?,record_json=? WHERE revocation_id=?", current.status, JSON.stringify(current), revocationId);
      }
      return current;
    });
    await this.storage.sync();
    return result;
  }

  getRevocation(revocationId: string): OperatorRevocation | null {
    const row = this.storage.sql.exec<RevocationRow>(
      "SELECT record_json,status FROM operator_parent_revocations WHERE revocation_id=?", revocationId,
    ).toArray()[0];
    return row ? { ...JSON.parse(row.record_json) as OperatorRevocation, status: row.status } : null;
  }

  private authority(ref: OperatorAuthorityReference): AuthorityRow | undefined {
    return this.storage.sql.exec<AuthorityRow>(
      "SELECT version,state,record_json FROM operator_parent_authority WHERE kind=? AND id=?", ref.kind, ref.id,
    ).toArray()[0];
  }
  private currentAuthority(approval: OperatorHumanApproval, now: number): OperatorAuthorityRecord[] | null {
    const e = approval.envelope, refs = approval.dependencies;
    if (approval.expiresAt <= now || e.expiresAt <= now || !kinds.every(kind => refs.some(ref => ref.kind === kind))) return null;
    if (refs.filter(ref => ["enrollment", "employee", "principal", "execution_context"].includes(ref.kind)).length !== 4) return null;
    const grants = refs.filter(ref => ref.kind.endsWith("_grant"));
    if (grants.length !== e.grantVersions.length || !e.grantVersions.every(grant => grants.some(ref => sameRef(ref, grant)))) return null;
    const result: OperatorAuthorityRecord[] = [];
    for (const ref of refs) {
      const row = this.authority(ref);
      if (row?.state !== "active" || row.version !== ref.version) return null;
      const record = JSON.parse(row.record_json) as OperatorAuthorityRecord;
      if (record.expiresAt <= now || !matches(record, e)) return null;
      result.push(record);
    }
    return result;
  }
}

/**
 * Participation adapter for a future coordinated legacy-store mutation. If
 * tombstoning is uncertain, the source mutation is not attempted. Source
 * failure leaves the deny in place. Never report complete before the barrier.
 */
export async function mutateAfterOperatorInvalidation<T>(input: {
  authority: OperatorParentAuthority; revocationId: string; references: OperatorAuthorityReference[];
  mutate: () => Promise<T>; barrier: (request: OperatorBarrierRequest) => Promise<OperatorBarrierReply>;
}): Promise<{ result: T; revocation: OperatorRevocation }> {
  await input.authority.beginInvalidation(input.revocationId, input.references);
  const result = await input.mutate();
  const revocation = await input.authority.finishInvalidation(input.revocationId, input.barrier);
  return { result, revocation };
}
