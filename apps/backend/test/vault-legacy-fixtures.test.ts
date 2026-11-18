import { describe, expect, it, vi } from "vitest";
import { encryptAuthJson, decryptAuthJson } from "../src/subscription-credentials.js";
import { encryptGmailToken, decryptGmailToken } from "../src/gmail.js";
import { decryptSecret, encryptSecret, type VaultKey } from "../src/vault.js";
import { sealWebhookSecret, openWebhookSecret } from "../src/webhooks/secrets.js";
import { sealRunEnv, openRunEnv } from "../src/run-env-seal.js";
import { putOrgSecret, getDecryptedOrgSecret } from "../src/org-secrets-store.js";

const KEY = "01".repeat(32);
// Captured with the pre-vault functions and a fixed IV, before replacing their crypto.
const cases = [
  { name: "subscription", plain: "fixture-secret", cipher: "v1.BwcHBwcHBwcHBwcH.65qS0Hrc1Ixq_2dCw7SHGVw0s6AdtZeiSPghnBjj",
    encrypt: (k: VaultKey) => encryptAuthJson("fixture-secret", k, "workspace", "user", "kind"), decrypt: (c: string, k: VaultKey) => decryptAuthJson(c, k, "workspace", "user", "kind") },
  { name: "gmail", plain: "fixture-secret", cipher: "v1.BwcHBwcHBwcHBwcH.65qS0Hrc1Ixq_2dCw7Rg7iwhLPZ3qlkb96HcVNVQ",
    encrypt: (k: VaultKey) => encryptGmailToken("fixture-secret", k, "owner", "connection"), decrypt: (c: string, k: VaultKey) => decryptGmailToken(c, k, "owner", "connection") },
];
const env = { MODEL_CREDENTIAL_KEY: KEY, VAULT_WRITE_V2: "1" };
const legacy = { aad: new TextEncoder().encode("owner-and-resource") };
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

// Independent copy of the old subscription codec; keeps legacy compatibility tests out of the new vault.
async function oldEncrypt(plain: string, workspace: string, user: string, kind: string): Promise<string> {
  const iv = new Uint8Array(12).fill(7);
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(KEY.match(/../g)!, (part) => Number.parseInt(part, 16)), "AES-GCM", false, ["encrypt"]);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(JSON.stringify(["subscription-credential-v1", workspace, user, kind])), tagLength: 128 }, key, new TextEncoder().encode(plain));
  return `v1.${encode(iv)}.${encode(new Uint8Array(cipher))}`;
}

describe("vault legacy compatibility", () => {
  for (const row of cases) {
    it(`${row.name}: reads old bytes and writes byte-identical legacy ciphertext by default`, async () => {
      expect(await row.decrypt(row.cipher, env)).toBe(row.plain);
      const spy = vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => { (array as Uint8Array).fill(7); return array; });
      try {
        expect(await row.encrypt({ MODEL_CREDENTIAL_KEY: KEY })).toBe(row.cipher);
        expect(await row.encrypt({ ...env, VAULT_WRITE_V2: "0" })).toBe(row.cipher);
      } finally { spy.mockRestore(); }
    });
    it(`${row.name}: keyed writes round trip and remain readable with writes off`, async () => {
      const cipher = await row.encrypt(env);
      expect(cipher.split(".")).toHaveLength(5);
      expect(await row.decrypt(cipher, { ...env, VAULT_WRITE_V2: "0" })).toBe(row.plain);
      await expect(row.decrypt(cipher, { ...env, MODEL_CREDENTIAL_KEY: "02".repeat(32) })).rejects.toThrow();
    });
  }
  it.each([
    ["default", "owner", "openai-subscription"],
    ["default", "owner", "chatgpt-host-id"],
    ["org", "provider", "model_key"],
    ["installation", "owner", "openai-api"],
    ["default", "owner", "google-antigravity-oauth"],
    ["default", "owner", "oauth-pending:cursor:verifier"],
    ["org", "owner", "external-mcp-oauth:server"],
    ["org", "owner", "external-mcp-pending:server"],
    ["workspace", "subscription", "webhook-subscription-secret"],
    ["run-env", "owner", "approved-digest"],
    ["workspace", "team", "slack-installation-v1:bot-token"],
  ])("retains the old codec and context binding for %s/%s/%s", async (workspace, user, kind) => {
    const old = await oldEncrypt("legacy-secret", workspace, user, kind);
    expect(await decryptAuthJson(old, env, workspace, user, kind)).toBe("legacy-secret");
    const spy = vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => { (array as Uint8Array).fill(7); return array; });
    try { expect(await encryptAuthJson("legacy-secret", KEY, workspace, user, kind)).toBe(old); }
    finally { spy.mockRestore(); }
    await expect(decryptAuthJson(old, env, workspace, "other-owner", kind)).rejects.toThrow();
  });
});

