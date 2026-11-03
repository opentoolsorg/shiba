import { APPROVAL_TTL_MS, type PendingApproval } from "@shiba/shared";
import { z } from "zod";
import type { Env } from "./env.js";
import type { CodingTaskResult } from "./opencode-input.js";
import { publishFilesAsPullRequest, type GitHubDeps, type PublishResult } from "./github.js";
import { resolveGitHubCredential } from "./github-auth.js";
import { parseGitHubRepoUrl, redactSecrets } from "./security.js";
import { isAuthorizedSessionAgent } from "./web-sessions.js";
import { isApprover, parseApproverAllowlist } from "./slack-approval.js";

export const MAX_PR_PUBLISH_STAGE_BYTES = 2_097_152;
const identity = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
function hasControlCharacters(value: string, includeSpace = false): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) <= (includeSpace ? 32 : 31) || character.charCodeAt(0) === 127);
}
const branch = z.string().min(1).max(200).refine((value) => !hasControlCharacters(value, true));

const publicationPayloadSchema = z.object({
  version: z.literal(1),
  ownerId: identity,
  runId: identity,
  sandboxId: identity,
  repoUrl: z.string().url().max(2048),
  baseBranch: branch,
  artifactKey: z.string().regex(/^pr-publish-staging\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/),
  sha256: digest,
  bytes: z.number().int().positive().max(MAX_PR_PUBLISH_STAGE_BYTES),
  fileCount: z.number().int().positive().max(50),
}).strict();

/** Safe metadata only. Captured file bodies stay in private R2 storage. */
export const prPublicationProposalSchema = z.object({
  kind: z.literal("pr_publish"),
  threadKey: identity,
  approvalId: identity,
  repoUrl: z.string().url().max(2048),
  task: z.string().min(1).max(4000),
  baseBranch: branch,
  publishPullRequest: z.literal(false),
  payload: publicationPayloadSchema,
  createdAt: z.number().int().positive(),
}).strict();

export type PrPublicationProposal = z.infer<typeof prPublicationProposalSchema>;
export interface PrPublishScope {
  ownerId: string;
  runId: string;
  repoUrl: string;
  sandboxId?: string;
  baseBranch?: string;
}

const fileSchema = z.object({
  path: z.string().min(1).max(1024).refine((path) =>
    !path.startsWith("/") && !path.includes("\\") && !path.includes(":") && !hasControlCharacters(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git"),
  ),
  content: z.string().max(500_000).nullable(),
  encoding: z.enum(["utf8", "base64"]),
}).strict();

const stagedPublicationSchema = z.object({
  version: z.literal(1),
  ownerId: identity,
  runId: identity,
  sandboxId: identity,
  repoUrl: z.string().url().max(2048),
  baseBranch: branch,
  task: z.string().min(1).max(16_000),
  newBranch: branch,
  title: z.string().min(1).max(200),
  body: z.string().max(16_000),
  message: z.string().min(1).max(200),
  files: z.array(fileSchema).min(1).max(50),
}).strict().superRefine((value, context) => {
  if (new Set(value.files.map((file) => file.path.toLowerCase())).size !== value.files.length) {
    context.addIssue({ code: "custom", message: "Publication file paths must be unique." });
  }
  for (const file of value.files) {
    if (file.content === null) continue;
    if (file.encoding === "base64") {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content) || btoa(atob(file.content)) !== file.content) {
        context.addIssue({ code: "custom", message: "Publication binary files require complete canonical base64." });
      }
    } else if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new TextEncoder().encode(file.content)) !== file.content) {
      context.addIssue({ code: "custom", message: "Publication files require complete Unicode text." });
    }
  }
});

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameScope(actual: PrPublishScope, expected: PrPublishScope): boolean {
  return actual.ownerId === expected.ownerId && actual.runId === expected.runId && actual.repoUrl === expected.repoUrl &&
    (expected.sandboxId === undefined || actual.sandboxId === expected.sandboxId) &&
    (expected.baseBranch === undefined || actual.baseBranch === expected.baseBranch);
}

