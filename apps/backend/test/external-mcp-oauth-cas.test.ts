import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { createExternalMcpServer } from "../src/external-mcp.js";
import { resolveExternalMcpBearer, saveExternalMcpOAuthTokens } from "../src/external-mcp-oauth.js";
import { externalMcpD1 } from "./fixtures/external-mcp-schema.js";

const KEY = "ab".repeat(32);

describe("external MCP oauth token-version CAS", () => {
  it("bumps oauth_token_version after a successful refresh", async () => {
    const { database: AGENT_AUDIT, sqlite } = externalMcpD1();
    const env = { AGENT_AUDIT, MODEL_CREDENTIAL_KEY: KEY, MCP_TRUSTED_HOSTS: "mcp.example.com" } as unknown as Env;
    const server = await createExternalMcpServer(env, {
      orgId: "org-a", ownerId: "owner@example.test", name: "OAuth", endpoint: "https://mcp.example.com/mcp", credentialRef: null,
    });
    await saveExternalMcpOAuthTokens(env, "org-a", "owner@example.test", server!.id, {
      accessToken: "expired",
      refreshToken: "refresh-token",
      expiresAt: Date.now() - 1_000,
      tokenType: "Bearer",
      tokenEndpoint: "https://mcp.example.com/token",
      clientId: "client",
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      access_token: "fresh",
      refresh_token: "refresh-token-2",
      expires_in: 3600,
      token_type: "bearer",
    })));
    const token = await resolveExternalMcpBearer(env, "org-a", "owner@example.test", server!.id);
    expect(token).toBe("fresh");
    const row = sqlite.prepare("SELECT oauth_token_version, oauth_status FROM external_mcp_servers WHERE id = ?").get(server!.id) as {
      oauth_token_version: number; oauth_status: string;
    };
    expect(row.oauth_token_version).toBe(1);
    expect(row.oauth_status).toBe("connected");
    vi.unstubAllGlobals();
  });
});