describe("vault keyring", () => {
  it("rotates current key without rewriting or losing old and legacy ciphertext", async () => {
    const a = { ...env, VAULT_KEYRING: JSON.stringify({ current: "a", keys: { a: "aa".repeat(32) } }) };
    const b = { ...env, VAULT_KEYRING: JSON.stringify({ current: "b", keys: { a: "aa".repeat(32), b: "bb".repeat(32) } }) };
    const old = await encryptSecret("secret", a, "oauth", legacy);
    const fresh = await encryptSecret("secret", b, "oauth", legacy);
    expect(old.startsWith("v2.a.oauth.")).toBe(true);
    expect(fresh.startsWith("v2.b.oauth.")).toBe(true);
    expect(await decryptSecret(old, b, "oauth", legacy)).toBe("secret");
    expect(await decryptSecret(fresh, b, "oauth", legacy)).toBe("secret");
    expect(await decryptAuthJson(cases[0]!.cipher, b, "workspace", "user", "kind")).toBe("fixture-secret");
    await expect(decryptSecret(fresh, a, "oauth", legacy)).rejects.toThrow(/Unknown vault key id/);
  });
  it("fails closed for wrong purpose, binding, key id, tampering and malformed envelopes", async () => {
    const cipher = await encryptSecret("secret", env, "oauth", legacy);
    await expect(decryptSecret(cipher, env, "provider", legacy)).rejects.toThrow();
    await expect(decryptSecret(cipher.replace(".oauth.", ".provider."), env, "provider", legacy)).rejects.toThrow();
    await expect(decryptSecret(cipher, env, "oauth", { aad: new TextEncoder().encode("other-owner") })).rejects.toThrow();
    await expect(decryptSecret(cipher.replace(".legacy.", ".missing."), env, "oauth", legacy)).rejects.toThrow(/Unknown vault key id/);
    for (const invalid of ["v2.a.oauth", "v2.a.oauth.bad.bad.extra", cipher.replace("v2.", "v1."), cipher + ".", cipher.slice(0, -2)]) {
      await expect(decryptSecret(invalid, env, "oauth", legacy)).rejects.toThrow();
    }
  });
  it("validates keyring and reserves legacy kid against accidental overwrite", async () => {
    for (const config of ["not-json", "null", JSON.stringify({ current: "missing", keys: {} }), JSON.stringify({ current: "legacy", keys: { legacy: "aa".repeat(32) } }), JSON.stringify({ current: "a", keys: { a: "bad" } })]) {
      await expect(encryptSecret("secret", { ...env, VAULT_KEYRING: config }, "oauth", legacy)).rejects.toThrow();
    }
  });
  it("passes configuration through webhook, run-env and org-secret storage wrappers", async () => {
    const keyed = { ...env, VAULT_KEYRING: JSON.stringify({ current: "a", keys: { a: "aa".repeat(32) } }) };
    const webhook = await sealWebhookSecret(keyed, "workspace", "subscription", "webhook-secret");
    expect(webhook.cipher.startsWith("v2.a.")).toBe(true);
    expect(await openWebhookSecret({ ...keyed, VAULT_WRITE_V2: "0" }, "workspace", "subscription", webhook)).toBe("webhook-secret");
    const run = await sealRunEnv(keyed, "owner", [{ name: "API_KEY", value: "run-secret" }]);
    expect(run.sealed.startsWith("v2.a.")).toBe(true);
    expect(await openRunEnv(keyed, "owner", run.sealed, run.digest)).toEqual({ API_KEY: "run-secret" });
    let cipher = "";
    const db = { prepare: () => ({ bind: (...values: unknown[]) => ({
      run: async () => { cipher = values[3] as string; return { success: true }; },
      first: async () => ({ cipher }),
    }) }) } as unknown as D1Database;
    const org = { ...keyed, AGENT_AUDIT: db };
    await putOrgSecret(org, "org", "model_key", "provider", "org-secret");
    expect(cipher.startsWith("v2.a.")).toBe(true);
    expect(await getDecryptedOrgSecret(org, "org", "model_key", "provider")).toBe("org-secret");
  });
});
