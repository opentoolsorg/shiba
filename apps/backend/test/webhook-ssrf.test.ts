import { describe, expect, it } from "vitest";
import { validateWebhookDestination } from "../src/webhooks/ssrf.js";

describe("webhook SSRF guard", () => {
  it("rejects non-https URLs", () => {
    expect(validateWebhookDestination("http://example.com/hook").ok).toBe(false);
  });

  it("rejects private loopback URLs", () => {
    expect(validateWebhookDestination("http://127.0.0.1/hook").ok).toBe(false);
    expect(validateWebhookDestination("https://127.0.0.1/hook").ok).toBe(false);
  });

  it("accepts public https endpoints", () => {
    expect(validateWebhookDestination("https://hooks.example.com/shiba").ok).toBe(true);
  });
});