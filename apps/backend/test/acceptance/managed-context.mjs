import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const refs = (snapshot) => snapshot.sources.map(({ id, version, sha256: hash }) => ({ id, version, sha256: hash }));
const scoped = (path, sessionId) => sessionId ? `${path}?${new URLSearchParams({ session: sessionId })}` : path;

async function responseJson(page, path, init) {
  return page.evaluate(async ({ path, init }) => {
    const response = await fetch(path, { credentials: "same-origin", ...init });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }, { path, init });
}

function requireLocalOrigin(origin) {
  const url = new URL(origin);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Managed-context acceptance only runs against a local fixture.");
  return url.origin;
}

const jsonWrite = (body, method = "POST") => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function sourceArticle(page, title) {
  return page.locator("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}

async function uploadFile(page, file) {
  await page.getByLabel("TXT or Markdown file").setInputFiles(file);
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/memory/sources/upload" && item.request().method() === "POST");
  await page.getByRole("button", { name: "Upload file", exact: true }).click();
  const result = await response;
  return { status: result.status(), body: await result.json() };
}

/** Authenticated local browser proof. Leaves one ready managed source for the visible Context picker. */
export async function runManagedContextProof({ page, origin, api, report, fixture = {} }) {
  origin = requireLocalOrigin(origin);
  const suffix = randomUUID().slice(0, 8);
  const title = fixture.filename ?? `acceptance-managed-${suffix}.md`;
  const raw = fixture.content ?? "# Managed brand\r\n\r\nOrion launch follows the reviewed checklist on Tuesday.\r\n";
  const corrected = fixture.correctedContent ?? "# Managed brand\n\nOrion launch follows the reviewed checklist on Friday.\n";
  const concurrent = "# Managed brand\n\nAnother reviewer's Orion source correction.\n";
  const snapshotPath = "/api/memory/sources/snapshot";
  const wizard = page.getByRole("dialog", { name: "Welcome setup" });
  if (await wizard.isVisible()) await wizard.getByRole("button", { name: "Close setup" }).click();
  await page.goto(`${origin}/memory/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Workspace Memory", exact: true }).click();
  await page.getByRole("region", { name: "Workspace memory sources" }).waitFor();
  const before = (await api("/api/memory/sources")).sources.map((item) => item.id).sort();

  await page.getByLabel("TXT or Markdown file").setInputFiles({ name: "unsupported.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7 unsupported") });
  await page.getByRole("button", { name: "Upload file", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Choose a nonempty TXT or Markdown file" }).waitFor();
  const rejected = await uploadFile(page, { name: "active.md", mimeType: "text/markdown", buffer: Buffer.from("<svg onload=alert(1)>") });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /unsupported|plain TXT/i);
  await page.getByRole("alert").filter({ hasText: /unsupported|plain TXT/i }).waitFor();
  assert.deepEqual((await api("/api/memory/sources")).sources.map((item) => item.id).sort(), before, "Rejected files must never be published as ready sources.");
  report({ id: "managed-context-unsupported-file", status: "passed", unsupported: "rejected before ready; no retained quarantine object claimed" });

  const uploaded = await uploadFile(page, { name: title, mimeType: "text/markdown", buffer: Buffer.from(raw) });
  assert.equal(uploaded.status, 201);
  const first = uploaded.body.source;
  assert.equal(first.version, 1);
  assert.equal(first.sha256, sha256(raw));
  assert.equal(first.ingestion.state, "ready");
  assert.equal(first.ingestion.bytes, Buffer.byteLength(raw));
  const oldSnapshot = (await api(snapshotPath, jsonWrite({ sourceIds: [first.id], expectedRefs: [{ id: first.id, version: 1, sha256: first.sha256 }] }))).snapshot;
  const article = sourceArticle(page, title);
  await article.getByText(/Extraction: ready · version 1/).waitFor();
  await article.getByRole("button", { name: "Inspect / edit" }).click();
  await page.getByLabel("TEXT TO REMEMBER").fill(corrected);
  await api(`/api/memory/sources/${first.id}`, jsonWrite({ content: concurrent, expectedVersion: 1 }, "PATCH"));
  const stale = page.waitForResponse((item) => new URL(item.url()).pathname === `/api/memory/sources/${first.id}` && item.request().method() === "PATCH");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  assert.equal((await stale).status(), 409);
  await page.getByText("Current source refreshed. Your text is unchanged; inspect the stored source before saving again.", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("TEXT TO REMEMBER").inputValue(), corrected);
  assert.equal((await api(`/api/memory/sources/${first.id}`)).source.version, 2, "Conflict handling must not automatically retry the write.");
  const explicitSave = page.waitForResponse((item) => new URL(item.url()).pathname === `/api/memory/sources/${first.id}` && item.request().method() === "PATCH");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  assert.equal((await explicitSave).status(), 200);
  await article.getByText(/Extraction: ready · version 3/).waitFor();
  const source = (await api(`/api/memory/sources/${first.id}`)).source;
  assert.equal(source.sha256, sha256(corrected));
  assert.notEqual(source.sha256, first.sha256);
  assert.equal(source.content, corrected);
  assert.equal(oldSnapshot.sources[0].version, 1);
  assert.equal(oldSnapshot.sources[0].sha256, first.sha256);
  const sourceRefs = [{ id: source.id, version: source.version, sha256: source.sha256 }];
  const snapshot = (await api(snapshotPath, jsonWrite({ sourceIds: [source.id], expectedRefs: sourceRefs }))).snapshot;
  const recalled = (await api("/api/memory/recall?q=Orion")).hits.find((hit) => hit.id === source.id);
  assert.ok(recalled, "The actual uploaded source must be retrievable.");
  const citation = recalled.citations.find((item) => item.lineStart === 3);
  assert.equal(citation?.sourceId, source.id);
  assert.equal(citation?.version, 3);
  assert.equal(citation?.sha256, source.sha256);
  assert.equal(citation?.lineEnd, 3);
  assert.match(citation?.text ?? "", /Orion/);
  report({ id: "managed-context-upload-cas-citation", status: "passed", sourceId: source.id, versions: [1, 2, 3], sha256: source.sha256, citation, staleInputPreserved: true });

  const txtTitle = `acceptance-revoked-${suffix}.txt`;
  const txt = await uploadFile(page, { name: txtTitle, mimeType: "text/plain", buffer: Buffer.from("ManagedTxtProbe: temporary private source.") });
  assert.equal(txt.status, 201);
  assert.equal(txt.body.source.ingestion.mediaType, "text/plain");
  const txtId = txt.body.source.id;
  const txtArticle = sourceArticle(page, txtTitle);
  await txtArticle.getByRole("button", { name: "Disable", exact: true }).click();
  await txtArticle.getByRole("button", { name: "Enable", exact: true }).waitFor();
  assert.ok(!(await api("/api/memory/recall?q=ManagedTxtProbe")).hits.some((hit) => hit.id === txtId));
  assert.equal((await responseJson(page, snapshotPath, jsonWrite({ sourceIds: [txtId] }))).status, 400);
  await txtArticle.getByRole("button", { name: "Enable", exact: true }).click();
  await txtArticle.getByRole("button", { name: "Disable", exact: true }).waitFor();
  page.once("dialog", (dialog) => { void dialog.accept(); });
  await txtArticle.getByRole("button", { name: "Delete", exact: true }).click();
  await txtArticle.waitFor({ state: "detached" });
  assert.equal((await responseJson(page, `/api/memory/sources/${txtId}`)).status, 404);
  assert.ok(!(await api("/api/memory/recall?q=ManagedTxtProbe")).hits.some((hit) => hit.id === txtId));
  assert.equal((await responseJson(page, snapshotPath, jsonWrite({ sourceIds: [txtId] }))).status, 400);
  report({ id: "managed-context-disable-forget", status: "passed", sourceId: txtId, futureRetrievalBlocked: true });

  assert.ok(fixture.otherOwnerPage, "Supply a second authenticated local owner page; anonymous denial is not wrong-owner proof.");
  const other = fixture.otherOwnerPage;
  assert.equal(new URL(other.url()).origin, origin);
  const ownerSession = await api("/api/auth/get-session");
  const otherSession = await responseJson(other, "/api/auth/get-session");
  assert.equal(otherSession.status, 200);
  assert.ok(ownerSession?.user?.id && otherSession.body?.user?.id);
  assert.notEqual(ownerSession.user.id, otherSession.body.user.id, "Wrong-owner proof requires different authenticated identities.");
  assert.equal((await responseJson(other, `/api/memory/sources/${source.id}`)).status, 404);
  assert.equal((await responseJson(other, `/api/memory/sources/${source.id}`, jsonWrite({ content: "foreign edit", expectedVersion: 3 }, "PATCH"))).status, 404);
  assert.equal((await responseJson(other, `/api/memory/sources/${source.id}`, { method: "DELETE" })).status, 404);
  assert.equal((await responseJson(other, snapshotPath, jsonWrite({ sourceIds: [source.id] }))).status, 400);
  assert.equal((await api(`/api/memory/sources/${source.id}`)).source.sha256, source.sha256);
  report({ id: "managed-context-wrong-owner", status: "passed", distinctAuthenticatedOwners: true, foreignReadWriteSnapshotDenied: true });
  if (fixture.screenshotPath) await page.screenshot({ path: fixture.screenshotPath, fullPage: true });
  return { sourceIds: [source.id], sourceRefs, sourceTitle: source.title, source, snapshot, citation: `[source:${source.id}@v${source.version}:L3 sha256:${source.sha256}]`, proof: { upload: "actual browser file input", extraction: "validated text ready", versions: [1, 2, 3], wrongOwner: "distinct authenticated owner denied", semanticCitationValidation: false } };
}

/** Check the exact pending snapshot; optionally revoke future selection after minting. */
export async function verifyManagedContextApproval({ page, api, report, context, goal, disableAfterFreeze = false }) {
  const list = await api(scoped("/api/approvals", goal.sessionId));
  const approval = [...(list.approvals ?? []), ...(list.decided ?? [])].find((item) => item.approvalId === goal.approvalId);
  assert.ok(approval, "The queued approval must be owner-visible.");
  assert.equal(approval.draftTaskId, goal.draftTaskId);
  assert.equal(approval.draftTaskVersion, goal.version);
  assert.deepEqual(refs(approval.onboardingSourceSnapshot), context.sourceRefs);
  assert.deepEqual(approval.onboardingSourceSnapshot, context.snapshot);
  if (disableAfterFreeze) {
    const before = structuredClone(approval.onboardingSourceSnapshot);
    await api(`/api/memory/sources/${context.sourceIds[0]}`, jsonWrite({ enabled: false }, "PATCH"));
    assert.equal((await responseJson(page, "/api/memory/sources/snapshot", jsonWrite({ sourceIds: context.sourceIds }))).status, 400);
    const after = await api(scoped("/api/approvals", goal.sessionId));
    const retained = [...(after.approvals ?? []), ...(after.decided ?? [])].find((item) => item.approvalId === goal.approvalId);
    assert.deepEqual(retained?.onboardingSourceSnapshot, before, "Source revocation must not rewrite an already frozen approval.");
  }
  report({ id: "managed-context-frozen-approval", status: "passed", approvalId: goal.approvalId, sourceRefs: context.sourceRefs, futureSelectionRevoked: disableAfterFreeze });
  return approval;
}

/** Provenance + literal citation presence; this does not claim semantic grounding validation. */
export async function verifyManagedContextDraft({ page, api, report, context, goal }) {
  let file;
  let downloadUrl;
  if (goal.employeeDraftId || goal.workerDraft) {
    const result = await api(scoped("/api/employee-drafts", goal.sessionId));
    const draft = result.drafts?.find((item) => goal.employeeDraftId ? item.id === goal.employeeDraftId : item.draftTaskId === goal.draftTaskId && item.draftTaskVersion === goal.version);
    assert.ok(draft, "The internal employee draft must be durably owner-visible.");
    assert.equal(draft.draftTaskId, goal.draftTaskId);
    assert.equal(draft.draftTaskVersion, goal.version);
    assert.deepEqual(refs(draft.onboardingSourceSnapshot), context.sourceRefs);
    assert.equal(draft.source?.draftTaskId, goal.draftTaskId);
    assert.equal(draft.source?.draftTaskVersion, goal.version);
    assert.deepEqual(refs(draft.source?.onboardingSourceSnapshot), context.sourceRefs);
    assert.ok(draft.source?.sourceMessageIds?.length, "A retained employee draft needs a successful source read receipt.");
    file = draft.deliverable;
    downloadUrl = draft.downloadUrl;
  } else {
    const result = await api(scoped(`/api/runs/${encodeURIComponent(goal.runId)}`, goal.sessionId));
    const run = result.run;
    assert.equal(run?.draftTaskId, goal.draftTaskId);
    assert.equal(run?.draftTaskVersion, goal.version);
    assert.deepEqual(refs(run.onboardingSourceSnapshot), context.sourceRefs);
    assert.equal(run.status, "completed");
    file = run.deliverables?.[0];
    downloadUrl = scoped(`/api/runs/${encodeURIComponent(goal.runId)}/deliverables/0`, goal.sessionId);
  }
  assert.ok(file, "The cited draft must contain a captured deliverable.");
  assert.deepEqual(file.provenance?.onboarding, { draftTaskId: goal.draftTaskId, version: goal.version, sources: context.sourceRefs });
  assert.ok(typeof downloadUrl === "string" && /^\/api\/(?:runs\/[^/?]+\/deliverables\/\d+|employee-drafts\/draft_[a-f0-9]{64}\/download)(?:\?session=[a-f0-9-]+)?$/.test(downloadUrl), "Use only owner API download routes.");
  const downloaded = await page.evaluate(async (path) => {
    const response = await fetch(path);
    return { status: response.status, bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
  }, downloadUrl);
  assert.equal(downloaded.status, 200);
  const bytes = Buffer.from(downloaded.bytes);
  assert.equal(sha256(bytes), file.sha256);
  assert.equal(bytes.byteLength, file.bytes);
  assert.ok(bytes.toString("utf8").includes(goal.citationText ?? context.citation), "The captured draft bytes must include the actual immutable source citation.");
  report({ id: "managed-context-cited-draft", status: "passed", draftTaskId: goal.draftTaskId, version: goal.version, sourceRefs: context.sourceRefs, path: file.path, sha256: file.sha256, literalCitationPresent: true, semanticCitationValidation: false });
  return { file, literalCitationPresent: true, semanticCitationValidation: false };
}
