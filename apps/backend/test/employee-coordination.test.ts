import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  EmployeeCoordinationLedger, EMPLOYEE_COORDINATION_PRODUCTION_READY, employeeCoordinationUnavailable,
  type CoordinationStorage, type CoordinationRoot, type CoordinationReference, type CoordinationCaller,
  type CoordinationHuman, type CoordinationRequest, type CoordinationReceipt,
} from "../src/employee-coordination.js";

class Storage implements CoordinationStorage {
  db = new DatabaseSync(":memory:");
  failSync = false;
  failInsert = false;
  sql = { exec: <T extends Record<string, unknown>>(query: string, ...bindings: (string | number | null)[]) => {
    if (this.failInsert && query.startsWith("INSERT INTO employee_coordination_proposals")) { this.failInsert = false; throw Error("fixture insert failed"); }
    const rows = this.db.prepare(query).all(...bindings) as T[];
    return { toArray: () => rows };
  } };
  transactionSync<T>(callback: () => T): T {
    this.db.exec("BEGIN");
    let result: T;
    try { result = callback(); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return result;
  }
  async sync() { if (this.failSync) { this.failSync = false; throw Error("fixture sync uncertain"); } }
}
function required<T>(value: T | undefined): T { if (value === undefined) throw Error("missing fixture"); return value; }
const NOW = 2_000_000_000_000;
const scope = { tenantId: "self-hosted", workspaceId: "team-one", roomId: "room-one" };
async function fixture(options: { maxHandoffs?: number; maxPerParent?: number; maxDepth?: number } = {}) {
  const storage = new Storage();
  let now = NOW;
  const root: CoordinationRoot = {
    scope, rootId: "root-one", taskId: "task-one", humanUserId: "alice@example.test", humanAuthorizationId: "root-consent",
    contextId: "context-one", contextDigest: "a".repeat(64),
    rootRun: { runId: "run-one", approvalId: "approval-root", employeeId: "writer", profileVersion: 1 },
    targets: ["writer", "reviewer", "analyst", "designer", "researcher", "editor"].map(employeeId => ({ employeeId, profileVersion: 1, ownerUserId: "bob@example.test" })),
    dependencies: [], limits: { maxDepth: 4, maxHandoffs: 10, maxPerParent: 4, ...options },
    expiresAt: NOW + 60_000, purpose: "coordination_review_only",
  };
  root.dependencies = [
    { kind: "workspace_member", subjectId: root.humanUserId, version: 1 },
    { kind: "room_member", subjectId: `human:${root.humanUserId}`, version: 1 },
    { kind: "workspace_member", subjectId: "bob@example.test", version: 1 },
    { kind: "human_authorization", subjectId: root.humanAuthorizationId, version: 1 },
    { kind: "human_authorization", subjectId: root.rootRun.approvalId, version: 1 },
    { kind: "context", subjectId: root.contextId, version: 1 },
    { kind: "run", subjectId: root.rootRun.runId, version: 1 },
    ...root.targets.flatMap(t => [
      { kind: "room_member" as const, subjectId: `agent:${t.employeeId}`, version: 1 },
      { kind: "employee_profile" as const, subjectId: t.employeeId, version: 1 },
    ]),
  ];
  let caller: CoordinationCaller = { scope, rootId: root.rootId, parentId: root.rootId, humanUserId: root.humanUserId, ...root.rootRun };
  let human: CoordinationHuman = { scope, humanUserId: root.humanUserId, kind: "human" };
  const verify = {
    caller: vi.fn(async (proof: string) => { if (proof !== "caller-proof") throw Error("unauthenticated caller"); return structuredClone(caller); }),
    human: vi.fn(async (proof: string) => { if (proof !== "human-proof") throw Error("unauthenticated human"); return structuredClone(human); }),
    now: () => now,
  };
  let ledger = new EmployeeCoordinationLedger(storage, verify);
  for (const ref of root.dependencies) await ledger.installAuthority(scope, ref, 0, NOW + 60_000);
  await ledger.registerRoot(root);
  const request = (proposalId = "proposal-one", targetEmployeeId = "reviewer"): CoordinationRequest => ({ proposalId, targetEmployeeId, task: "Review the implementation.", context: "Only this explicit shared context." });
  const propose = (proposalId?: string, targetEmployeeId?: string) => ledger.propose("caller-proof", request(proposalId, targetEmployeeId));
  const decision = (r: CoordinationReceipt, approved = true, approvalId = `approval-${r.proposal.proposalId}`) => ({ proposalId: r.proposal.proposalId, proposalDigest: r.proposalDigest, approvalId, approved });
  const approve = (r: CoordinationReceipt) => ledger.decide("human-proof", decision(r));
  const observe = async (r: CoordinationReceipt, expiresAt = NOW + 60_000) => {
    const runReference: CoordinationReference = { kind: "run", subjectId: `run-${r.proposal.proposalId}`, version: 1 };
    await ledger.installAuthority(scope, runReference, 0, expiresAt);
    const executionApprovalReference: CoordinationReference = { kind: "human_authorization", subjectId: `execution-${r.proposal.proposalId}`, version: 1 };
    await ledger.installAuthority(scope, executionApprovalReference, 0, expiresAt);
    await ledger.observeApprovedRun({ proposalId: r.proposal.proposalId, proposalDigest: r.proposalDigest, reviewApprovalId: `approval-${r.proposal.proposalId}`, executionApprovalId: executionApprovalReference.subjectId, executionApprovalReference,
      runId: runReference.subjectId, runReference, humanUserId: root.humanUserId, employeeId: r.proposal.targetEmployeeId, profileVersion: r.proposal.targetProfileVersion });
    caller = { scope, rootId: root.rootId, parentId: r.proposal.proposalId, humanUserId: root.humanUserId, runId: runReference.subjectId,
      approvalId: executionApprovalReference.subjectId, employeeId: r.proposal.targetEmployeeId, profileVersion: r.proposal.targetProfileVersion };
  };
  return { storage, root, verify, request, propose, approve, observe, decision,
    get ledger() { return ledger; }, restart: () => { ledger = new EmployeeCoordinationLedger(storage, verify); },
    setCaller: (patch: Partial<CoordinationCaller>) => { caller = { ...caller, ...patch }; },
    setHuman: (patch: Partial<CoordinationHuman>) => { human = { ...human, ...patch }; }, setNow: (value: number) => { now = value; },
    spent: () => storage.db.prepare("SELECT spent FROM employee_coordination_roots").get()?.spent,
    count: () => storage.db.prepare("SELECT count(*) AS count FROM employee_coordination_proposals").get()?.count,
  };
}

describe("disabled named employee coordination foundation", () => {
  it("never enables execution and exposes no dispatcher or agent approval path", async () => {
    expect(EMPLOYEE_COORDINATION_PRODUCTION_READY).toBe(false);
    const response = employeeCoordinationUnavailable();
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ executionAvailable: false, code: "employee_coordination_disabled" });
    const f = await fixture();
    const r = await f.propose();
    expect(r).toMatchObject({ status: "pending_review", executionAvailable: false, proposal: {
      originalHumanUserId: f.root.humanUserId, originalHumanAuthorizationId: f.root.humanAuthorizationId,
      callerEmployeeId: "writer", targetEmployeeId: "reviewer", targetProfileVersion: 1,
      parentRunId: "run-one", parentApprovalId: "approval-root", depth: 1, ancestors: ["root-one"],
      employeePath: ["writer", "reviewer"], grantedCapabilities: [],
    } });
    expect(await f.approve(r)).toMatchObject({ status: "approved_review_only", executionAvailable: false });
    expect(f.count()).toBe(1);
  });

