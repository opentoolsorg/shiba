import { describe, expect, it } from "vitest";
import {
  parseSubscriptionStatus,
  pasteFieldAfterSuccessfulConnect,
  pasteRequestBody,
} from "./chatgpt-subscription-wire";

describe("A9 ChatGPT subscription settings wire", () => {
  it("shows paste flow metadata without echoing secrets back", () => {
    const secret = JSON.stringify({ tokens: { access_token: "eyJsecret", refresh_token: "rt" } });
    const body = pasteRequestBody(secret);
    expect(body).toContain("authJson");
    expect(parseSubscriptionStatus({ connected: true, savedAt: 1 })).toEqual({ connected: true, savedAt: 1 });
    expect(parseSubscriptionStatus({ connected: true, savedAt: 1, authJson: secret } as Record<string, unknown>)).not.toHaveProperty(
      "authJson",
    );
    expect(pasteFieldAfterSuccessfulConnect(secret)).toBe("");
  });

  it("disconnect is modeled as connected false", () => {
    expect(parseSubscriptionStatus({ connected: false })).toEqual({ connected: false });
  });
});
