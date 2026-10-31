/** Private internal chat outputs; source receipts and manifests live in the owning orchestrator. */
import { isSafeDeliverablePath, MAX_DELIVERABLE_BYTES, type RunDeliverable } from "@shiba/shared";
import { z } from "zod";
import type { Env } from "./env.js";
import { getCustomAgentById } from "./custom-agents-store.js";
import { resolveEmployeeConnectionGrant } from "./employee-tool-store.js";
import { isGmailConnectionActive } from "./gmail.js";
import { capabilityId, EMPLOYEE_TOOL_POLICY_VERSION } from "./employee-tool-policy.js";
import { deliverableStorageKey, persistRunDeliverables, verifyExpectedDeliverables } from "./run-deliverables.js";
import { artifactReviewRevision, parseArtifactReview } from "./artifact-metadata.js";
import { parseSessionAgentName } from "./web-sessions.js";
import { onboardingTaskText, type OnboardingRunFields, type SkillExecutionPin } from "@shiba/shared";
import { revalidateOnboardingBinding } from "./onboarding-task-binding.js";
import { resolvePreparedOnboardingDraft } from "./onboarding-progress.js";
import { areSkillPinsActive } from "./skills-store.js";
import { wrapUntrusted } from "./mailbox-store.js";
import { EMPLOYEE_MCP_READ_META, type EmployeeExternalReadEvidence } from "./external-mcp.js";
import { isEmployeeExternalReadCurrent } from "./employee-external-mcp.js";
import { resolveOwnedAppSession } from "./employee-app-session.js";

export interface EmployeeDraftBinding extends OnboardingRunFields {
  orgId: string;
  actorId: string;
  executionContextId: string;
  employeeId: string;
  employeeVersion: number;
  skillPins?: SkillExecutionPin[];
}

export interface EmployeeReadReceipt extends EmployeeDraftBinding {
  id: string;
  tool: "gmail_read" | "selected_context" | `ext_${string}`;
  toolVersion: 1;
  policyVersion: typeof EMPLOYEE_TOOL_POLICY_VERSION;
  sourceMessageIds: string[];
  connectionId: string;
  accountId: string;
  connectionGeneration: number;
  resultSha256: string;
  createdAt: number;
  untrusted: true;
  external?: EmployeeExternalReadEvidence;
  selectedContext?: { canonicalTask: string };
}

export interface EmployeeDraft extends EmployeeDraftBinding {
  id: string;
  createdAt: number;
  source: EmployeeReadReceipt;
  deliverable: RunDeliverable;
}

/** Synchronous commits keep each manifest/review CAS atomic in the owning DO. */
export interface EmployeeDraftStore {
  getReadReceipt(id: string): EmployeeReadReceipt | null;
  saveReadReceipt(receipt: EmployeeReadReceipt): void;
  getDraft(id: string): EmployeeDraft | null;
  listDrafts(): EmployeeDraft[];
  saveDraft(draft: EmployeeDraft): void;
}

export const MAX_EMPLOYEE_DRAFTS = 50;

export const employeeDraftInputSchema = z.object({
  path: z.string().max(240),
  content: z.string().max(16_384),
  sourceReadId: z.string().regex(/^read_[a-f0-9]{64}$/),
}).strict();

async function sha256(value: string | ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", typeof value === "string" ? new TextEncoder().encode(value) : value);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameBinding(a: EmployeeDraftBinding, b: EmployeeDraftBinding): boolean {
  return a.orgId === b.orgId && a.actorId === b.actorId && a.executionContextId === b.executionContextId &&
    a.employeeId === b.employeeId && a.employeeVersion === b.employeeVersion &&
    a.draftTaskId === b.draftTaskId && a.draftTaskVersion === b.draftTaskVersion &&
    JSON.stringify(a.onboardingSourceSnapshot) === JSON.stringify(b.onboardingSourceSnapshot) &&
    JSON.stringify(a.skillPins ?? []) === JSON.stringify(b.skillPins ?? []);
}

