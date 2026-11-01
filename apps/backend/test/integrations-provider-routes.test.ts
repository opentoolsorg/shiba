import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { handleIntegrationProviderRoutes } from "../src/integrations-provider-routes.js";
import { isPublicRequest } from "../src/public-routes.js";

describe("integration provider OAuth callback", () => {
  it("allows only the exact GET callback through the public request gate", () => {
    const url = "https://app.example.test/api/integrations/provider/callback";
    expect(isPublicRequest(new Request(url))).toBe(true);
    expect(isPublicRequest(new Request(url, { method: "POST" }))).toBe(false);
    expect(isPublicRequest(new Request(`${url}/extra`))).toBe(false);
    expect(isPublicRequest(new Request("https://app.example.test/api/integrations/provider/connections"))).toBe(false);
  });

  it("never reflects callback query parameters and limits scripts to its nonce", async () => {
    const url = new URL("https://app.example.test/api/integrations/provider/callback");
    url.searchParams.set("x", "</script><script>alert(1)</script>\u2028\u2029");
    url.searchParams.set("connectedAccountId", "secret-account");
    const response = await handleIntegrationProviderRoutes(new Request(url), { INTEGRATIONS_PROVIDER: "openconnector" } as Env);
    expect(response?.status).toBe(200);
    if (!response) throw new Error("Callback route did not respond.");
    const body = await response.text();
    expect(body).not.toContain("alert(1)");
    expect(body).not.toContain("secret-account");
    expect(body).not.toContain('"query"');
    const nonce = body.match(/<script nonce="([^"]+)"/u)?.[1];
    expect(nonce).toBeTruthy();
    expect(response?.headers.get("content-security-policy")).toContain(`script-src 'nonce-${nonce}'`);
    expect(response?.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});
