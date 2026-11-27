import { SCOPE_VALUES, type CredentialScope, type ReadAdapter } from "./adapter.js";

type Sealer = Pick<ReadAdapter, "id" | "wire" | "seal" | "scopeColumns">;
const enc = new TextEncoder();
const invalid = (adapter: Sealer) => new Error(`${adapter.id}_credential_invalid`);

const b64 = (value: Uint8Array) => btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join("")).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const un64 = (value: string, adapter: Sealer) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalid(adapter);
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
  // atob ignores the unused trailing bits; only the canonical spelling this module wrote is accepted.
  if (b64(bytes) !== value) throw invalid(adapter);
  return bytes;
};

/** The AAD binds the ciphertext to its exact grant scope; scope columns sit between the account and the expiry. */
function aad(scope: CredentialScope, adapter: Sealer) {
  if (!/^ws_[a-f0-9]{24}$/.test(scope.workspaceId) || !/^[A-Za-z0-9_-]{1,200}$/.test(scope.ownerAccountId) || !new RegExp(`^${adapter.wire.grantPrefix}[a-f0-9]{32}$`).test(scope.credentialId) || !Number.isSafeInteger(scope.revision) || scope.revision < 1 || !adapter.seal.account.test(scope.accountId) || adapter.scopeColumns.some((column) => !(SCOPE_VALUES[column] as readonly string[]).includes(scope[column] ?? "")) || !Number.isSafeInteger(scope.expiresAt) || scope.expiresAt < 1) throw new Error(`${adapter.id}_credential_scope_invalid`);
  return enc.encode(JSON.stringify([adapter.seal.aadDomain, scope.workspaceId, scope.ownerAccountId, scope.credentialId, scope.revision, scope.accountId, ...adapter.scopeColumns.map((column) => scope[column]), scope.expiresAt]));
}

async function key(secret: string, adapter: Sealer) {
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error(`${adapter.id}_credential_key_unavailable`);
  const material = await crypto.subtle.importKey("raw", Uint8Array.from(secret.match(/../g)!, (part) => parseInt(part, 16)), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode(adapter.seal.salt), info: enc.encode(adapter.seal.info) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function token(value: string, scope: CredentialScope, adapter: Sealer) {
  if (!adapter.seal.token(scope).test(value)) throw new Error(`${adapter.id}_credential_token_invalid`);
}

export async function sealCredential(adapter: Sealer, value: string, secret: string, scope: CredentialScope) {
  token(value, scope, adapter);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(scope, adapter) }, await key(secret, adapter), enc.encode(value));
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { ciphertext: `v1.${b64(iv)}.${b64(new Uint8Array(data))}`, fingerprint };
}

export async function openCredential(adapter: Sealer, value: string, secret: string, scope: CredentialScope) {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw invalid(adapter);
  const iv = un64(parts[1]!, adapter);
  if (iv.length !== 12) throw invalid(adapter);
  const result = new TextDecoder("utf-8", { fatal: true }).decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(scope, adapter) }, await key(secret, adapter), un64(parts[2]!, adapter)));
  token(result, scope, adapter);
  return result;
}