async function currentProfile(env: Env, binding: EmployeeDraftBinding) {
  const employee = await getCustomAgentById(env, binding.orgId, binding.employeeId);
  if (!employee || employee.version !== binding.employeeVersion || !await areSkillPinsActive(env, binding.orgId, binding.skillPins ?? [])) {
    throw new Error("Employee or selected skill version changed; read the source again.");
  }
  await revalidateOnboardingBinding(env, binding.actorId, binding);
  return employee;
}

async function currentSourceGrant(env: Env, binding: EmployeeDraftBinding, messageIds: readonly string[]) {
  if (!binding.orgId || !binding.actorId || !binding.executionContextId || !binding.employeeId ||
    !Number.isSafeInteger(binding.employeeVersion) || binding.employeeVersion < 1 || !env.AGENT_AUDIT ||
    messageIds.length < 1 || messageIds.length > 25 || new Set(messageIds).size !== messageIds.length ||
    messageIds.some((id) => !/^[A-Za-z0-9_-]{1,128}$/.test(id))) throw new Error("Invalid draft source binding.");
  const employee = await currentProfile(env, binding);
  const capability = capabilityId("gmail_read");
  if (!employee || employee.version !== binding.employeeVersion || !employee.config.toolScopes?.includes(capability)) {
    throw new Error("Employee policy changed; read the selected source again.");
  }
  const grants = await Promise.all(messageIds.map((resourceId) => resolveEmployeeConnectionGrant(env, {
    orgId: binding.orgId, employeeId: binding.employeeId, employeeVersion: binding.employeeVersion,
    actorId: binding.actorId, capabilityId: capability, resourceId,
  })));
  const first = grants[0];
  if (!first?.accountId || grants.some((grant) => !grant || grant.connectionId !== first.connectionId ||
    grant.accountId !== first.accountId || grant.generation !== first.generation) ||
    !await isGmailConnectionActive(env, first.accountId, first.connectionId)) {
    throw new Error("Draft source grant was revoked or changed.");
  }
  await revalidateOnboardingBinding(env, binding.actorId, binding);
  return { connectionId: first.connectionId, accountId: first.accountId, connectionGeneration: first.generation };
}

/** Call only after the Worker has successfully dispatched gmail_read; never from model arguments. */
export async function recordEmployeeRead(
  env: Env, store: EmployeeDraftStore, binding: EmployeeDraftBinding,
  toolCallId: string, messageIds: readonly string[], result: unknown, signal?: AbortSignal,
): Promise<EmployeeReadReceipt> {
  signal?.throwIfAborted();
  if (!toolCallId) throw new Error("Source read requires a tool invocation ID.");
  const id = `read_${await sha256(JSON.stringify([binding, toolCallId]))}`;
  const resultSha256 = await sha256(JSON.stringify(result));
  const connection = await currentSourceGrant(env, binding, messageIds);
  signal?.throwIfAborted();
  const receipt: EmployeeReadReceipt = {
    ...binding, id, tool: "gmail_read", toolVersion: 1, policyVersion: EMPLOYEE_TOOL_POLICY_VERSION,
    sourceMessageIds: [...messageIds], ...connection, resultSha256, createdAt: Date.now(), untrusted: true,
  };
  const previous = store.getReadReceipt(id);
  if (previous) {
    if (!sameBinding(previous, receipt) || previous.resultSha256 !== receipt.resultSha256 ||
      JSON.stringify(previous.sourceMessageIds) !== JSON.stringify(receipt.sourceMessageIds) ||
      previous.connectionId !== receipt.connectionId || previous.accountId !== receipt.accountId ||
      previous.connectionGeneration !== receipt.connectionGeneration) throw new Error("Source read invocation changed.");
    return previous;
  }
  store.saveReadReceipt(receipt);
  return receipt;
}

