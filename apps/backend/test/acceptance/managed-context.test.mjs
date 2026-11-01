import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { verifyManagedContextApproval, verifyManagedContextDraft } from "./managed-context.mjs";

const sourceRef = { id: `memsrc_${"ab".repeat(12)}`, version: 3, sha256: "cd".repeat(32) };
const snapshot = { sources: [{ ...sourceRef, title: "Brand", content: "Orion facts", contentTruncated: false, citations: [{ sourceId: sourceRef.id, version: 3, sha256: sourceRef.sha256, lineStart: 3, lineEnd: 3, text: "Orion facts", textTruncated: false }] }] };
const context = { sourceIds: [sourceRef.id], sourceRefs: [sourceRef], snapshot, citation: `[source:${sourceRef.id}@v3:L3 sha256:${sourceRef.sha256}]` };
const goal = { draftTaskId: "draft-goal", version: 7, runId: "local:owned", approvalId: "approval-owned", sessionId: "12345678-1234-1234-1234-123456789abc" };
const text = `Internal draft\n${context.citation}\n`;
const fileFor = (content) => ({ path: "drafts/brief.md", bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex"), provenance: { onboarding: { draftTaskId: goal.draftTaskId, version: goal.version, sources: context.sourceRefs } } });
const runFor = (file) => ({ status: "completed", draftTaskId: goal.draftTaskId, draftTaskVersion: goal.version, onboardingSourceSnapshot: structuredClone(snapshot), deliverables: [file] });

test("draft proof checks raw bytes and provenance without claiming semantic validation", async () => {
  const reports = [];
  const file = fileFor(text);
  const result = await verifyManagedContextDraft({
    context, goal, report: (item) => reports.push(item),
    api: async (path) => { assert.equal(path, `/api/runs/local%3Aowned?session=${goal.sessionId}`); return { run: runFor(file) }; },
    page: { evaluate: async (_fn, path) => { assert.equal(path, `/api/runs/local%3Aowned/deliverables/0?session=${goal.sessionId}`); return { status: 200, bytes: [...Buffer.from(text)] }; } },
  });
  assert.equal(result.literalCitationPresent, true);
  assert.equal(result.semanticCitationValidation, false);
  assert.equal(reports[0].status, "passed");
});

for (const failure of ["source-version", "goal-version", "missing-citation", "wrong-download-bytes"]) {
  test(`draft proof rejects ${failure}`, async () => {
    const content = failure === "missing-citation" ? "Uncited internal draft" : text;
    const run = runFor(fileFor(content));
    if (failure === "source-version") run.onboardingSourceSnapshot.sources[0].version += 1;
    if (failure === "goal-version") run.draftTaskVersion += 1;
    await assert.rejects(() => verifyManagedContextDraft({
      context, goal, report: () => assert.fail("Failed proof must not report passed"),
      api: async () => ({ run }),
      page: { evaluate: async () => ({ status: 200, bytes: [...Buffer.from(failure === "wrong-download-bytes" ? "corrupt" : content)] }) },
    }));
  });
}

test("approval proof preserves frozen bytes after revoking future selection", async () => {
  let disabled = false;
  const approval = { approvalId: goal.approvalId, draftTaskId: goal.draftTaskId, draftTaskVersion: goal.version, onboardingSourceSnapshot: structuredClone(snapshot) };
  await verifyManagedContextApproval({
    context, goal, disableAfterFreeze: true, report: (item) => assert.equal(item.futureSelectionRevoked, true),
    api: async (path, init) => {
      if (path.startsWith("/api/approvals")) return { approvals: [approval] };
      assert.equal(path, `/api/memory/sources/${sourceRef.id}`);
      assert.equal(init.method, "PATCH");
      assert.deepEqual(JSON.parse(init.body), { enabled: false });
      disabled = true;
      return { source: { disabledAt: 1 } };
    },
    page: { evaluate: async () => { assert.equal(disabled, true); return { status: 400 }; } },
  });
  assert.deepEqual(approval.onboardingSourceSnapshot, snapshot);
});

test("employee draft proof checks its source-read goal binding", async () => {
  const file = fileFor(text);
  const employeeDraftId = `draft_${"ef".repeat(32)}`;
  const draft = { id: employeeDraftId, draftTaskId: goal.draftTaskId, draftTaskVersion: goal.version, onboardingSourceSnapshot: snapshot,
    source: { draftTaskId: goal.draftTaskId, draftTaskVersion: goal.version, onboardingSourceSnapshot: snapshot, sourceMessageIds: ["message-fixture"] },
    deliverable: file, downloadUrl: `/api/employee-drafts/${employeeDraftId}/download?session=${goal.sessionId}` };
  await verifyManagedContextDraft({ context, goal: { ...goal, employeeDraftId }, report: () => {}, api: async () => ({ drafts: [draft] }), page: { evaluate: async () => ({ status: 200, bytes: [...Buffer.from(text)] }) } });
  draft.source.draftTaskVersion += 1;
  await assert.rejects(() => verifyManagedContextDraft({ context, goal: { ...goal, employeeDraftId }, report: () => assert.fail("Mismatched source receipt must fail"), api: async () => ({ drafts: [draft] }), page: { evaluate: async () => assert.fail("Do not download mismatched provenance") } }));
});