function authorizedHuman(env: Env, ownerId: string, decidedBy: string): boolean {
  if (isAuthorizedSessionAgent(ownerId, decidedBy)) return true;
  if (isApprover(decidedBy, parseApproverAllowlist(env.DASHBOARD_APPROVERS)) || isApprover(decidedBy, parseApproverAllowlist(env.SLACK_APPROVERS))) return true;
  if (decidedBy.startsWith("telegram:")) return isApprover(decidedBy.slice(9), parseApproverAllowlist(env.TELEGRAM_APPROVERS));
  if (decidedBy.startsWith("discord:")) return isApprover(decidedBy.slice(8), parseApproverAllowlist(env.DISCORD_APPROVERS));
  return false;
}

export function validatePrPublicationProposal(value: unknown, expected: PrPublishScope): PrPublicationProposal {
  const proposal = prPublicationProposalSchema.parse(value);
  parseGitHubRepoUrl(proposal.repoUrl);
  if (!sameScope(proposal.payload, expected) || proposal.repoUrl !== proposal.payload.repoUrl || proposal.baseBranch !== proposal.payload.baseBranch ||
      proposal.approvalId !== `pr-publish:${proposal.payload.runId}`) {
    throw new Error("Publication proposal does not match the completed run.");
  }
  return proposal;
}

/** Called only by the approved execution Worker, before result file bodies are discarded. */
export async function stagePrPublishApproval(
  env: Env,
  input: PrPublishScope & { sandboxId: string; baseBranch: string; task: string; threadKey?: string; result: CodingTaskResult; now?: number },
): Promise<PrPublicationProposal> {
  if (input.result.status !== "completed" || input.result.exitCode !== 0) throw new Error("Only successful completed runs can propose publication.");
  parseGitHubRepoUrl(input.repoUrl);
  if (!env.ATTACHMENTS) throw new Error("Publication staging storage is not configured.");
  const scope = await sha256(new TextEncoder().encode(JSON.stringify([input.ownerId, input.runId, input.sandboxId])));
  const taskSummary = redactSecrets(input.task).replace(/[\r\n]+/g, " ");
  const staged = stagedPublicationSchema.parse({
    version: 1,
    ownerId: input.ownerId,
    runId: input.runId,
    sandboxId: input.sandboxId,
    repoUrl: input.repoUrl,
    baseBranch: input.baseBranch,
    task: input.task,
    newBranch: `shiba/publish-${scope.slice(0, 32)}`,
    title: `AI Coworker: ${taskSummary.slice(0, 80)}`,
    body: [redactSecrets(input.result.summary).slice(0, 8000), "", `Run: ${input.runId}`, `Sandbox: ${input.sandboxId}`,
      ...(input.result.testEvidence ? ["", `Test command: ${redactSecrets(input.result.testEvidence.command).slice(0, 200)}`, `Exit code: ${input.result.testEvidence.exitCode}`, redactSecrets(input.result.testEvidence.outputTail).slice(0, 4000)] : []),
    ].join("\n"),
    message: `AI Coworker: ${taskSummary.slice(0, 120)}`,
    files: input.result.files,
  });
  const bytes = new TextEncoder().encode(JSON.stringify(staged));
  if (bytes.byteLength > MAX_PR_PUBLISH_STAGE_BYTES) throw new Error("Publication stage exceeds its byte limit.");
  if (env.GITHUB_TOKEN && new TextDecoder().decode(bytes).includes(env.GITHUB_TOKEN)) throw new Error("Publication stage contains a configured credential.");
  const hash = await sha256(bytes);
  const key = `pr-publish-staging/${scope}/${hash}.json`;
  const stored = await env.ATTACHMENTS.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256: hash,
    httpMetadata: { contentType: "application/json" },
  });
  if (!stored) {
    const existing = await env.ATTACHMENTS.get(key);
    if (!existing || existing.size !== bytes.byteLength) throw new Error("Publication stage could not be stored or its existing bytes have changed.");
    const existingBytes = new Uint8Array(await existing.arrayBuffer());
    if (existingBytes.byteLength !== bytes.byteLength || await sha256(existingBytes) !== hash) {
      throw new Error("Publication stage could not be stored or its existing bytes have changed.");
    }
  }
  const proposal: PrPublicationProposal = {
    kind: "pr_publish", threadKey: input.threadKey ?? input.ownerId, approvalId: `pr-publish:${input.runId}`,
    repoUrl: input.repoUrl, baseBranch: input.baseBranch, task: `Publish pull request: ${taskSummary.slice(0, 2000)}`,
    publishPullRequest: false, createdAt: input.now ?? Date.now(),
    payload: { version: 1, ownerId: input.ownerId, runId: input.runId, sandboxId: input.sandboxId, repoUrl: input.repoUrl,
      baseBranch: input.baseBranch, artifactKey: key, sha256: hash, bytes: bytes.byteLength, fileCount: staged.files.length },
  };
  return validatePrPublicationProposal(proposal, input);
}

