import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { handleLinearWebhook } from "../src/linear/routes.js";

describe("Linear webhook unsigned override", () => {
  it('accepts unsigned payloads only when LINEAR_ALLOW_UNSIGNED_WEBHOOK is exactly "1"', async () => {
    const body = JSON.stringify({ type: "unknown", action: "created" });
    const makeRequest = () =>
      new Request("https://example.com/api/linear/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }) as Request;
    for (const value of ["0", "false", "yes"]) {
      const response = await handleLinearWebhook(makeRequest(), {
        LINEAR_ALLOW_UNSIGNED_WEBHOOK: value,
      } as Env);
      expect(response?.status).toBe(503);
    }
    const allowed = await handleLinearWebhook(makeRequest(), { LINEAR_ALLOW_UNSIGNED_WEBHOOK: "1" } as Env);
    expect(allowed?.status).not.toBe(503);
  });
});
