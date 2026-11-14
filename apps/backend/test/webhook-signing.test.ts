import { describe, expect, it } from "vitest";
import { signWebhookPayload, verifyWebhookPayload } from "../src/webhooks/signing.js";

describe("webhook signing", () => {
  it("verifies a signed payload", async () => {
    const secret = "whsec_test_secret";
    const body = JSON.stringify({ hello: "world" });
    const ts = 1_700_000_000;
    const header = await signWebhookPayload(secret, body, ts);
    expect(await verifyWebhookPayload(secret, body, header, ts)).toBe(true);
    expect(await verifyWebhookPayload(secret, body, header, ts + 400)).toBe(false);
  });
});