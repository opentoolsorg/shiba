/** Worker-only signatures. Legacy raw keys require explicit caller opt-in during migration. */
export interface SigningEnv {
  INTERNAL_SIGNING_KEY?: string;
  MODEL_CREDENTIAL_KEY?: string;
  SHIBA_LEGACY_SIGNING_FALLBACK?: string;
}
const encoder = new TextEncoder();
let warned = false;
export function legacySigningFallback(env: SigningEnv): boolean {
  const enabled = (env.SHIBA_LEGACY_SIGNING_FALLBACK ?? "1") === "1";
  if (enabled && !warned) {
    warned = true;
    console.warn(
      "Legacy internal signing compatibility enabled for one release; set SHIBA_LEGACY_SIGNING_FALLBACK=0 after migration.",
    );
  }
  return enabled;
}
function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function derived(secret: string, purpose: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(purpose) },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}
async function keyId(secret: string): Promise<string> {
  return hex(
    await crypto.subtle.digest("SHA-256", encoder.encode(`shiba/signing-kid/v1\n${secret}`)),
  ).slice(0, 16);
}
export async function signInternal(
  env: SigningEnv,
  purpose: string,
  message: string,
  legacyKey?: string,
): Promise<string> {
  const secret = env.INTERNAL_SIGNING_KEY?.trim();
  if (!secret) {
    if (legacyKey && legacySigningFallback(env)) {
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(legacyKey),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
    }
    throw new Error("INTERNAL_SIGNING_KEY not set; internal signing is not configured.");
  }
  if (secret.length < 32)
    throw new Error("INTERNAL_SIGNING_KEY must contain at least 32 characters.");
  const kid = await keyId(secret);
  const mac = await crypto.subtle.sign(
    "HMAC",
    await derived(secret, purpose),
    encoder.encode(`v1:${kid}\n${message}`),
  );
  return `v1:${kid}:${hex(mac)}`;
}
export async function verifyInternal(
  env: SigningEnv,
  purpose: string,
  message: string,
  signature: string,
  legacyKey?: string,
): Promise<boolean> {
  const secret = env.INTERNAL_SIGNING_KEY?.trim();
  const match = /^v1:([a-f0-9]{16}):([a-f0-9]{64})$/.exec(signature);
  let key: CryptoKey;
  let mac: string;
  let payload = message;
  if (match) {
    if (!secret || secret.length < 32 || match[1] !== (await keyId(secret))) return false;
    key = await derived(secret, purpose);
    mac = match[2]!;
    payload = `v1:${match[1]}\n${message}`;
  } else {
    if (!legacyKey || !/^[a-f0-9]{64}$/.test(signature) || !legacySigningFallback(env))
      return false;
    key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(legacyKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    mac = signature;
  }
  const bytes = Uint8Array.from(mac.match(/../g)!, (pair) => Number.parseInt(pair, 16));
  return crypto.subtle.verify("HMAC", key, bytes, encoder.encode(payload));
}
