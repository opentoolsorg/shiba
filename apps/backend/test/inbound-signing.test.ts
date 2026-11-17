import { describe, expect, it } from "vitest";
import { generateInboundSecret, verifyInboundSignature } from "../src/webhooks/inbound-signing.js";
import { openInboundSecret, sealInboundSecret } from "../src/webhooks/secrets.js";

const now = 1_800_000_000_000;
async function signed(secret: string, body: string, standard = false, timestamp = String(now / 1000), id = "delivery-1") {
  const bytes = standard ? Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0)) : new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(standard ? `${id}.${timestamp}.${body}` : `${timestamp}.${id}.${body}`)));
  return new Headers(standard ? { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${btoa(String.fromCharCode(...digest))}` } : { "x-shiba-delivery-id": id, "x-shiba-timestamp": timestamp, "x-shiba-signature": `sha256=${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}` });
}

describe("signed inbound webhooks", () => {
  it.each([false, true])("verifies exact and empty bodies (standard=%s)", async (standard) => {
    const secret = generateInboundSecret();
    for (const body of ["", '{"event":"created"}', "héllo"]) {
      const headers = await signed(secret, body, standard);
      expect(await verifyInboundSignature(headers, body, secret, now)).toBe("delivery-1");
      expect(await verifyInboundSignature(headers, `${body} `, secret, now)).toBeNull();
      expect(await verifyInboundSignature(headers, body, generateInboundSecret(), now)).toBeNull();
    }
  });
  it.each([false, true])("rejects skew and malformed input (standard=%s)", async (standard) => {
    const secret = generateInboundSecret();
    for (const timestamp of [String(now / 1000 - 301), String(now / 1000 + 301), "NaN", "", "1.2"]) {
      expect(await verifyInboundSignature(await signed(secret, "", standard, timestamp), "", secret, now)).toBeNull();
    }
    expect(await verifyInboundSignature(new Headers(), "", secret, now)).toBeNull();
    const headers = await signed(secret, "", standard);
    headers.set(standard ? "webhook-signature" : "x-shiba-signature", "invalid");
    expect(await verifyInboundSignature(headers, "", secret, now)).toBeNull();
  });
  it("accepts any matching Standard Webhooks signature and gives Shiba headers precedence", async () => {
    const secret = generateInboundSecret();
    const headers = await signed(secret, "", true);
    headers.set("webhook-signature", `v1,%%% v1,${btoa("x".repeat(32))} ${headers.get("webhook-signature")}`);
    expect(await verifyInboundSignature(headers, "", secret, now)).toBe("delivery-1");
    headers.set("x-shiba-signature", "bad");
    expect(await verifyInboundSignature(headers, "", secret, now)).toBeNull();
  });
  it("encrypts secrets bound to a route and fails closed without a key", async () => {
    const env = { MODEL_CREDENTIAL_KEY: "ab".repeat(32) };
    const secret = generateInboundSecret();
    const stored = await sealInboundSecret(env, "one", secret);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(await openInboundSecret(env, "one", stored)).toBe(secret);
    await expect(openInboundSecret(env, "two", stored)).rejects.toThrow();
    await expect(sealInboundSecret({}, "one", secret)).rejects.toThrow("MODEL_CREDENTIAL_KEY");
  });
});