  it.each(["actorId", "humanUserId", "rootId", "parentId", "approvalId", "grantedCapabilities", "budget", "depth", "profileVersion", "personalExecution", "repoUrl", "runtime"])("rejects model-supplied authority field %s", async field => {
    const f = await fixture();
    await expect(f.ledger.propose("caller-proof", { ...f.request(), [field]: "forged" })).rejects.toThrow();
    expect(f.spent()).toBe(0);
  });

  it.each(["runId", "approvalId", "employeeId", "humanUserId", "rootId", "parentId"] as const)("binds the authenticated caller's %s", async field => {
    const f = await fixture(); f.setCaller({ [field]: "foreign" });
    await expect(f.propose()).rejects.toThrow(); expect(f.count()).toBe(0);
  });
  it("rejects foreign workspace, profile revision, unavailable target and failed caller proof", async () => {
    for (const patch of [{ scope: { ...scope, workspaceId: "other" } }, { profileVersion: 2 }]) {
      const f = await fixture(); f.setCaller(patch); await expect(f.propose()).rejects.toThrow();
    }
    const f = await fixture();
    await expect(f.propose("missing", "outside-directory")).rejects.toThrow("target");
    await expect(f.ledger.propose("human-proof", f.request())).rejects.toThrow("unauthenticated");
  });

