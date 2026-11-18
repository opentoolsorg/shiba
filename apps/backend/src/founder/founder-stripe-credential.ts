/** Stripe-only cryptographic domain. These functions never perform network access or log key material. */
const enc = new TextEncoder();
const HEX = /^[a-f0-9]{64}$/i;
export type FounderStripeMode = "live" | "test";
export interface FounderStripeCredentialScope { workspaceId: string; ownerAccountId: string; credentialId: string; revision: number; accountId: string; mode: FounderStripeMode; expiresAt: number }
function validateScope(scope: FounderStripeCredentialScope) {
  if (!/^ws_[a-f0-9]{24}$/.test(scope.workspaceId) || !/^[A-Za-z0-9_-]{1,200}$/.test(scope.ownerAccountId) || !/^fsc_[a-f0-9]{32}$/.test(scope.credentialId) || !Number.isSafeInteger(scope.revision) || scope.revision < 1 || !/^acct_[A-Za-z0-9]{1,200}$/.test(scope.accountId) || !["live", "test"].includes(scope.mode) || !Number.isSafeInteger(scope.expiresAt) || scope.expiresAt < 1) throw new Error("stripe_credential_scope_invalid");
}
function aad(scope: FounderStripeCredentialScope) { validateScope(scope); return enc.encode(JSON.stringify(["shiba.founder-stripe.credential.v1", scope.workspaceId, scope.ownerAccountId, scope.credentialId, scope.revision, scope.accountId, scope.mode, scope.expiresAt])); }
function toBase64(v: Uint8Array) { let text = ""; for (const byte of v) text += String.fromCharCode(byte); return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
function fromBase64(v: string) { if (!/^[A-Za-z0-9_-]+$/.test(v)) throw new Error("stripe_credential_invalid"); const text = atob(v.replaceAll("-", "+").replaceAll("_", "/")); return Uint8Array.from(text, c => c.charCodeAt(0)); }
async function key(secret: string) {
  if (!HEX.test(secret)) throw new Error("stripe_credential_key_unavailable");
  const raw = Uint8Array.from(secret.match(/../g)!, p => Number.parseInt(p, 16));
  const material = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("shiba.founder-stripe.v1"), info: enc.encode("restricted-key encryption") }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
function validateRestrictedKey(value: string, mode: FounderStripeMode) {
  if (!(mode === "live" ? /^rk_live_[A-Za-z0-9]{16,250}$/ : /^rk_test_[A-Za-z0-9]{16,250}$/).test(value)) throw new Error("stripe_restricted_key_required");
}
export async function sealFounderStripeCredential(value: string, secret: string, scope: FounderStripeCredentialScope) {
  validateRestrictedKey(value, scope.mode); const additionalData = aad(scope), iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, await key(secret), enc.encode(value));
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))), n => n.toString(16).padStart(2, "0")).join("");
  return { ciphertext: `v1.${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`, fingerprint };
}
/** Internal-only; caller must revalidate the exact current native-owner grant and reserve a call first. */
export async function openFounderStripeCredential(ciphertext: string, secret: string, scope: FounderStripeCredentialScope) {
  const parts = ciphertext.split("."); if (parts.length !== 3 || parts[0] !== "v1") throw new Error("stripe_credential_invalid");
  const iv = fromBase64(parts[1]!); if (iv.length !== 12) throw new Error("stripe_credential_invalid");
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(scope) }, await key(secret), fromBase64(parts[2]!));
  const value = new TextDecoder("utf-8", { fatal: true }).decode(clear); validateRestrictedKey(value, scope.mode); return value;
}