/** Only a successful adapter result can mint a connector read receipt. Model arguments cannot supply evidence. */
export async function recordEmployeeExternalRead(
  env: Env, store: EmployeeDraftStore, binding: EmployeeDraftBinding, toolCallId: string,
  result: { isError?: boolean; _meta?: Record<string, unknown> }, signal?: AbortSignal,
): Promise<EmployeeReadReceipt> {
  signal?.throwIfAborted();
  const evidence = result._meta?.[EMPLOYEE_MCP_READ_META] as EmployeeExternalReadEvidence | undefined;
  const invocation = result._meta?.["com.shiba/invocation"] as { status?: string } | undefined;
  if (!toolCallId || result.isError || invocation?.status !== "succeeded" || !evidence || !sameBinding(evidence, binding) ||
    !/^ext_[a-f0-9]{12}_[a-f0-9]{16}$/.test(evidence.tool) || !await isEmployeeExternalReadCurrent(env, evidence)) {
    throw new Error("External source read did not succeed under current employee authority.");
  }
  const id = `read_${await sha256(JSON.stringify([binding, toolCallId]))}`;
  const resultSha256 = await sha256(JSON.stringify(result));
  if (!await isEmployeeExternalReadCurrent(env, evidence)) throw new Error("External source authority changed; read it again.");
  signal?.throwIfAborted();
  const previous = store.getReadReceipt(id);
  if (previous) {
    if (!sameBinding(previous, binding) || previous.resultSha256 !== resultSha256) throw new Error("Source read invocation changed.");
    return previous;
  }
  const receipt: EmployeeReadReceipt = { ...binding, id, tool: evidence.tool as `ext_${string}`, toolVersion: 1,
    policyVersion: EMPLOYEE_TOOL_POLICY_VERSION, sourceMessageIds: [], connectionId: evidence.serverId, accountId: evidence.serverId,
    connectionGeneration: evidence.serverGeneration, resultSha256, createdAt: Date.now(), untrusted: true, external: structuredClone(evidence) };
  store.saveReadReceipt(receipt);
  return receipt;
}

async function currentSelectedSession(env: Env, binding: EmployeeDraftBinding) {
  const session = await resolveOwnedAppSession(env, binding.executionContextId);
  if (!session || session.userId !== binding.actorId || session.metadata?.customAgentId !== binding.employeeId ||
    (session.metadata?.orgId ?? "self-hosted") !== binding.orgId) throw new Error("Selected employee session changed; read the context again.");
}

async function selectedContext(env: Env, binding: EmployeeDraftBinding) {
  await currentSelectedSession(env, binding);
  await currentProfile(env, binding);
  if (!binding.draftTaskId || !binding.draftTaskVersion) throw new Error("Prepare an onboarding goal before reading supplied context.");
  const draft = await resolvePreparedOnboardingDraft(env, binding.actorId, { draftTaskId: binding.draftTaskId, version: binding.draftTaskVersion });
  if (!draft || draft.draftTask.employeeId !== binding.employeeId) throw new Error("Prepared context or selected employee changed.");
  const payload = { canonicalTask: onboardingTaskText(draft.draftTask), sources: binding.onboardingSourceSnapshot?.sources ?? [] };
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAX_DELIVERABLE_BYTES) throw new Error("Selected context exceeds 16 KiB. Choose fewer sources or facts.");
  return payload;
}

/** A distinct local context read: no connector permission, OAuth, provider call or invented Gmail receipt. */
export async function readEmployeeSelectedContext(
  env: Env, store: EmployeeDraftStore, binding: EmployeeDraftBinding, toolCallId: string, signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!toolCallId) throw new Error("Context read requires a tool invocation identity.");
  const payload = await selectedContext(env, binding);
  const id = `read_${await sha256(JSON.stringify([binding, toolCallId]))}`;
  const resultSha256 = await sha256(JSON.stringify(payload));
  await currentProfile(env, binding);
  await currentSelectedSession(env, binding);
  signal?.throwIfAborted();
  const previous = store.getReadReceipt(id);
  if (previous && (!sameBinding(previous, binding) || previous.resultSha256 !== resultSha256)) throw new Error("Source read invocation changed.");
  const receipt: EmployeeReadReceipt = previous ?? { ...binding, id, tool: "selected_context", toolVersion: 1,
    policyVersion: EMPLOYEE_TOOL_POLICY_VERSION, sourceMessageIds: [], connectionId: binding.draftTaskId ?? "", accountId: binding.actorId,
    connectionGeneration: binding.draftTaskVersion ?? 0, resultSha256, createdAt: Date.now(), untrusted: true,
    selectedContext: { canonicalTask: payload.canonicalTask } };
  if (!previous) store.saveReadReceipt(receipt);
  return { sourceReadId: receipt.id, context: wrapUntrusted(JSON.stringify(payload)) };
}

