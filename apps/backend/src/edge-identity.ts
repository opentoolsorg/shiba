/** Worker-to-DO authority headers use purpose-derived, versioned signatures. */
import { AGENT_PRINCIPAL_HEADER, LOCAL_INTAKE_HEADER } from "@shiba/shared";
import { legacySigningFallback, signInternal, verifyInternal, type SigningEnv } from "./security/signing.js";

export const INTERNAL_SIGNATURE_HEADER = "X-Shiba-Internal-Sig";
export const INTERNAL_TIMESTAMP_HEADER = "X-Shiba-Internal-Ts";

const MAX_SKEW_MS = 60_000;

const PURPOSE = "shiba/edge-identity/v1";

/** The fields that make a request "vouched" — what the signature protects. */
export function vouchedValues(request: Request): { principal: string | null; intake: string | null } {
  return {
    principal: request.headers.get(AGENT_PRINCIPAL_HEADER),
    intake: request.headers.get(LOCAL_INTAKE_HEADER),
  };
}

export function carriesVouchedHeaders(request: Request): boolean {
  const { principal, intake } = vouchedValues(request);
  return principal !== null || intake !== null;
}

function canonical(request: Request, timestamp: string): string {
  const url = new URL(request.url);
  const { principal, intake } = vouchedValues(request);
  return [
    request.method.toUpperCase(),
    url.pathname + url.search,
    principal ?? "",
    intake ?? "",
    timestamp,
  ].join("\n");
}

/**
 * Sign a request headed for a DO stub (or another internal consumer). Mutates
 * the request's headers — call after vouched headers are stamped, before
 * `stub.fetch`. Missing-key requests remain unsigned only during legacy grace.
 */
export async function signInternalRequest(request: Request, env: SigningEnv): Promise<void> {
  const secret = env.INTERNAL_SIGNING_KEY?.trim();
  if (!secret && legacySigningFallback(env)) return;
  const timestamp = Date.now().toString();
  const sig = await signInternal(env, PURPOSE, canonical(request, timestamp));
  request.headers.set(INTERNAL_TIMESTAMP_HEADER, timestamp);
  request.headers.set(INTERNAL_SIGNATURE_HEADER, sig);
}

export type InternalVerification =
  | { ok: true; signed: boolean }
  | { ok: false; reason: string };

/**
 * Verify an inbound internal request. Called by DO consumers that read
 * vouched headers as authority.
 *
 * - Key unset → legacy grace permits unsigned requests; strict mode refuses them.
 * - Key set + no vouched headers → ok, nothing to verify.
 * - Key set + vouched headers → valid signature within skew required; a
 *   missing/late/bad signature fails closed.
 */
export async function verifyInternalRequest(
  request: Request,
  env: SigningEnv,
  now = Date.now(),
): Promise<InternalVerification> {
  const secret = env.INTERNAL_SIGNING_KEY?.trim();
  if (!secret) return legacySigningFallback(env)
    ? { ok: true, signed: false }
    : { ok: false, reason: "INTERNAL_SIGNING_KEY not set" };
  if (!carriesVouchedHeaders(request)) return { ok: true, signed: false };

  const timestamp = request.headers.get(INTERNAL_TIMESTAMP_HEADER);
  const signature = request.headers.get(INTERNAL_SIGNATURE_HEADER);
  if (!timestamp || !signature) return { ok: false, reason: "missing_signature" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) {
    return { ok: false, reason: "stale_signature" };
  }
  if (!/^(?:v1:[a-f0-9]{16}:)?[a-f0-9]{64}$/.test(signature)) {
    return { ok: false, reason: "malformed_signature" };
  }
  const valid = await verifyInternal(env, PURPOSE, canonical(request, timestamp), signature, secret);
  return valid ? { ok: true, signed: true } : { ok: false, reason: "bad_signature" };
}