/** The caller must persist an execution claim first and never retry an uncertain outcome. */
export async function executePrPublishApproval(
  env: Env,
  approval: PendingApproval,
  expected: PrPublishScope,
  deps: GitHubDeps = {},
): Promise<PublishResult> {
  const now = Date.now();
  if (approval.kind !== "pr_publish" || approval.status !== "approved" || !approval.decidedBy?.trim() ||
      /^(?:system|automation|agent|mcp|child|subagent):/i.test(approval.decidedBy) || approval.execution !== undefined ||
      !Number.isSafeInteger(approval.decidedAt) || (approval.decidedAt ?? 0) < approval.createdAt ||
      (approval.decidedAt ?? 0) > now || now - approval.createdAt > APPROVAL_TTL_MS) {
    throw new Error("Publication requires a current, unexecuted human approval.");
  }
  const proposal = validatePrPublicationProposal({ kind: approval.kind, threadKey: approval.threadKey, approvalId: approval.approvalId,
    repoUrl: approval.repoUrl, task: approval.task, baseBranch: approval.baseBranch, publishPullRequest: approval.publishPullRequest,
    payload: approval.payload, createdAt: approval.createdAt }, expected);
  if (!authorizedHuman(env, expected.ownerId, approval.decidedBy)) throw new Error("Publication requires an authorized human approval.");
  const payload = proposal.payload;
  if (!env.ATTACHMENTS) throw new Error("Publication staging storage is not configured.");
  const object = await env.ATTACHMENTS.get(payload.artifactKey);
  if (!object || object.size !== payload.bytes || object.size > MAX_PR_PUBLISH_STAGE_BYTES) throw new Error("Publication stage is missing or has changed.");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== payload.bytes || await sha256(bytes) !== payload.sha256) throw new Error("Publication stage digest does not match the approved action.");
  const staged = stagedPublicationSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  const scope = await sha256(new TextEncoder().encode(JSON.stringify([staged.ownerId, staged.runId, staged.sandboxId])));
  if (!sameScope(staged, expected) || !sameScope(staged, payload) || staged.repoUrl !== proposal.repoUrl || staged.baseBranch !== proposal.baseBranch ||
      staged.files.length !== payload.fileCount || payload.artifactKey !== `pr-publish-staging/${scope}/${payload.sha256}.json`) {
    throw new Error("Publication stage identity does not match the approved action.");
  }
  const credential = await resolveGitHubCredential(env, staged.repoUrl, deps.fetchImpl ?? ((resource, init) => fetch(resource, init)));
  if (!credential) throw new Error("Publishing a pull request requires GitHub credentials.");
  return publishFilesAsPullRequest({ ...staged, token: credential.token }, {
    ...deps, apiBase: credential.apiBase, mutationAttempts: 1, cleanupOnPullFailure: false,
  });
}
