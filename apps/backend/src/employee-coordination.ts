/**
 * Unbound review-only coordination ledger. No route, model tool, queue, transport,
 * executor or permission callback may use this as execution authority.
 * Production activation requires the writers and verifier listed in the contract.
 */
import { z } from "zod";

export const EMPLOYEE_COORDINATION_PRODUCTION_READY = false as const;
export function employeeCoordinationUnavailable(): Response {
  return Response.json({
    error: "Named employee coordination is not available in this deployment.",
    code: "employee_coordination_disabled",
    executionAvailable: EMPLOYEE_COORDINATION_PRODUCTION_READY,
  }, { status: 501, headers: { "Cache-Control": "no-store" } });
}

const id = z.string().regex(/^[A-Za-z0-9_.:@/-]{1,200}$/);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema = z.strictObject({ tenantId: id, workspaceId: id, roomId: id });
const referenceSchema = z.strictObject({
  kind: z.enum(["workspace_member", "room_member", "employee_profile", "human_authorization", "context", "run"]),
  subjectId: id, version,
});
const targetSchema = z.strictObject({ employeeId: id, profileVersion: version, ownerUserId: id });
const rootSchema = z.strictObject({
  scope: scopeSchema, rootId: id, taskId: id, humanUserId: id, humanAuthorizationId: id,
  contextId: id, contextDigest: digestSchema,
  rootRun: z.strictObject({ runId: id, approvalId: id, employeeId: id, profileVersion: version }),
  targets: z.array(targetSchema).min(1).max(32),
  dependencies: z.array(referenceSchema).min(1).max(128),
  limits: z.strictObject({ maxDepth: z.number().int().min(1).max(4), maxHandoffs: z.number().int().min(1).max(32), maxPerParent: z.number().int().min(1).max(4) }),
  expiresAt: timestamp,
  // This prototype never imports a personal account/funding grant.
  purpose: z.literal("coordination_review_only"),
});
const requestSchema = z.strictObject({
  proposalId: id, targetEmployeeId: id,
  task: z.string().trim().min(1).max(4_000),
  // Explicitly selected text only. Never inherit private transcripts or secrets.
  context: z.string().max(8_000),
});
const callerSchema = z.strictObject({
  scope: scopeSchema, rootId: id, parentId: id, humanUserId: id,
  runId: id, approvalId: id, employeeId: id, profileVersion: version,
});
const humanSchema = z.strictObject({ scope: scopeSchema, humanUserId: id, kind: z.literal("human") });
const decisionSchema = z.strictObject({ proposalId: id, proposalDigest: digestSchema, approvalId: id, approved: z.boolean() });
const observedRunSchema = z.strictObject({
  proposalId: id, proposalDigest: digestSchema, reviewApprovalId: id, executionApprovalId: id, executionApprovalReference: referenceSchema, runId: id,
  humanUserId: id, employeeId: id, profileVersion: version, runReference: referenceSchema,
});
export type CoordinationScope = z.infer<typeof scopeSchema>;
export type CoordinationReference = z.infer<typeof referenceSchema>;
export type CoordinationRoot = z.infer<typeof rootSchema>;
export type CoordinationCaller = z.infer<typeof callerSchema>;
export type CoordinationHuman = z.infer<typeof humanSchema>;
export type CoordinationRequest = z.infer<typeof requestSchema>;
export interface CoordinationStorage {
  sql: { exec<T extends Record<string, unknown> = Record<string, unknown>>(query: string, ...bindings: (string | number | null)[]): { toArray(): T[] } };
  /** One SQLite-backed Durable Object transaction. Never substitute a lease. */
  transactionSync<T>(callback: () => T): T;
  sync(): Promise<void>;
}
export interface CoordinationVerifiers {
  /** Authenticate the calling run through its pinned executor. Never parse model claims as identity. */
  caller(proof: string): Promise<CoordinationCaller>;
  /** Authenticate a fresh native human session. Agents cannot call this seam. */
  human(proof: string): Promise<CoordinationHuman>;
  now?: () => number;
}
export interface CoordinationProposal {
  format: "shiba.employee-coordination-review.v1";
  scope: CoordinationScope; rootId: string; taskId: string; parentId: string;
  originalHumanUserId: string; originalHumanAuthorizationId: string;
  parentRunId: string; parentApprovalId: string; callerEmployeeId: string; callerProfileVersion: number;
  proposalId: string; targetEmployeeId: string; targetProfileVersion: number;
  task: string; context: string; contextDigest: string;
  depth: number; ancestors: string[]; employeePath: string[]; expiresAt: number;
  /** Fixed empty: room participation and review never grant app/action/approval power. */
  grantedCapabilities: [];
}
export interface CoordinationReceipt {
  proposal: CoordinationProposal; proposalDigest: string;
  status: "pending_review" | "approved_review_only" | "rejected";
  executionAvailable: false;
}
type RootRow = Record<string, unknown> & { record_json: string; state: string; spent: number };
type NodeRow = Record<string, unknown> & { root_id: string; record_json: string; digest: string; status: CoordinationReceipt["status"]; approval_id: string | null; run_id: string | null; run_reference_json: string | null; approval_reference_json: string | null; execution_approval_id: string | null; execution_approval_reference_json: string | null };
function fail(reason: string): never { throw new Error(`employee_coordination_${reason}`); }
const scopeKey = (s: CoordinationScope) => JSON.stringify([s.tenantId, s.workspaceId, s.roomId]);
const referenceKey = (r: CoordinationReference) => JSON.stringify([r.kind, r.subjectId]);
async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}

