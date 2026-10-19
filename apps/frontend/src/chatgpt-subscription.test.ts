import { describe, expect, it } from "vitest";
import {
  callbackFieldAfterSuccess,
  completeRequestBody,
  parseSignInBegin,
  parseSubscriptionStatus,
} from "./chatgpt-subscription-wire";

describe("A9 ChatGPT settings wire", () => {
  it("parses status without secrets", () => {
    const status = parseSubscriptionStatus({ connected: true, expiresAt: 1, savedAt: 2 });
    expect(status.connected).toBe(true);
    expect(status).not.toHaveProperty("accessToken");
  });

  it("parse begin and complete body", () => {
    const begin = parseSignInBegin({
      authorizeUrl: "https://auth.openai.com/x",
      redirectUri: "http://127.0.0.1:1/auth/callback",
      flowId: "st",
    });
    expect(begin?.authorizeUrl).toContain("auth.openai.com");
    expect(completeRequestBody("http://127.0.0.1:1/auth/callback?code=x")).toContain("callbackUrl");
    expect(callbackFieldAfterSuccess("secret-url")).toBe("");
  });
});
