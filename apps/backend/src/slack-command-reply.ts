import { runInputHash, type DelegatedRun } from "@shiba/shared";
import { z } from "zod";
import type { Env } from "./env.js";
import { redactSecrets } from "./security.js";
import { parseSlackCommandScope } from "./slack-thread.js";
import { slackAgentPersona } from "./slack-persona.js";
import { SLACK_POST_TIMEOUT_MS, SlackPostRejectedError, verifySlackBotInstallation } from "./slack.js";

const MAX_RECEIPT_BYTES = 4096;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const destinationSchema = z.strictObject({
  version: z.literal(1), approvalId: id, approvalInputHash: digest,
  origin: z.string().max(300), teamId: id, channelId: id, userId: id,
  createdAt: z.number().int().positive(),
});
type Destination = z.infer<typeof destinationSchema>;
const claimSchema = z.strictObject({
  version: z.literal(1), textHash: digest,
  status: z.enum(["executing", "sent", "rejected", "unknown"]),
});
type Claim = z.infer<typeof claimSchema>;

export class SlackCommandReplyUnknownError extends Error {
  constructor() {
    super("Private Slack reply outcome is unknown. Inspect Slack before requesting another delivery.");
    this.name = "SlackCommandReplyUnknownError";
  }
}

async function sha256(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function privateReplyText(text: string): string {
  const characters = Array.from(redactSecrets(text).slice(-10_000));
  const kept: string[] = [];
  let bytes = 0;
  for (let index = characters.length - 1; index >= 0; index--) {
    const character = characters[index] ?? "";
    const size = new TextEncoder().encode(character).byteLength;
    if (bytes + size > 3500) break;
    bytes += size;
    kept.push(character);
  }
  return `${kept.length < characters.length ? "…" : ""}${kept.reverse().join("")}`;
}

async function destinationKey(approvalId: string): Promise<string> {
  return `slack-command-replies/${await sha256(approvalId)}/destination.json`;
}

async function readObject(bucket: R2Bucket, key: string): Promise<{ value: unknown; etag: string } | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  if (object.size > MAX_RECEIPT_BYTES) throw new Error("Private Slack reply receipt exceeds its limit.");
  const text = await object.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RECEIPT_BYTES) throw new Error("Private Slack reply receipt exceeds its limit.");
  if (object.customMetadata?.sha256 !== await sha256(text)) throw new Error("Private Slack reply receipt digest does not match.");
  return { value: JSON.parse(text), etag: object.etag };
}

async function writeObject(bucket: R2Bucket, key: string, value: Destination | Claim, etag?: string): Promise<R2Object | null> {
  const text = JSON.stringify(value);
  return bucket.put(key, text, {
    onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" },
    customMetadata: { sha256: await sha256(text) }, httpMetadata: { contentType: "application/json" },
  });
}

/** Called only after the slash route verifies Slack and queues the frozen approval. */
export async function saveSlackCommandReplyDestination(
  env: Pick<Env, "ATTACHMENTS">,
  input: { approvalId: string; approvalInputHash: string; origin: string; userId: string },
  now = Date.now(),
): Promise<void> {
  if (!env.ATTACHMENTS) throw new Error("Private Slack completion storage is not configured.");
  const scope = parseSlackCommandScope(input.origin);
  if (!scope) throw new Error("Private Slack completion has an invalid command origin.");
  const destination = destinationSchema.parse({ version: 1, ...input, ...scope, createdAt: now });
  const key = await destinationKey(destination.approvalId);
  const existing = await readObject(env.ATTACHMENTS, key);
  if (existing) {
    const retained = destinationSchema.parse(existing.value);
    if (retained.approvalId !== destination.approvalId || retained.approvalInputHash !== destination.approvalInputHash ||
        retained.origin !== destination.origin || retained.userId !== destination.userId) throw new Error("Private Slack completion destination is already bound to another request.");
    return;
  }
  if (!await writeObject(env.ATTACHMENTS, key, destination)) throw new Error("Private Slack completion destination could not be saved.");
}