export class EmployeeCoordinationLedger {
  private readonly now: () => number;
  constructor(private readonly storage: CoordinationStorage, private readonly verify: CoordinationVerifiers) {
    this.now = verify.now ?? Date.now;
    storage.transactionSync(() => {
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS employee_coordination_authority (
        scope TEXT NOT NULL, reference TEXT NOT NULL, version INTEGER NOT NULL, active INTEGER NOT NULL, previous_version INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY(scope,reference))`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS employee_coordination_roots (
        root_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, state TEXT NOT NULL, spent INTEGER NOT NULL,
        run_id TEXT NOT NULL UNIQUE, approval_id TEXT NOT NULL UNIQUE, authorization_id TEXT NOT NULL UNIQUE)`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS employee_coordination_proposals (
        proposal_id TEXT PRIMARY KEY, root_id TEXT NOT NULL, parent_id TEXT NOT NULL,
        record_json TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL,
        approval_id TEXT UNIQUE, run_id TEXT UNIQUE, run_reference_json TEXT, approval_reference_json TEXT, execution_approval_id TEXT UNIQUE, execution_approval_reference_json TEXT)`);
    });
  }

  /** Trusted authority writer only, not a request handler. Revisions are monotonic. */
  async installAuthority(scopeInput: CoordinationScope, referenceInput: CoordinationReference, expectedPreviousVersion: number, expiresAt: number): Promise<void> {
    const scope = scopeSchema.parse(scopeInput), ref = referenceSchema.parse(referenceInput);
    timestamp.parse(expiresAt);
    if (expiresAt <= this.now()) fail("expiry");
    if (!Number.isSafeInteger(expectedPreviousVersion) || expectedPreviousVersion < 0 || ref.version <= expectedPreviousVersion) fail("revision");
    this.storage.transactionSync(() => {
      const previous = this.authority(scope, ref);
      if (previous?.version === ref.version && previous.active === 1 && previous.previous_version === expectedPreviousVersion && previous.expires_at === expiresAt) return;
      if ((previous?.version ?? 0) !== expectedPreviousVersion || (previous && previous.active !== 0)) fail("revision");
      this.storage.sql.exec(`INSERT INTO employee_coordination_authority(scope,reference,version,active,previous_version,expires_at) VALUES(?,?,?,1,?,?)
        ON CONFLICT(scope,reference) DO UPDATE SET version=excluded.version,active=1,previous_version=excluded.previous_version,expires_at=excluded.expires_at`, scopeKey(scope), referenceKey(ref), ref.version, expectedPreviousVersion, expiresAt);
    });
    await this.storage.sync();
  }

  /** Fence before mutating membership, profile, source, original approval or run. No refunds. */
  async invalidate(scopeInput: CoordinationScope, referenceInput: CoordinationReference): Promise<void> {
    const scope = scopeSchema.parse(scopeInput), ref = referenceSchema.parse(referenceInput);
    this.storage.transactionSync(() => {
      const current = this.authority(scope, ref);
      if (!current || current.version !== ref.version) fail("revision");
      this.storage.sql.exec("UPDATE employee_coordination_authority SET active=0 WHERE scope=? AND reference=? AND version=?",
        scopeKey(scope), referenceKey(ref), ref.version);
    });
    await this.storage.sync();
  }

  /**
   * Trusted root writer only: bind retained human consent and its already approved
   * active run. This is not a consent endpoint or a way to start an execution.
   */
  async registerRoot(input: CoordinationRoot): Promise<void> {
    const root = rootSchema.parse(input);
    if (root.expiresAt > this.now() + 60 * 60 * 1000) fail("expiry");
    if (new Set(root.targets.map(t => t.employeeId)).size !== root.targets.length ||
      new Set(root.dependencies.map(referenceKey)).size !== root.dependencies.length) fail("duplicate");
    const target = root.targets.find(t => t.employeeId === root.rootRun.employeeId);
    if (!target || target.profileVersion !== root.rootRun.profileVersion || root.humanAuthorizationId === root.rootRun.approvalId) fail("root_run");
    const required: Array<[CoordinationReference["kind"], string, number?]> = [
      ["workspace_member", root.humanUserId], ["room_member", `human:${root.humanUserId}`],
      ["human_authorization", root.humanAuthorizationId], ["human_authorization", root.rootRun.approvalId], ["context", root.contextId], ["run", root.rootRun.runId],
      ...root.targets.flatMap(t => [
        ["workspace_member", t.ownerUserId], ["room_member", `agent:${t.employeeId}`],
        ["employee_profile", t.employeeId, t.profileVersion],
      ] as Array<[CoordinationReference["kind"], string, number?]>),
    ];
    if (required.some(([kind, subjectId, revision]) => !root.dependencies.some(r => r.kind === kind && r.subjectId === subjectId && (revision === undefined || revision === r.version)))) fail("dependencies");
    this.storage.transactionSync(() => {
      const previous = this.root(root.rootId);
      if (previous) {
        if (previous.record_json !== JSON.stringify(root)) fail("conflict");
        this.requireCurrent(previous);
        return;
      }
      const identityIds = [root.rootRun.approvalId, root.humanAuthorizationId];
      if (this.node(root.rootId) || this.storage.sql.exec("SELECT 1 FROM employee_coordination_proposals WHERE run_id=? OR approval_id IN (?,?) OR execution_approval_id IN (?,?)", root.rootRun.runId, ...identityIds, ...identityIds).toArray().length ||
        this.storage.sql.exec("SELECT 1 FROM employee_coordination_roots WHERE approval_id IN (?,?) OR authorization_id IN (?,?)", ...identityIds, ...identityIds).toArray().length) fail("conflict");
      this.requireCurrent({ record_json: JSON.stringify(root), state: "active", spent: 0 });
      if (root.dependencies.some(ref => (this.authority(root.scope, ref)?.expires_at ?? 0) < root.expiresAt)) fail("expiry");
      this.storage.sql.exec("INSERT INTO employee_coordination_roots(root_id,record_json,state,spent,run_id,approval_id,authorization_id) VALUES(?,?,'active',0,?,?,?)", root.rootId, JSON.stringify(root), root.rootRun.runId, root.rootRun.approvalId, root.humanAuthorizationId);
    });
    await this.storage.sync();
  }

  async propose(proof: string, input: CoordinationRequest): Promise<CoordinationReceipt> {
    // Copy before any await; mutable caller objects cannot change the reviewed bytes.
    const request = requestSchema.parse(input);
    const caller = callerSchema.parse(await this.verify.caller(proof));
    // Compute the candidate in a read-only transaction, then recheck it in the
    // committing transaction after hashing. Authority can change during the await.
    const candidate = this.storage.transactionSync(() => this.prepare(caller, request));
    const digest = await sha256(JSON.stringify(candidate));
    const result = this.storage.transactionSync(() => {
      const current = this.prepare(caller, request);
      if (JSON.stringify(current) !== JSON.stringify(candidate)) fail("changed");
      const prior = this.node(request.proposalId);
      if (prior) {
        if (prior.digest !== digest || prior.record_json !== JSON.stringify(candidate)) fail("conflict");
        this.requireLineage(this.requireCurrent(this.root(caller.rootId)), prior);
        return this.receipt(prior);
      }
      const root = this.requireCurrent(this.root(caller.rootId));
      const row = this.root(caller.rootId);
      const count = this.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM employee_coordination_proposals WHERE root_id=? AND parent_id=?", caller.rootId, caller.parentId).toArray()[0]?.count ?? 0;
      if (!row || row.spent >= root.limits.maxHandoffs || count >= root.limits.maxPerParent) fail("budget");
      this.storage.sql.exec("UPDATE employee_coordination_roots SET spent=spent+1 WHERE root_id=?", caller.rootId);
      this.storage.sql.exec(`INSERT INTO employee_coordination_proposals(proposal_id,root_id,parent_id,record_json,digest,status)
        VALUES(?,?,?,?,?,'pending_review')`, request.proposalId, caller.rootId, caller.parentId, JSON.stringify(candidate), digest);
      const saved = this.node(request.proposalId);
      if (!saved) fail("storage");
      return this.receipt(saved);
    });
    await this.storage.sync();
    // A revocation can commit while durability is being acknowledged. Do not
    // disclose even a retained review receipt after its authority changed.
    return this.storage.transactionSync(() => this.liveReceipt(result.proposal.proposalId));
  }

  /** Immutable exact review decision. It is NOT a runnable task approval. */
  async decide(proof: string, input: z.infer<typeof decisionSchema>): Promise<CoordinationReceipt> {
    const decision = decisionSchema.parse(input);
    const human = humanSchema.parse(await this.verify.human(proof));
    const result = this.storage.transactionSync(() => {
      const node = this.node(decision.proposalId);
      if (!node) fail("not_found");
      const root = this.requireCurrent(this.root(node.root_id));
      this.requireHuman(human, root);
      this.requireLineage(root, node);
      if (decision.proposalDigest !== node.digest || decision.approvalId === root.rootRun.approvalId || decision.approvalId === root.humanAuthorizationId) fail("approval");
      const status = decision.approved ? "approved_review_only" : "rejected";
      if (node.status !== "pending_review") {
        if (node.status !== status || node.approval_id !== decision.approvalId) fail("decision_conflict");
        return this.receipt(node);
      }
      const reference: CoordinationReference = { kind: "human_authorization", subjectId: decision.approvalId, version: 1 };
      if (this.authority(root.scope, reference) || this.storage.sql.exec("SELECT 1 FROM employee_coordination_proposals WHERE execution_approval_id=?", decision.approvalId).toArray().length || this.storage.sql.exec("SELECT 1 FROM employee_coordination_roots WHERE approval_id=? OR authorization_id=?", decision.approvalId, decision.approvalId).toArray().length) fail("approval");
      this.storage.sql.exec("INSERT INTO employee_coordination_authority(scope,reference,version,active,previous_version,expires_at) VALUES(?,?,1,1,0,?)", scopeKey(root.scope), referenceKey(reference), root.expiresAt);
      this.storage.sql.exec("UPDATE employee_coordination_proposals SET status=?,approval_id=?,approval_reference_json=? WHERE proposal_id=?", status, decision.approvalId, JSON.stringify(reference), decision.proposalId);
      return this.receipt({ ...node, status, approval_id: decision.approvalId, approval_reference_json: JSON.stringify(reference) });
    });
    await this.storage.sync();
    // A revocation can commit while durability is being acknowledged. Do not
    // disclose even a retained review receipt after its authority changed.
    return this.storage.transactionSync(() => this.liveReceipt(result.proposal.proposalId));
  }

  /**
   * Unbound trusted observer for tests/future integration. This does not queue,
   * approve or dispatch. Production must verify the exact executable approval and
   * source/audience/funding snapshot before supplying an observed child run.
   */
  async observeApprovedRun(input: z.infer<typeof observedRunSchema>): Promise<void> {
    const run = observedRunSchema.parse(input);
    this.storage.transactionSync(() => {
      const node = this.node(run.proposalId);
      if (!node) fail("not_found");
      const root = this.requireCurrent(this.root(node.root_id));
      this.requireLineage(root, node);
      const proposal = JSON.parse(node.record_json) as CoordinationProposal;
      if (node.status !== "approved_review_only" || node.digest !== run.proposalDigest || node.approval_id !== run.reviewApprovalId || run.executionApprovalId === run.reviewApprovalId ||
        run.executionApprovalReference.kind !== "human_authorization" || run.executionApprovalReference.subjectId !== run.executionApprovalId ||
        !this.current(root.scope, run.executionApprovalReference) ||
        this.storage.sql.exec("SELECT 1 FROM employee_coordination_roots WHERE approval_id=? OR authorization_id=?", run.executionApprovalId, run.executionApprovalId).toArray().length > 0 ||
        this.storage.sql.exec("SELECT 1 FROM employee_coordination_proposals WHERE approval_id=?", run.executionApprovalId).toArray().length > 0 ||
        root.humanUserId !== run.humanUserId || proposal.targetEmployeeId !== run.employeeId || proposal.targetProfileVersion !== run.profileVersion ||
        this.storage.sql.exec("SELECT 1 FROM employee_coordination_roots WHERE run_id=?", run.runId).toArray().length > 0 || run.runReference.kind !== "run" || run.runReference.subjectId !== run.runId || !this.current(root.scope, run.runReference)) fail("run");
      if (node.run_id && (node.run_id !== run.runId || node.run_reference_json !== JSON.stringify(run.runReference) || node.execution_approval_id !== run.executionApprovalId || node.execution_approval_reference_json !== JSON.stringify(run.executionApprovalReference))) fail("conflict");
      this.storage.sql.exec("UPDATE employee_coordination_proposals SET run_id=?,run_reference_json=?,execution_approval_id=?,execution_approval_reference_json=? WHERE proposal_id=?", run.runId, JSON.stringify(run.runReference), run.executionApprovalId, JSON.stringify(run.executionApprovalReference), run.proposalId);
    });
    await this.storage.sync();
  }

  /** Root cancellation is permanent and covers every descendant, including retries. */
  async cancel(proof: string, rootId: string): Promise<void> {
    const key = id.parse(rootId), human = humanSchema.parse(await this.verify.human(proof));
    this.storage.transactionSync(() => {
      const row = this.root(key);
      if (!row) fail("not_found");
      const root = JSON.parse(row.record_json) as CoordinationRoot;
      // The original owner can stop after removal, but cannot read or approve.
      this.requireHuman(human, root);
      this.storage.sql.exec("UPDATE employee_coordination_roots SET state='cancelled' WHERE root_id=?", key);
    });
    await this.storage.sync();
  }

  private authority(scope: CoordinationScope, ref: CoordinationReference) {
    return this.storage.sql.exec<{ version: number; active: number; previous_version: number; expires_at: number }>("SELECT version,active,previous_version,expires_at FROM employee_coordination_authority WHERE scope=? AND reference=?", scopeKey(scope), referenceKey(ref)).toArray()[0];
  }
  private current(scope: CoordinationScope, ref: CoordinationReference): boolean {
    const row = this.authority(scope, ref);
    return row?.active === 1 && row.version === ref.version && row.expires_at > this.now();
  }
  private root(rootId: string) { return this.storage.sql.exec<RootRow>("SELECT record_json,state,spent FROM employee_coordination_roots WHERE root_id=?", rootId).toArray()[0]; }
  private node(proposalId: string) { return this.storage.sql.exec<NodeRow>("SELECT * FROM employee_coordination_proposals WHERE proposal_id=?", proposalId).toArray()[0]; }
  private requireCurrent(row: RootRow | undefined): CoordinationRoot {
    if (row?.state !== "active") fail("inactive");
    const root = JSON.parse(row.record_json) as CoordinationRoot;
    if (root.expiresAt <= this.now() || root.dependencies.some(ref => !this.current(root.scope, ref))) fail("revoked");
    return root;
  }
  private requireHuman(human: CoordinationHuman, root: CoordinationRoot) {
    if (human.humanUserId !== root.humanUserId || scopeKey(human.scope) !== scopeKey(root.scope)) fail("human");
  }
  private requireLineage(root: CoordinationRoot, node: NodeRow): void {
    const proposal = JSON.parse(node.record_json) as CoordinationProposal;
    if (node.run_reference_json && (!this.current(root.scope, JSON.parse(node.run_reference_json) as CoordinationReference) ||
      !node.execution_approval_reference_json || !this.current(root.scope, JSON.parse(node.execution_approval_reference_json) as CoordinationReference))) fail("run_revoked");
    if (node.status !== "pending_review" && (!node.approval_reference_json || !this.current(root.scope, JSON.parse(node.approval_reference_json) as CoordinationReference))) fail("approval_revoked");
    for (const ancestorId of proposal.ancestors) {
      if (ancestorId === root.rootId) continue;
      const ancestor = this.node(ancestorId);
      if (!ancestor || ancestor.root_id !== root.rootId || ancestor.status !== "approved_review_only" || !ancestor.run_reference_json ||
        !this.current(root.scope, JSON.parse(ancestor.run_reference_json) as CoordinationReference) || !ancestor.approval_reference_json ||
        !this.current(root.scope, JSON.parse(ancestor.approval_reference_json) as CoordinationReference) || !ancestor.execution_approval_reference_json ||
        !this.current(root.scope, JSON.parse(ancestor.execution_approval_reference_json) as CoordinationReference)) fail("lineage");
    }
  }
  private prepare(caller: CoordinationCaller, request: CoordinationRequest): CoordinationProposal {
    const root = this.requireCurrent(this.root(caller.rootId));
    if (scopeKey(caller.scope) !== scopeKey(root.scope) || caller.humanUserId !== root.humanUserId) fail("caller");
    const parent = caller.parentId === root.rootId ? null : this.node(caller.parentId);
    let employeePath = [root.rootRun.employeeId], ancestors = [root.rootId], depth = 1;
    if (parent) {
      this.requireLineage(root, parent);
      const p = JSON.parse(parent.record_json) as CoordinationProposal;
      if (parent.root_id !== root.rootId || parent.status !== "approved_review_only" || parent.run_id !== caller.runId || parent.execution_approval_id !== caller.approvalId ||
        !parent.run_reference_json || !this.current(root.scope, JSON.parse(parent.run_reference_json) as CoordinationReference) ||
        p.targetEmployeeId !== caller.employeeId || p.targetProfileVersion !== caller.profileVersion) fail("caller");
      employeePath = p.employeePath; ancestors = [...p.ancestors, p.proposalId]; depth = p.depth + 1;
    } else if (caller.parentId !== root.rootId || caller.runId !== root.rootRun.runId || caller.approvalId !== root.rootRun.approvalId ||
      caller.employeeId !== root.rootRun.employeeId || caller.profileVersion !== root.rootRun.profileVersion) fail("caller");
    if (this.root(request.proposalId) || ancestors.includes(request.proposalId)) fail("cycle");
    const target = root.targets.find(t => t.employeeId === request.targetEmployeeId);
    if (!target) fail("target");
    if (employeePath.includes(target.employeeId)) fail("cycle");
    if (depth > root.limits.maxDepth) fail("depth");
    return {
      format: "shiba.employee-coordination-review.v1", scope: root.scope, rootId: root.rootId, taskId: root.taskId,
      parentId: caller.parentId, originalHumanUserId: root.humanUserId, originalHumanAuthorizationId: root.humanAuthorizationId,
      parentRunId: caller.runId, parentApprovalId: caller.approvalId, callerEmployeeId: caller.employeeId, callerProfileVersion: caller.profileVersion,
      ...request, targetProfileVersion: target.profileVersion, contextDigest: root.contextDigest,
      depth, ancestors, employeePath: [...employeePath, target.employeeId], expiresAt: root.expiresAt, grantedCapabilities: [],
    };
  }
  private liveReceipt(proposalId: string): CoordinationReceipt {
    const node = this.node(proposalId);
    if (!node) fail("not_found");
    this.requireLineage(this.requireCurrent(this.root(node.root_id)), node);
    return this.receipt(node);
  }
  private receipt(node: NodeRow): CoordinationReceipt {
    return { proposal: JSON.parse(node.record_json) as CoordinationProposal, proposalDigest: node.digest, status: node.status, executionAvailable: false };
  }
}
