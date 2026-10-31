import { describe, expect, it } from "vitest";
import { forwardAnthropic, forwardClaudeSubscription, forwardCursorUser, type EgressEnv } from "../src/egress.js";
import { chatTaskFollowUpChunks } from "../src/chat-lane.js";

describe("security batch 03 — chat approval follow-ups", () => {
  it("posts follow-ups whenever the card truncates the task", () => {
    const hidden = "x".repeat(1600);
    expect(chatTaskFollowUpChunks(hidden)).toHaveLength(1);
    expect(chatTaskFollowUpChunks("x".repeat(1500))).toEqual([]);
  });
});

describe("security batch 03 — claude subscription account scope", () => {
  it("does not apply the org saved token to a named account", async () => {
    let authHeader: string | null = null;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_req, init) => {
      const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers as HeadersInit);
      authHeader = headers.get("authorization");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const env = {
        CLAUDE_SUBSCRIPTION_TOKEN_WORK: "worker-token",
        AGENT_TOKENS: {
          get: async () => JSON.stringify({ kind: "claude-setup", secret: "saved-token" }),
        },
      } as unknown as EgressEnv;
      await forwardClaudeSubscription(
        new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
        env,
        { orgId: "self-hosted", params: { account: "work" } },
      );
      expect(authHeader).toBe("Bearer worker-token");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("security batch 03 — cursor oauth egress", () => {
  it("refuses deployment fallback when dashboard OAuth access is missing", async () => {
    const env = {
      CURSOR_SUBSCRIPTION_TOKEN: "deployment-key",
    } as unknown as EgressEnv;
    const response = await forwardCursorUser(
      new Request("https://api2.cursor.sh/v1/chat", { method: "POST", body: "{}" }),
      env,
      { params: { userId: "ada", account: "default" } },
    );
    expect(response.status).toBe(503);
  });
});

describe("security batch 03 — gateway BYOK alias", () => {
  it("prefers the approved alias over saved org keys", async () => {
    let byokAlias: string | null = null;
    let apiKey: string | null = null;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_req, init) => {
      const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers as HeadersInit);
      byokAlias = headers.get("cf-aig-byok-alias");
      apiKey = headers.get("x-api-key");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const env = {
        AI: { gateway: () => ({ getUrl: async () => "https://gateway.example/anthropic" }) },
        GATEWAY_ID: "default",
        AI_GATEWAY_TOKEN: "gw-token",
        AGENT_TOKENS: {
          get: async () => JSON.stringify({ kind: "anthropic", secret: "saved-key" }),
        },
      } as unknown as EgressEnv;
      await forwardAnthropic(
        new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
        env,
        { orgId: "self-hosted", gatewayByokAlias: "conn-byok-alias" },
      );
      expect(byokAlias).toBe("conn-byok-alias");
      expect(apiKey).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });
});
