import { describe, expect, it, vi } from "vitest";
import { isOAuthBotChallengeResponse, looksLikeBotChallengeBody } from "../src/chatgpt/oauth-bot-challenge.js";
import { runSandboxOAuthExchange } from "../src/chatgpt/sandbox-oauth-client.js";
import { exchangeTokenResilient } from "../src/chatgpt/siwc-oauth.js";
import type { OpenIdDiscovery } from "../src/chatgpt/siwc.js";

const discovery: OpenIdDiscovery = {
  issuer: "https://auth.openai.com",
  authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
  token_endpoint: "https://auth.openai.com/oauth/token",
  jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
};

describe("bot challenge detection", () => {
  it("flags 403 html responses", () => {
    const response = new Response("<html><title>Just a moment</title></html>", {
      status: 403,
      headers: { "content-type": "text/html" },
    });
    expect(isOAuthBotChallengeResponse(response)).toBe(true);
    expect(looksLikeBotChallengeBody("<!doctype html> cf-browser-verification")).toBe(true);
  });
});

describe("sandbox oauth exchange", () => {
  it("parses a successful curl response file", async () => {
    const sandbox = {
      commands: [] as string[],
      async setAllowedHosts() {},
      async setSleepAfter() {},
      async writeFile(path: string, content: string) {
        expect(path).toContain("oauth-body");
        expect(content).toContain("grant_type=refresh_token");
      },
      async exec(command: string) {
        this.commands.push(command);
        if (command.includes("curl")) {
          return { stdout: "200", stderr: "", exitCode: 0 };
        }
        return {
          stdout: JSON.stringify({
            access_token: "new-at",
            refresh_token: "new-rt",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "chatgpt.tokens.use.direct",
          }),
          stderr: "",
          exitCode: 0,
        };
      },
    };
    const tokens = await runSandboxOAuthExchange(
      sandbox,
      discovery,
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: "rt", client_id: "oaiapp_x" }),
    );
    expect(tokens.access_token).toBe("new-at");
    expect(sandbox.commands.some((c) => c.includes("auth.openai.com"))).toBe(true);
  });
});

describe("exchangeTokenResilient", () => {
  it("falls back to sandbox runner on bot_challenge", async () => {
    const fetchImpl = async () =>
      new Response("<html>Just a moment</html>", { status: 403, headers: { "content-type": "text/html" } });
    const sandboxRunner = {
      exchange: vi.fn(async () => ({
        access_token: "sandbox-at",
        refresh_token: "sandbox-rt",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "chatgpt.tokens.use.direct",
      })),
    };
    const tokens = await exchangeTokenResilient(
      discovery,
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: "x", client_id: "oaiapp_x" }),
      { fetchImpl: fetchImpl as typeof fetch, allowSandboxFallback: true, sandboxRunner, userId: "alice" },
    );
    expect(tokens.access_token).toBe("sandbox-at");
    expect(sandboxRunner.exchange).toHaveBeenCalledOnce();
  });
});