  it.each(["workspace_member", "room_member", "employee_profile", "human_authorization", "context", "run"] as const)("fences current %s revisions at proposal and human review", async kind => {
    const f = await fixture(); const r = await f.propose();
    const ref = required(f.root.dependencies.find(item => item.kind === kind));
    await f.ledger.invalidate(scope, ref);
    await expect(f.propose()).rejects.toThrow("revoked");
    await expect(f.approve(r)).rejects.toThrow("revoked");
    await f.ledger.installAuthority(scope, { ...ref, version: ref.version + 1 }, ref.version, NOW + 60_000);
    await expect(f.propose()).rejects.toThrow("revoked");
    expect(f.spent()).toBe(1);
  });

  it("requires complete authority coverage, exact target versions and immutable root identity", async () => {
    const f = await fixture();
    await expect(f.ledger.registerRoot({ ...f.root, dependencies: f.root.dependencies.filter(r => r.kind !== "employee_profile") })).rejects.toThrow("dependencies");
    await expect(f.ledger.registerRoot({ ...f.root, rootRun: { ...f.root.rootRun, profileVersion: 2 } })).rejects.toThrow("root_run");
    await expect(f.ledger.registerRoot({ ...f.root, limits: { ...f.root.limits, maxHandoffs: 32 } })).rejects.toThrow("conflict");
    await f.ledger.registerRoot(f.root);
    await expect(f.ledger.registerRoot({ ...f.root, rootId: "another-root" })).rejects.toThrow();
  });

  it("deduplicates identical concurrent requests and survives a ledger restart without refunding", async () => {
    const f = await fixture({ maxHandoffs: 1 });
    const replies = await Promise.all(Array.from({ length: 8 }, () => f.propose()));
    expect(new Set(replies.map(r => r.proposalDigest)).size).toBe(1);
    expect(f.count()).toBe(1); expect(f.spent()).toBe(1);
    f.restart(); expect(await f.propose()).toEqual(replies[0]);
    await expect(f.propose("second")).rejects.toThrow("budget");
  });

  it.each(["task", "context", "targetEmployeeId"] as const)("rejects changed %s under an existing replay ID", async field => {
    const f = await fixture(); await f.propose();
    await expect(f.ledger.propose("caller-proof", { ...f.request(), [field]: field === "targetEmployeeId" ? "analyst" : "changed" })).rejects.toThrow("conflict");
    expect(f.spent()).toBe(1);
  });