async function postEphemeral(token: string, destination: Destination, text: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch("https://slack.com/api/chat.postEphemeral", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      signal: AbortSignal.timeout(SLACK_POST_TIMEOUT_MS),
      body: JSON.stringify({ channel: destination.channelId, user: destination.userId, text, ...slackAgentPersona("lead") }),
    });
  } catch {
    throw new SlackCommandReplyUnknownError();
  }
  const json = await response.json().catch(() => null) as { ok?: unknown; message_ts?: unknown; error?: unknown } | null;
  if (response.status === 408 || response.status >= 500) throw new SlackCommandReplyUnknownError();
  if (!response.ok || json?.ok === false) {
    const error = typeof json?.error === "string" ? json.error : `Slack API ${response.status}`;
    if (["fatal_error", "internal_error", "request_timeout"].includes(error)) throw new SlackCommandReplyUnknownError();
    throw new SlackPostRejectedError(redactSecrets(error), true);
  }
  if (json?.ok !== true || typeof json.message_ts !== "string") throw new SlackCommandReplyUnknownError();
}

/** The caller must persist its outbox intent before calling this Worker-only delivery. */
export async function deliverSlackCommandReply(
  env: Pick<Env, "ATTACHMENTS" | "SLACK_BOT_TOKEN">,
  input: { orchestratorName: string; origin: string; run: DelegatedRun; effectId: string; text: string },
  now = Date.now(),
): Promise<void> {
  const { run } = input;
  if (input.orchestratorName !== "default" || !run.approval || run.parentRunId || run.reviewOf ||
      run.runId !== `agent-tool:${run.approval.approvalId}` || run.approval.inputHash !== runInputHash(run) ||
      !run.approval.decidedBy.trim() || /^(?:system|automation|agent|mcp|child|subagent):/i.test(run.approval.decidedBy)) throw new Error("Private Slack reply is outside the approved run scope.");
  const bucket = env.ATTACHMENTS;
  const token = env.SLACK_BOT_TOKEN?.trim();
  if (!bucket || !token) throw new Error("Private Slack completion is not configured.");
  const baseKey = await destinationKey(run.approval.approvalId);
  const stored = await readObject(bucket, baseKey);
  if (!stored) throw new Error("Private Slack completion destination is unavailable.");
  const destination = destinationSchema.parse(stored.value);
  const scope = parseSlackCommandScope(destination.origin);
  if (!scope || destination.origin !== input.origin || scope.teamId !== destination.teamId || scope.channelId !== destination.channelId ||
      destination.approvalId !== run.approval.approvalId || destination.approvalInputHash !== run.approval.inputHash ||
      destination.createdAt > now + 60_000 || now - destination.createdAt > RETENTION_MS) throw new Error("Private Slack reply destination does not match the approved run.");
  const text = privateReplyText(input.text);
  const textHash = await sha256(text);
  const claimKey = baseKey.replace("destination.json", `delivery-${await sha256(input.effectId)}.json`);
  const previous = await readObject(bucket, claimKey);
  const priorClaim = previous ? claimSchema.parse(previous.value) : null;
  if (priorClaim && priorClaim.textHash !== textHash) throw new Error("Private Slack reply differs from its saved delivery intent.");
  if (priorClaim?.status === "sent") return;
  if (priorClaim?.status === "executing" || priorClaim?.status === "unknown") throw new SlackCommandReplyUnknownError();
  const installation = await verifySlackBotInstallation(token);
  if (installation.teamId !== destination.teamId) throw new Error("Private Slack reply token belongs to another workspace.");
  const claim: Claim = { version: 1, textHash, status: "executing" };
  const claimed = await writeObject(bucket, claimKey, claim, previous?.etag);
  if (!claimed) throw new SlackCommandReplyUnknownError();
  try {
    await postEphemeral(token, destination, text);
    if (!await writeObject(bucket, claimKey, { ...claim, status: "sent" }, claimed.etag)) throw new SlackCommandReplyUnknownError();
  } catch (error) {
    const known = error instanceof SlackPostRejectedError && error.outcomeKnown;
    await writeObject(bucket, claimKey, { ...claim, status: known ? "rejected" : "unknown" }, claimed.etag).catch(() => null);
    if (known) throw error;
    throw new SlackCommandReplyUnknownError();
  }
}
