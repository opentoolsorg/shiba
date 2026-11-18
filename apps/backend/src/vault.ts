import type { Env } from "./env.js";

export type VaultEnv = Pick<Env, "MODEL_CREDENTIAL_KEY" | "VAULT_KEYRING" | "VAULT_WRITE_V2">;
export type VaultKey = string | VaultEnv;
export type LegacyCipher = { aad: Uint8Array<ArrayBuffer> };
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HEX = /^[a-f0-9]{64}$/i;
const ID = /^[a-z0-9-]+$/;

function encode(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid vault ciphertext.");
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  if (encode(bytes) !== value) throw new Error("Invalid vault ciphertext.");
  return bytes;
}
function decodeLegacy(value: string): Uint8Array<ArrayBuffer> {
  if (!value) throw new Error("Invalid vault ciphertext.");
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
}
function secret(key: VaultKey): string {
  const hex = typeof key === "string" ? key : key.MODEL_CREDENTIAL_KEY;
  if (!HEX.test(hex ?? "")) throw new Error("Vault encryption key is unavailable.");
  return hex!;
}
function keyring(key: VaultKey): { current: string; keys: Record<string, string> } {
  const keys: Record<string, string> = Object.create(null) as Record<string, string>;
  keys.legacy = secret(key);
  if (typeof key === "string" || !key.VAULT_KEYRING) return { current: "legacy", keys };
  const config = JSON.parse(key.VAULT_KEYRING) as { current?: unknown; keys?: unknown };
  if (!config || typeof config.current !== "string" || !ID.test(config.current) ||
      !config.keys || typeof config.keys !== "object" || Array.isArray(config.keys)) throw new Error("Invalid vault keyring.");
  for (const [kid, hex] of Object.entries(config.keys)) {
    if (!ID.test(kid) || kid === "legacy" || typeof hex !== "string" || !HEX.test(hex)) throw new Error("Invalid vault keyring.");
    keys[kid] = hex;
  }
  if (!Object.hasOwn(keys, config.current)) throw new Error("Unknown active vault key.");
  return { current: config.current, keys };
}
async function aesKey(hex: string, hkdf?: { salt: string; info: string }): Promise<CryptoKey> {
  if (!HEX.test(hex)) throw new Error("Vault encryption key is unavailable.");
  const raw = Uint8Array.from(hex.match(/../g)!, (part) => Number.parseInt(part, 16));
  if (!hkdf) return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  const material = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode(hkdf.salt), info: encoder.encode(hkdf.info) },
    material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
function binding(kid: string, purpose: string, legacy: LegacyCipher): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(["shiba-vault-v2", kid, purpose, encode(legacy.aad)]));
}

export async function encryptSecret(plaintext: string, key: VaultKey, purpose: string, legacy: LegacyCipher): Promise<string> {
  if (!ID.test(purpose)) throw new Error("Invalid vault purpose.");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  if (typeof key === "string" || key.VAULT_WRITE_V2 !== "1") {
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: legacy.aad, tagLength: 128 },
      await aesKey(secret(key)), encoder.encode(plaintext));
    return `v1.${encode(iv)}.${encode(new Uint8Array(cipher))}`;
  }
  const { current, keys } = keyring(key);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: binding(current, purpose, legacy), tagLength: 128 },
    await aesKey(keys[current]!, { salt: "shiba-vault-v2", info: purpose }), encoder.encode(plaintext));
  return `v2.${current}.${purpose}.${encode(iv)}.${encode(new Uint8Array(cipher))}`;
}

export async function decryptSecret(ciphertext: string, key: VaultKey, purpose: string, legacy: LegacyCipher): Promise<string> {
  if (!ID.test(purpose)) throw new Error("Invalid vault purpose.");
  const parts = ciphertext.split(".");
  // Dispatch by version; legacy three-part v1 keeps its original codec and key.
  if (!ciphertext.startsWith("v2.")) {
    if (parts.length !== 3 || parts[0] !== "v1") throw new Error("Invalid vault ciphertext.");
    const iv = decodeLegacy(parts[1]!);
    if (iv.length !== 12) throw new Error("Invalid vault ciphertext.");
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: legacy.aad, tagLength: 128 },
      await aesKey(secret(key)), decodeLegacy(parts[2]!)));
  }
  if (parts.length !== 5 || !ID.test(parts[1]!) || parts[2] !== purpose) throw new Error("Invalid vault ciphertext purpose.");
  const [, kid, , encodedIv, encodedCipher] = parts;
  const { keys } = keyring(key);
  if (!Object.hasOwn(keys, kid!)) throw new Error("Unknown vault key id.");
  const iv = decode(encodedIv!);
  if (iv.length !== 12) throw new Error("Invalid vault ciphertext.");
  return decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: binding(kid!, purpose, legacy), tagLength: 128 },
    await aesKey(keys[kid!]!, { salt: "shiba-vault-v2", info: purpose }), decode(encodedCipher!)));
}