/** Generated content remains an unreviewed internal draft, never a completed run or sent email. */
export async function retainEmployeeDraft(
  env: Env, store: EmployeeDraftStore, binding: EmployeeDraftBinding,
  toolCallId: string, value: unknown, signal?: AbortSignal,
): Promise<EmployeeDraft> {
  signal?.throwIfAborted();
  const input = employeeDraftInputSchema.parse(value);
  if (!toolCallId) throw new Error("Draft retention requires a tool invocation ID.");
  const source = store.getReadReceipt(input.sourceReadId);
  if (!source || !sameBinding(source, binding)) throw new Error("Read the selected source in this employee session first; source receipts can expire.");
  const [artifact] = await verifyExpectedDeliverables([input.path], [{ path: input.path, content: input.content, encoding: "utf8" }]);
  if (!artifact) throw new Error("Draft content is missing.");
  const id = `draft_${await sha256(JSON.stringify([binding, toolCallId]))}`;
  const recheck = async () => {
    if (source.tool === "selected_context") {
      const context = await selectedContext(env, binding);
      if (!source.selectedContext || context.canonicalTask !== source.selectedContext.canonicalTask ||
        await sha256(JSON.stringify(context)) !== source.resultSha256) throw new Error("Selected context changed; read it again.");
      await currentSelectedSession(env, binding);
      return;
    }
    if (source.external) {
      if (!sameBinding(source.external, binding) || !await isEmployeeExternalReadCurrent(env, source.external)) throw new Error("External source authority changed; read it again.");
      return;
    }
    if (source.tool !== "gmail_read") throw new Error("Unsupported draft source receipt.");
    const connection = await currentSourceGrant(env, binding, source.sourceMessageIds);
    if (connection.connectionId !== source.connectionId || connection.accountId !== source.accountId ||
      connection.connectionGeneration !== source.connectionGeneration) throw new Error("Draft source connection changed; read it again.");
  };
  await recheck();
  signal?.throwIfAborted();
  const previous = store.getDraft(id);
  if (previous) {
    if (!sameBinding(previous, binding) || previous.source.id !== source.id || previous.deliverable.sha256 !== artifact.sha256 ||
      previous.deliverable.path !== input.path) throw new Error("Draft invocation payload changed.");
    return previous;
  }
  if (store.listDrafts().length >= MAX_EMPLOYEE_DRAFTS) throw new Error("This session has reached its retained draft limit (50). Start a new session.");
  const [metadata] = await persistRunDeliverables(env, id, [artifact]);
  signal?.throwIfAborted();
  if (!metadata) throw new Error("Draft storage failed.");
  await recheck();
  signal?.throwIfAborted();
  // Re-read after storage yields: a retry may already have committed this invocation.
  const concurrent = store.getDraft(id);
  if (concurrent) {
    if (concurrent.deliverable.sha256 !== artifact.sha256 || concurrent.deliverable.path !== input.path || concurrent.source.id !== source.id) {
      throw new Error("Draft invocation payload changed.");
    }
    return concurrent;
  }
  if (store.listDrafts().length >= MAX_EMPLOYEE_DRAFTS) throw new Error("This session has reached its retained draft limit (50). Start a new session.");
  const now = Date.now();
  const draft: EmployeeDraft = {
    ...binding, id, createdAt: now, source: structuredClone(source),
    deliverable: { ...metadata, artifactId: id, version: 1,
      provenance: { customAgent: { id: binding.employeeId, version: binding.employeeVersion },
        ...(binding.skillPins?.length ? { skills: binding.skillPins.map(({ skillId, version, name }) => ({ skillId, version, name })) } : {}),
        ...(binding.draftTaskId && binding.draftTaskVersion ? { onboarding: {
          draftTaskId: binding.draftTaskId, version: binding.draftTaskVersion,
          sources: (binding.onboardingSourceSnapshot?.sources ?? []).map(({ id, version, sha256 }) => ({ id, version, sha256 })),
        } } : {}),
      },
      review: { status: "pending_review", revision: 0, updatedAt: now } },
  };
  store.saveDraft(draft);
  return draft;
}