  it("enforces per-parent capacity under concurrent fanout", async () => {
    const f = await fixture({ maxPerParent: 2 });
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => f.propose(`proposal-${index}`)));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(2);
    expect(f.count()).toBe(2); expect(f.spent()).toBe(2);
  });

  it("enforces aggregate root capacity across different parents", async () => {
    const f = await fixture({ maxHandoffs: 2 }); const first = await f.propose(); await f.approve(first); await f.observe(first);
    await f.propose("second", "analyst");
    await expect(f.propose("third", "designer")).rejects.toThrow("budget");
    expect(f.spent()).toBe(2);
  });

  it("keeps rejected IDs and their budget permanently spent", async () => {
    const f = await fixture({ maxHandoffs: 1 }); const r = await f.propose();
    await f.ledger.decide("human-proof", f.decision(r, false));
    expect(await f.propose()).toMatchObject({ status: "rejected" });
    await expect(f.approve(r)).rejects.toThrow("decision_conflict");
    await expect(f.propose("second")).rejects.toThrow("budget");
  });

  it("rolls back a failed insert and never spends a budget without its proposal", async () => {
    const f = await fixture(); f.storage.failInsert = true;
    await expect(f.propose()).rejects.toThrow("fixture insert failed");
    expect(f.spent()).toBe(0); expect(f.count()).toBe(0);
    await f.propose(); expect(f.spent()).toBe(1);
  });

  it("does not duplicate or refund a committed request after an uncertain durability acknowledgment", async () => {
    const f = await fixture(); f.storage.failSync = true;
    await expect(f.propose()).rejects.toThrow("sync uncertain");
    f.restart(); expect(await f.propose()).toMatchObject({ status: "pending_review" });
    expect(f.count()).toBe(1); expect(f.spent()).toBe(1);
  });

  it("requires original authenticated human, exact proposal digest and a new approval ID", async () => {
    const f = await fixture(); const r = await f.propose();
    await expect(f.ledger.decide("caller-proof", f.decision(r))).rejects.toThrow("unauthenticated human");
    f.setHuman({ humanUserId: "bob@example.test" }); await expect(f.approve(r)).rejects.toThrow("human");
    f.setHuman({ humanUserId: f.root.humanUserId, scope: { ...scope, roomId: "foreign" } }); await expect(f.approve(r)).rejects.toThrow("human");
    f.setHuman({ scope });
    await expect(f.ledger.decide("human-proof", { ...f.decision(r), proposalDigest: "f".repeat(64) })).rejects.toThrow("approval");
    await expect(f.ledger.decide("human-proof", f.decision(r, true, "approval-root"))).rejects.toThrow("approval");
    const approved = await f.approve(r); expect(await f.approve(r)).toEqual(approved);
    const another = await f.propose("second");
    await expect(f.ledger.decide("human-proof", f.decision(another, true, "approval-proposal-one"))).rejects.toThrow();
  });

  it("never treats an agent identity as a human decision even if a verifier is misconfigured", async () => {
    const f = await fixture(); const r = await f.propose();
    f.verify.human.mockResolvedValueOnce({ ...await f.verify.human("human-proof"), kind: "agent" } as unknown as CoordinationHuman);
    await expect(f.approve(r)).rejects.toThrow();
  });

  it("cannot continue from a pending or reviewed-but-unobserved run", async () => {
    const f = await fixture(); const r = await f.propose();
    f.setCaller({ parentId: r.proposal.proposalId, runId: "made-up-run", approvalId: "made-up-approval", employeeId: "reviewer" });
    await expect(f.propose("next", "analyst")).rejects.toThrow();
    await f.approve(r); await expect(f.propose("next", "analyst")).rejects.toThrow();
  });

  it("derives lineage from retained runs, preserves human authority and rejects employee cycles", async () => {
    const f = await fixture();
    await expect(f.propose("self", "writer")).rejects.toThrow("cycle");
    const r = await f.propose(); await f.approve(r); await f.observe(r);
    await expect(f.propose("return-to-writer", "writer")).rejects.toThrow("cycle");
    await expect(f.propose("repeat-reviewer", "reviewer")).rejects.toThrow("cycle");
    const child = await f.propose("child", "analyst");
    expect(child.proposal).toMatchObject({ depth: 2, ancestors: ["root-one", "proposal-one"], employeePath: ["writer", "reviewer", "analyst"], originalHumanUserId: f.root.humanUserId, originalHumanAuthorizationId: f.root.humanAuthorizationId });
  });

  it("limits depth independently of remaining root budget", async () => {
    const f = await fixture({ maxDepth: 1 }); const r = await f.propose(); await f.approve(r); await f.observe(r);
    await expect(f.propose("child", "analyst")).rejects.toThrow("depth");
  });

  it.each(["run", "human_authorization"] as const)("fences a revoked child %s and its descendants", async kind => {
    const f = await fixture(); const r = await f.propose(); await f.approve(r); await f.observe(r);
    const child = await f.propose("child", "analyst"); await f.approve(child); await f.observe(child);
    await f.ledger.invalidate(scope, { kind, subjectId: kind === "run" ? "run-proposal-one" : "approval-proposal-one", version: 1 });
    await expect(f.propose("descendant", "designer")).rejects.toThrow("lineage");
    await expect(f.approve(child)).rejects.toThrow("lineage");
  });

  it("cancels an entire root permanently, without requiring still-current membership to stop", async () => {
    const f = await fixture(); const r = await f.propose();
    await f.ledger.invalidate(scope, required(f.root.dependencies[0]));
    await f.ledger.cancel("human-proof", f.root.rootId); await f.ledger.cancel("human-proof", f.root.rootId);
    f.restart(); await expect(f.propose()).rejects.toThrow("inactive"); await expect(f.approve(r)).rejects.toThrow("inactive");
    await expect(f.ledger.registerRoot(f.root)).rejects.toThrow("inactive");
    expect(f.spent()).toBe(1);
  });

  it("cannot cancel another owner's root or reset an authority revision", async () => {
    const f = await fixture(); f.setHuman({ humanUserId: "mallory@example.test" });
    await expect(f.ledger.cancel("human-proof", f.root.rootId)).rejects.toThrow("human");
    const ref = required(f.root.dependencies[0]);
    await expect(f.ledger.installAuthority(scope, { ...ref, version: 2 }, 0, NOW + 60_000)).rejects.toThrow("revision");
    await expect(f.ledger.invalidate(scope, { ...ref, version: 2 })).rejects.toThrow("revision");
  });

  it("expires before proposals, replays and decisions", async () => {
    const f = await fixture(); const r = await f.propose(); f.setNow(f.root.expiresAt);
    await expect(f.propose()).rejects.toThrow("revoked"); await expect(f.approve(r)).rejects.toThrow("revoked");
  });

  it("rechecks membership after the asynchronous caller verifier", async () => {
    const f = await fixture();
    const original = await f.verify.caller("caller-proof");
    f.verify.caller.mockImplementationOnce(async () => { await f.ledger.invalidate(scope, required(f.root.dependencies[0])); return original; });
    await expect(f.propose()).rejects.toThrow("revoked"); expect(f.count()).toBe(0);
  });

  it("bounds task and context, rejects duplicate dependencies and unsafe personal execution roots", async () => {
    const f = await fixture();
    for (const request of [{ ...f.request(), task: " " }, { ...f.request(), task: "x".repeat(4001) }, { ...f.request(), context: "x".repeat(8001) }]) {
      await expect(f.ledger.propose("caller-proof", request)).rejects.toThrow();
    }
    await expect(f.ledger.registerRoot({ ...f.root, dependencies: [...f.root.dependencies, required(f.root.dependencies[0])] })).rejects.toThrow("duplicate");
    await expect(f.ledger.registerRoot({ ...f.root, purpose: "personal_execution" } as unknown as CoordinationRoot)).rejects.toThrow();
  });
  it("rechecks authority after asynchronous durability acknowledgment before disclosing a receipt", async () => {
    const f = await fixture();
    let once = true;
    f.storage.sync = async () => {
      if (once) { once = false; await f.ledger.invalidate(scope, required(f.root.dependencies[0])); }
    };
    await expect(f.propose()).rejects.toThrow("revoked");
    expect(f.count()).toBe(1); expect(f.spent()).toBe(1);
  });

  it("rechecks cancellation after the digest await before committing a proposal", async () => {
    const f = await fixture();
    const original = crypto.subtle.digest.bind(crypto.subtle);
    const hash = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
      await f.ledger.cancel("human-proof", f.root.rootId);
      return original(...args);
    });
    try { await expect(f.propose()).rejects.toThrow("inactive"); }
    finally { hash.mockRestore(); }
    expect(f.count()).toBe(0); expect(f.spent()).toBe(0);
  });

  it("does not let run observation change the exact reviewed target, human, digest or approval", async () => {
    const f = await fixture(); const r = await f.propose(); await f.approve(r);
    const runReference: CoordinationReference = { kind: "run", subjectId: "child-run", version: 1 };
    await f.ledger.installAuthority(scope, runReference, 0, NOW + 60_000);
    const executionApprovalReference: CoordinationReference = { kind: "human_authorization", subjectId: "execution-child", version: 1 };
    await f.ledger.installAuthority(scope, executionApprovalReference, 0, NOW + 60_000);
    const run = { proposalId: r.proposal.proposalId, proposalDigest: r.proposalDigest, reviewApprovalId: "approval-proposal-one", executionApprovalId: executionApprovalReference.subjectId, executionApprovalReference, runId: "child-run", runReference,
      humanUserId: f.root.humanUserId, employeeId: "reviewer", profileVersion: 1 };
    for (const patch of [{ employeeId: "analyst" }, { profileVersion: 2 }, { humanUserId: "other@example.test" },
      { proposalDigest: "b".repeat(64) }, { reviewApprovalId: "approval-root" }, { executionApprovalId: "approval-proposal-one" }, { executionApprovalId: "approval-root" }, { runId: "unobserved-run" }]) {
      await expect(f.ledger.observeApprovedRun({ ...run, ...patch })).rejects.toThrow("run");
    }
    await f.ledger.observeApprovedRun(run); await f.ledger.observeApprovedRun(run);
    await f.ledger.invalidate(scope, runReference);
    await expect(f.ledger.observeApprovedRun(run)).rejects.toThrow("run");
  });

  it("rejects replay from another parent even when task and recipient are unchanged", async () => {
    const f = await fixture(); const existing = await f.propose("shared-id", "analyst");
    const parent = await f.propose("reviewer-parent", "reviewer"); await f.approve(parent); await f.observe(parent);
    await expect(f.ledger.propose("caller-proof", f.request(existing.proposal.proposalId, "analyst"))).rejects.toThrow("conflict");
    expect(f.spent()).toBe(2);
  });

  it("rejects unbounded root expiry and prevents one root's run from opening another budget", async () => {
    const f = await fixture();
    await expect(f.ledger.registerRoot({ ...f.root, expiresAt: NOW + 3_600_001 })).rejects.toThrow("expiry");
    await expect(f.ledger.registerRoot({ ...f.root, rootId: "second-root", humanAuthorizationId: "second-consent" })).rejects.toThrow();
  });

  it("fences replay and a repeated decision after that proposal's own observed run was revoked", async () => {
    const f = await fixture(); const r = await f.propose(); await f.approve(r); await f.observe(r);
    await f.ledger.invalidate(scope, { kind: "run", subjectId: "run-proposal-one", version: 1 });
    f.setCaller({ parentId: f.root.rootId, ...f.root.rootRun });
    await expect(f.propose()).rejects.toThrow("run_revoked");
    await expect(f.approve(r)).rejects.toThrow("run_revoked");
  });

  it("recovers an identical authority installation after uncertain sync but never revives a tombstone", async () => {
    const f = await fixture(); const ref: CoordinationReference = { kind: "context", subjectId: "fresh-context", version: 2 };
    f.storage.failSync = true;
    await expect(f.ledger.installAuthority(scope, ref, 0, NOW + 60_000)).rejects.toThrow("sync uncertain");
    f.restart(); await f.ledger.installAuthority(scope, ref, 0, NOW + 60_000);
    await expect(f.ledger.installAuthority(scope, ref, 1, NOW + 60_000)).rejects.toThrow("revision");
    await f.ledger.invalidate(scope, ref);
    await expect(f.ledger.installAuthority(scope, ref, 0, NOW + 60_000)).rejects.toThrow("revision");
    await f.ledger.installAuthority(scope, { ...ref, version: 3 }, 2, NOW + 60_000);
  });

  it("requires a distinct current executable approval for observed children and fences its revocation", async () => {
    const f = await fixture(); const r = await f.propose(); await f.approve(r); await f.observe(r);
    await f.ledger.invalidate(scope, { kind: "human_authorization", subjectId: "execution-proposal-one", version: 1 });
    await expect(f.propose("next", "analyst")).rejects.toThrow("run_revoked");
    await expect(f.approve(r)).rejects.toThrow("run_revoked");
  });

  it("requires live source deadlines and refuses roots that outlive their authority", async () => {
    const f = await fixture();
    const expired: CoordinationReference = { kind: "context", subjectId: "expired-source", version: 1 };
    await expect(f.ledger.installAuthority(scope, expired, 0, NOW)).rejects.toThrow("expiry");
    const source: CoordinationReference = { kind: "context", subjectId: "short-source", version: 1 };
    await f.ledger.installAuthority(scope, source, 0, NOW + 100);
    const run: CoordinationReference = { kind: "run", subjectId: "fresh-root-run", version: 1 };
    const consent: CoordinationReference = { kind: "human_authorization", subjectId: "fresh-consent", version: 1 };
    const approval: CoordinationReference = { kind: "human_authorization", subjectId: "fresh-root-approval", version: 1 };
    for (const ref of [run, consent, approval]) await f.ledger.installAuthority(scope, ref, 0, NOW + 60_000);
    await expect(f.ledger.registerRoot({ ...f.root, rootId: "fresh-root", contextId: source.subjectId, humanAuthorizationId: consent.subjectId,
      rootRun: { ...f.root.rootRun, runId: run.subjectId, approvalId: approval.subjectId },
      dependencies: [...f.root.dependencies, source, run, consent, approval],
    })).rejects.toThrow("expiry");
    await expect(f.ledger.installAuthority(scope, source, 0, NOW + 60_000)).rejects.toThrow("revision");
  });

  it("expires observed child authority before the root without an invalidation callback", async () => {
    const f = await fixture(); const r = await f.propose(); await f.approve(r); await f.observe(r, NOW + 100);
    f.setNow(NOW + 100);
    await expect(f.propose("next", "analyst")).rejects.toThrow("run_revoked");
    await expect(f.approve(r)).rejects.toThrow("run_revoked");
  });

});
