import { describe, expect, it, vi } from "vitest";
import { forwardClaudeSubscription, forwardCodexSubscription, type EgressEnv } from "../src/egress.js";
import { antigravitySubscriptionHarness } from "../src/harness/antigravity-subscription.js";

const env = {
  CLAUDE_SUBSCRIPTION_TOKEN: "real-claude-token",
  CODEX_SUBSCRIPTION_AUTH_JSON: JSON.stringify({ tokens: { access_token: "real-codex-token", account_id: "account" } }),
} as unknown as EgressEnv;

describe("subscription credential destination scope", () => {
  it.each([
    "https://api.anthropic.com/v1/organizations",
    "https://api.anthropic.com/v1/messages-evil",
    "https://api.anthropic.com/v1/messages/../organizations",
    "https://api.anthropic.com/v1/messages/%2e%2e%2forganizations",
    "https://api.anthropic.com:444/v1/messages",
    "https://claude.ai/api/organizations",
    "https://claude.ai/v1/messages",
  ])("never forwards Claude credentials to %s", async (url) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    try {
      expect((await forwardClaudeSubscription(new Request(url, { method: "POST" }), env)).status).toBe(403);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it.each([
    "https://chatgpt.com/backend-api/conversations",
    "https://chatgpt.com/backend-api/codex-evil/responses",
    "https://chatgpt.com/backend-api/codex/../conversations",
    "https://chatgpt.com/backend-api/codex/%2e%2e%2fconversations",
    "https://chatgpt.com/backend-api/codex/%252e%252e%252fconversations",
    "https://chatgpt.com:444/backend-api/codex/responses",
  ])("never forwards Codex credentials to %s", async (url) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    try {
      expect((await forwardCodexSubscription(new Request(url), env)).status).toBe(403);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it.each([
    [forwardClaudeSubscription, "https://api.anthropic.com/v1/messages", "POST", "real-claude-token"],
    [forwardClaudeSubscription, "https://api.anthropic.com/v1/messages/count_tokens", "POST", "real-claude-token"],
    [forwardClaudeSubscription, "https://api.anthropic.com/v1/models?limit=1", "GET", "real-claude-token"],
    [forwardCodexSubscription, "https://chatgpt.com/backend-api/codex/responses", "POST", "real-codex-token"],
    [forwardCodexSubscription, "https://chatgpt.com/backend-api/wham/usage", "GET", "real-codex-token"],
  ] as const)("forwards required API %s %s without following redirects", async (forward, url, method, token) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, {
      status: 302, headers: { location: "https://evil.example/token" },
    }));
    try {
      const response = await forward(new Request(url, { method }), env);
      expect(response.status).toBe(302);
      expect(fetch).toHaveBeenCalledTimes(1);
      const init = fetch.mock.calls[0]?.[1];
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      expect(init?.redirect).toBe("manual");
    } finally {
      fetch.mockRestore();
    }
  });
});

describe("Antigravity task egress", () => {
  it("does not admit sign-in or token exchange hosts into repository runs", () => {
    const hosts = antigravitySubscriptionHarness.egressHosts("google-subscription/gemini-3-pro");
    expect(hosts).not.toContain("oauth2.googleapis.com");
    expect(hosts).not.toContain("accounts.google.com");
    expect(hosts).toEqual(["cloudcode-pa.googleapis.com", "dl.google.com", "generativelanguage.googleapis.com"]);
  });
});
