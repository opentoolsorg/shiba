import { operatorExact, operatorRecord, parseOperatorJson } from "@shiba/openconnector-read-gateway";
import type { OperatorRedeemCapability } from "./openconnector-operator-authority.js";

const invalid = () => new Error("operator_parent_capability_invalid");
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function decode(source: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(source)) throw invalid();
  const result = Uint8Array.from(atob(source.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
  if (encode(result) !== source) throw invalid();
  return result;
}
function payload(value: unknown): OperatorRedeemCapability {
  const r = operatorRecord(value);
  operatorExact(r, ["stage", "invocationId", "approvalId", "requestDigest", "deploymentEpoch", "expiresAt"]);
  if (r.stage !== "redeem" || ![r.invocationId, r.approvalId, r.deploymentEpoch].every(id => typeof id === "string" && /^[A-Za-z0-9_.:@/-]{1,200}$/.test(id))
    || typeof r.requestDigest !== "string" || !/^[a-f0-9]{64}$/.test(r.requestDigest)
    || !Number.isSafeInteger(r.expiresAt) || Number(r.expiresAt) <= 0) throw invalid();
  return { stage: "redeem", invocationId: String(r.invocationId), approvalId: String(r.approvalId),
    requestDigest: r.requestDigest, deploymentEpoch: String(r.deploymentEpoch), expiresAt: Number(r.expiresAt) };
}
function checkKey(key: CryptoKey, usage: "sign" | "verify"): void {
  const algorithm = key.algorithm as HmacKeyAlgorithm;
  if (key.type !== "secret" || algorithm.name !== "HMAC" || algorithm.hash?.name !== "SHA-256"
    || algorithm.length < 256 || !key.usages.includes(usage)) throw invalid();
}
/** Existing parent-only signing key. This helper neither creates nor persists credentials. */
export async function signOperatorRedeemCapability(key: CryptoKey, input: OperatorRedeemCapability): Promise<string> {
  checkKey(key, "sign");
  const encoded = encode(new TextEncoder().encode(JSON.stringify(payload(structuredClone(input)))));
  const preimage = `shiba.operator-redeem-capability.v1.${encoded}`;
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(preimage));
  return `v1.${encoded}.${encode(new Uint8Array(signature))}`;
}
/** Signature checking is not admission; the coordinator checks every bound field and current authority. */
export async function verifyOperatorRedeemCapability(key: CryptoKey, capability: string): Promise<OperatorRedeemCapability> {
  checkKey(key, "verify");
  if (typeof capability !== "string" || capability.length > 4096) throw invalid();
  const parts = capability.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) throw invalid();
  const signature = decode(parts[2]), body = decode(parts[1]);
  if (signature.length !== 32 || !await crypto.subtle.verify("HMAC", key, signature,
    new TextEncoder().encode(`shiba.operator-redeem-capability.v1.${parts[1]}`))) throw invalid();
  return payload(parseOperatorJson(new TextDecoder("utf-8", { fatal: true }).decode(body)));
}
