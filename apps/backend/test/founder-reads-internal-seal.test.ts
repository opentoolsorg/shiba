// Internal test: reaches past founder/reads/index.ts because the per-field AEAD scope binding is unreachable from the interface (the contract digest refuses the same change first).
import { describe, expect, it } from "vitest";
import { ADAPTERS, type CredentialScope } from "../src/founder/reads/adapter.js";
import { openCredential, sealCredential } from "../src/founder/reads/seal.js";

/**
 * The one read-grant test that goes below `founder/reads/index.ts`, and why: each field of the credential's
 * authenticated scope must on its own make the ciphertext unopenable. Through the interface a changed scope
 * field is always refused earlier by the contract digest, which covers the same fields, so the AEAD binding
 * can only be isolated at the seal seam. Nonce freshness is asserted here for the same reason: two grants never
 * share a scope (the credential id is in the AAD), so through the interface their ciphertexts differ even under a
 * constant nonce. Wrong key, altered tag and transplant between grants are also asserted through the interface in
 * founder-reads-lifecycle.test.ts.
 */
const key = "ab".repeat(32);
const cases = {
  stripe: { token: `rk_test_${"F".repeat(24)}`, scope: { credentialId: `fsc_${"b".repeat(32)}`, accountId: "acct_Fixture", mode: "test" }, changes: { accountId: "acct_Other", mode: "live" }, otherPrefix: `sk_test_${"F".repeat(24)}` },
  hubspot: { token: "fixture-hubspot-token-123456789", scope: { credentialId: `fhc_${"b".repeat(32)}`, accountId: "123" }, changes: { accountId: "124" }, otherPrefix: null },
  meta: { token: "syntheticMetaToken0123456789", scope: { credentialId: `fmc_${"b".repeat(32)}`, accountId: "123456" }, changes: { accountId: "654321" }, otherPrefix: null },
} as const;

describe.each(["stripe", "hubspot", "meta"] as const)("founder reads credential seal: %s", (provider) => {
  const adapter = ADAPTERS[provider], { token, changes, otherPrefix } = cases[provider];
  const scope = { workspaceId: `ws_${"a".repeat(24)}`, ownerAccountId: "native-owner", revision: 1, expiresAt: 2000000000000, ...cases[provider].scope } as CredentialScope;
  const transplants: Record<string, unknown>[] = [
    { workspaceId: `ws_${"c".repeat(24)}` }, { ownerAccountId: "native-replacement" }, { credentialId: `${scope.credentialId.slice(0, 4)}${"d".repeat(32)}` },
    { revision: 2 }, { expiresAt: scope.expiresAt + 1 }, ...Object.entries(changes).map(([field, value]) => ({ [field]: value })),
  ];

  it("opens under the exact scope it was sealed for, and keeps the credential out of the ciphertext", async () => {
    const sealed = await sealCredential(adapter, token, key, scope);
    expect(sealed.ciphertext).not.toContain(token);
    expect(sealed.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await openCredential(adapter, sealed.ciphertext, key, scope)).toBe(token);
  });

  it.each(transplants)("cannot be opened under a scope that differs by %j", async (change) => {
    const sealed = await sealCredential(adapter, token, key, scope);
    await expect(openCredential(adapter, sealed.ciphertext, key, { ...scope, ...change } as CredentialScope)).rejects.toThrow();
  });

  it("seals the same credential under the same scope with a fresh nonce, so the ciphertext differs and the fingerprint does not", async () => {
    const first = await sealCredential(adapter, token, key, scope), second = await sealCredential(adapter, token, key, scope);
    const [, firstNonce, firstData] = first.ciphertext.split("."), [, secondNonce, secondData] = second.ciphertext.split(".");
    expect(secondNonce).not.toBe(firstNonce);
    expect(secondData).not.toBe(firstData);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("cannot be opened once its authentication tag is altered", async () => {
    const sealed = await sealCredential(adapter, token, key, scope);
    const parts = sealed.ciphertext.split("."), data = Buffer.from(parts[2]!, "base64url");
    data[data.length - 1]! ^= 1;
    await expect(openCredential(adapter, `${parts[0]}.${parts[1]}.${data.toString("base64url")}`, key, scope)).rejects.toThrow();
  });

  it("cannot be opened with a different key", async () => {
    const sealed = await sealCredential(adapter, token, key, scope);
    await expect(openCredential(adapter, sealed.ciphertext, "6e".repeat(32), scope)).rejects.toThrow();
  });

  it("refuses to seal with a malformed key", async () => {
    await expect(sealCredential(adapter, token, "bad", scope)).rejects.toThrow();
  });

  // The draft schema refuses these at the route and the contract digest refuses a row changed to them, so the adapter's
  // own account pattern is only reachable here: no ciphertext may exist for a portal id that is not in canonical form.
  if (provider === "hubspot") {
    it.each(["0123", "1".repeat(17)])("refuses to seal under the non-canonical portal id %s", async (accountId) => {
      await expect(sealCredential(adapter, token, key, { ...scope, accountId })).rejects.toThrow("hubspot_credential_scope_invalid");
    });

    it.each(["0", "9".repeat(16)])("seals under the canonical portal id %s (control)", async (accountId) => {
      const sealed = await sealCredential(adapter, token, key, { ...scope, accountId });
      expect(await openCredential(adapter, sealed.ciphertext, key, { ...scope, accountId })).toBe(token);
    });
  }

  if (otherPrefix) it("refuses to seal a credential of the wrong kind", async () => {
    await expect(sealCredential(adapter, otherPrefix, key, scope)).rejects.toThrow();
  });
});