export function employeeDraftLinks(draft: EmployeeDraft, sessionId?: string) {
  const session = sessionId ?? parseSessionAgentName(draft.executionContextId)?.sessionId;
  const query = session ? `?session=${encodeURIComponent(session)}` : "";
  const path = `/api/employee-drafts/${draft.id}`;
  return { metadataUrl: `${path}${query}`, downloadUrl: `${path}/download${query}`, reviewUrl: `${path}/review${query}` };
}

/** Caller authenticates the owner and resolves exactly one owned session before forwarding here. */
export async function handleEmployeeDraftRequest(
  request: Request, env: Env, store: EmployeeDraftStore,
  owner: { orgId: string; actorId: string; executionContextId: string },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/employee-drafts")) return null;
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  const owned = (draft: EmployeeDraft) => draft.orgId === owner.orgId && draft.actorId === owner.actorId && draft.executionContextId === owner.executionContextId;
  if (url.pathname === "/api/employee-drafts") {
    if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
    return json({ drafts: store.listDrafts().filter(owned).map((draft) => ({ ...draft, ...employeeDraftLinks(draft, url.searchParams.get("session") ?? undefined) })) });
  }
  const match = url.pathname.match(/^\/api\/employee-drafts\/(draft_[a-f0-9]{64})(?:\/(download|review))?$/);
  const draft = match?.[1] ? store.getDraft(match[1]) : null;
  if (!draft || !owned(draft)) return json({ error: "Draft not found." }, 404);
  if (match?.[2] === "review") {
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
    const input = parseArtifactReview(await request.json().catch(() => null));
    if (!input) return json({ error: "Invalid draft review." }, 400);
    // No await between this current-state read and the synchronous state commit.
    const current = store.getDraft(draft.id);
    if (!current || !owned(current)) return json({ error: "Draft not found." }, 404);
    if (artifactReviewRevision(current.deliverable.review) !== input.expectedRevision) {
      return json({ error: "Draft review changed.", currentReview: current.deliverable.review }, 409);
    }
    const updated: EmployeeDraft = { ...current, deliverable: { ...current.deliverable, review: {
      status: input.status, revision: input.expectedRevision + 1, updatedAt: Date.now(), ...(input.note ? { note: input.note } : {}),
    } } };
    store.saveDraft(updated);
    return json({ draft: updated });
  }
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
  if (!match?.[2]) return json({ draft: { ...draft, ...employeeDraftLinks(draft, url.searchParams.get("session") ?? undefined) } });
  const item = draft.deliverable;
  if (!isSafeDeliverablePath(item.path) || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > MAX_DELIVERABLE_BYTES || !/^[a-f0-9]{64}$/.test(item.sha256)) {
    return json({ error: "Draft integrity check failed." }, 409);
  }
  if (!env.ATTACHMENTS) return json({ error: "Draft storage unavailable." }, 503);
  const object = await env.ATTACHMENTS.get(deliverableStorageKey(draft.id, draft.deliverable.sha256, 0));
  if (!object) return json({ error: "Draft not found." }, 404);
  if (object.size !== draft.deliverable.bytes) return json({ error: "Draft integrity check failed." }, 409);
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength !== draft.deliverable.bytes || await sha256(bytes) !== draft.deliverable.sha256) {
    return json({ error: "Draft integrity check failed." }, 409);
  }
  const types: Record<string, string> = { md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8", json: "application/json; charset=utf-8", csv: "text/csv; charset=utf-8" };
  const extension = item.path.slice(item.path.lastIndexOf(".") + 1).toLowerCase();
  const filename = item.path.slice(item.path.lastIndexOf("/") + 1);
  return new Response(bytes, { headers: {
    "cache-control": "no-store", "content-type": types[extension] ?? "application/octet-stream",
    "content-disposition": `attachment; filename="${filename}"`,
    "x-content-type-options": "nosniff", "content-length": String(bytes.byteLength),
  } });
}
