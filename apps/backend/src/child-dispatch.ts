/**
 * Parent-orchestrator seal on child coding envelopes. OpenCodeAgent refuses
 * execution when the seal is missing or wrong, so a nested chat message cannot
 * forge an approved run.
 */
import type { Env } from "./env.js";
import type { CodingTaskInput } from "./opencode-input.js";
import { modelCredentialKeyConfigured } from "./subscription-credentials.js";

const DISPATCH_SCOPE = "opencode-child-dispatch-v1";

type DispatchEnv = Pick<Env, "INTERNAL_SIGNING_KEY" | "MODEL_CREDENTIAL_KEY">;

function signingKey(env: DispatchEnv): string | null {
  const internal = env.INTERNAL_SIGNING_KEY?.trim();
  if (internal) return internal;
  if (modelCredentialKeyConfigured(env)) return env.MODEL_CREDENTIAL_KEY!;
  return null;
}

async function hmacHex(key: string, message: string): Promise<string> {
  const raw = new TextEncoder().encode(key);
  const cryptoKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

function canonical(approvalId: string, sandboxId: string, inputHash: string): string {
  return [DISPATCH_SCOPE, approvalId, sandboxId, inputHash].join("\n");
}

export async function sealChildDispatch(
  env: DispatchEnv,
  fields: { approvalId: string; sandboxId: string; inputHash: string },
): Promise<Pick<CodingTaskInput, "dispatchApprovalId" | "dispatchInputHash" | "dispatchSig">> {
  const key = signingKey(env);
  if (!key) {
    throw new Error("Child dispatch signing is not configured (INTERNAL_SIGNING_KEY or MODEL_CREDENTIAL_KEY).");
  }
  const dispatchInputHash = fields.inputHash;
  const dispatchSig = await hmacHex(key, canonical(fields.approvalId, fields.sandboxId, dispatchInputHash));
  return {
    dispatchApprovalId: fields.approvalId,
    dispatchInputHash,
    dispatchSig,
  };
}

export async function assertChildDispatchAuthorized(env: DispatchEnv, input: CodingTaskInput): Promise<void> {
  const { dispatchApprovalId, dispatchInputHash, dispatchSig, sandboxId } = input;
  if (
    typeof dispatchApprovalId !== "string" ||
    typeof dispatchInputHash !== "string" ||
    typeof dispatchSig !== "string" ||
    !/^[a-f0-9]{64}$/.test(dispatchSig)
  ) {
    throw new Error("This coding task was not dispatched by an approved parent run.");
  }
  const key = signingKey(env);
  if (!key) {
    throw new Error("Child dispatch verification is not configured.");
  }
  const expected = await hmacHex(key, canonical(dispatchApprovalId, sandboxId, dispatchInputHash));
  if (expected !== dispatchSig) {
    throw new Error("Dispatch seal is invalid or expired.");
  }
}
