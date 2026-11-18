/**
 * Parent-orchestrator seal on child coding envelopes. OpenCodeAgent refuses
 * execution when the seal is missing or wrong, so a nested chat message cannot
 * forge an approved run.
 */
import { signInternal, verifyInternal, type SigningEnv } from "./security/signing.js";
import type { CodingTaskInput } from "./opencode-input.js";
import { formatAgentToolInput, parseAgentToolInput } from "./opencode-input.js";
import { modelCredentialKeyConfigured } from "./subscription-credentials.js";
import { RUN_DEADLINE_MS } from "@shiba/shared";

const DISPATCH_SCOPE = "opencode-child-dispatch-v2";

type DispatchEnv = SigningEnv;

function canonical(approvalId: string, sandboxId: string, inputHash: string, envelopeHash: string): string {
  return [DISPATCH_SCOPE, approvalId, sandboxId, inputHash, envelopeHash].join("\n");
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sorted(item)]));
  }
  return value;
}

/** Bind every parsed execution field, including server-authored owner routing. */
export async function childDispatchEnvelopeHash(input: CodingTaskInput): Promise<string> {
  const parsed = parseAgentToolInput([{ role: "user", text: formatAgentToolInput(input) }]);
  const { dispatchApprovalId: _approval, dispatchInputHash: _input, dispatchEnvelopeHash: _envelope, dispatchSig: _sig, ...fields } = parsed;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(sorted(fields))));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sealChildDispatch(
  env: DispatchEnv,
  fields: { approvalId: string; sandboxId: string; inputHash: string },
  input: CodingTaskInput,
  now = Date.now(),
): Promise<Pick<CodingTaskInput, "dispatchApprovalId" | "dispatchInputHash" | "dispatchEnvelopeHash" | "dispatchIssuedAt" | "dispatchExpiresAt" | "dispatchSig">> {
  const dispatchInputHash = fields.inputHash;
  const dispatchIssuedAt = now;
  const dispatchExpiresAt = now + RUN_DEADLINE_MS;
  const dispatchEnvelopeHash = await childDispatchEnvelopeHash({ ...input, dispatchIssuedAt, dispatchExpiresAt });
  const dispatchSig = await signInternal(env, "shiba/child-dispatch/v1", canonical(fields.approvalId, fields.sandboxId, dispatchInputHash, dispatchEnvelopeHash), modelCredentialKeyConfigured(env) ? env.MODEL_CREDENTIAL_KEY : undefined);
  return {
    dispatchApprovalId: fields.approvalId,
    dispatchInputHash,
    dispatchEnvelopeHash,
    dispatchIssuedAt,
    dispatchExpiresAt,
    dispatchSig,
  };
}

export async function assertChildDispatchAuthorized(env: DispatchEnv, input: CodingTaskInput, now = Date.now()): Promise<void> {
  const { dispatchApprovalId, dispatchInputHash, dispatchEnvelopeHash, dispatchSig, sandboxId } = input;
  if (
    typeof dispatchApprovalId !== "string" ||
    typeof dispatchInputHash !== "string" ||
    typeof dispatchEnvelopeHash !== "string" ||
    typeof dispatchSig !== "string" ||
    !/^(?:v1:[a-f0-9]{16}:)?[a-f0-9]{64}$/.test(dispatchSig)
  ) {
    throw new Error("This coding task was not dispatched by an approved parent run.");
  }
  if (!env.INTERNAL_SIGNING_KEY && !modelCredentialKeyConfigured(env)) {
    throw new Error("INTERNAL_SIGNING_KEY not set; child dispatch verification is not configured.");
  }
  if (!Number.isSafeInteger(input.dispatchIssuedAt) || !Number.isSafeInteger(input.dispatchExpiresAt) ||
      input.dispatchIssuedAt! > now || input.dispatchExpiresAt! <= now ||
      input.dispatchExpiresAt! - input.dispatchIssuedAt! > RUN_DEADLINE_MS) {
    throw new Error("Child execution deadline exceeded.");
  }
  if (dispatchEnvelopeHash !== await childDispatchEnvelopeHash(input)) {
    throw new Error("Dispatch envelope changed after approval.");
  }
  const legacy = env.INTERNAL_SIGNING_KEY?.trim() || (modelCredentialKeyConfigured(env) ? env.MODEL_CREDENTIAL_KEY : undefined);
  if (!await verifyInternal(env, "shiba/child-dispatch/v1", canonical(dispatchApprovalId, sandboxId, dispatchInputHash, dispatchEnvelopeHash), dispatchSig, legacy)) {
    throw new Error("Dispatch seal is invalid or expired.");
  }
}
