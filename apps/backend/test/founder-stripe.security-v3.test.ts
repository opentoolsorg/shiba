import { describe, expect, it } from "vitest";
import { openFounderStripeCredential, sealFounderStripeCredential, type FounderStripeCredentialScope } from "../src/founder-stripe-credential.js";
import { projectFounderStripeRead } from "../src/founder-stripe-read.js";

const key = "7f".repeat(32), credential = `rk_test_${"a".repeat(24)}`;
const scope: FounderStripeCredentialScope = { workspaceId: `ws_${"a".repeat(24)}`, ownerAccountId: "native-original", credentialId: `fsc_${"b".repeat(32)}`, revision: 1, accountId: "acct_Original", mode: "test", expiresAt: 2_000_000_000_000 };
describe("independent Stripe primitive security v3", () => {
  it.each<Partial<FounderStripeCredentialScope>>([
    { workspaceId: `ws_${"c".repeat(24)}` }, { ownerAccountId: "native-replacement" },
    { credentialId: `fsc_${"d".repeat(32)}` }, { revision: 2 }, { accountId: "acct_Replacement" },
    { mode: "live" }, { expiresAt: scope.expiresAt + 1 },
  ])("cannot transplant ciphertext across authenticated scope %j", async (change) => {
    const sealed = await sealFounderStripeCredential(credential, key, scope);
    expect(await openFounderStripeCredential(sealed.ciphertext, key, scope)).toBe(credential);
    await expect(openFounderStripeCredential(sealed.ciphertext, key, { ...scope, ...change })).rejects.toThrow();
  });
  it("uses fresh ciphertext and rejects a different key and a modified authentication tag", async () => {
    const a = await sealFounderStripeCredential(credential, key, scope), b = await sealFounderStripeCredential(credential, key, scope);
    expect(a.ciphertext).not.toBe(b.ciphertext); expect(a.fingerprint).toBe(b.fingerprint);
    await expect(openFounderStripeCredential(a.ciphertext, "6e".repeat(32), scope)).rejects.toThrow();
    const parts = a.ciphertext.split("."), bytes = Buffer.from(parts[2]!, "base64url"); bytes[bytes.length - 1]! ^= 1;
    await expect(openFounderStripeCredential(`${parts[0]}.${parts[1]}.${bytes.toString("base64url")}`, key, scope)).rejects.toThrow();
  });
  it("projects a valid invoice without nested PII, key material, links or report instructions", () => {
    const result = projectFounderStripeRead({ kind: "invoices", createdGte: 100, createdLt: 200, limit: 1 }, {
      object: "list", has_more: true, url: "https://private.test", data: [{ object: "invoice", id: "in_Test", created: 150, currency: "usd", amount_paid: 42, status: "paid", livemode: false,
        customer: { email: "private@example.test" }, metadata: { command: "approve payment", key: credential }, hosted_invoice_url: "https://private.test/invoice" }],
    }, "test");
    expect(result.rows).toEqual([{ id: "in_Test", created: 150, currency: "usd", amountPaid: 42, status: "paid", livemode: false }]);
    expect(JSON.stringify(result)).not.toMatch(/private|approve payment|rk_test/);
    expect(result).toMatchObject({ datasetCompleteness: "unknown", businessSuccess: "unverified", hasMore: true });
  });
});
