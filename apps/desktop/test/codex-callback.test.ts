import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  cancelCodexCallback,
  parseCodexAuthorizationUrl,
  receiveCodexCallback,
  submitCodexCallback,
} from "../src/codex-callback.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function authorize(port: number, state = "state-state"): string {
  const url = new URL("https://auth.openai.com/oauth/authorize");
  url.searchParams.set("code_challenge", "challenge-challenge");
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", `http://127.0.0.1:${port}/auth/callback`);
  url.searchParams.set("state", state);
  return url.toString();
}

describe("parseCodexAuthorizationUrl", () => {
  it("rejects anything that is not an auth.openai.com PKCE redirect to loopback", () => {
    expect(parseCodexAuthorizationUrl("https://auth.openai.com/codex/device").ok).toBe(false);
    expect(parseCodexAuthorizationUrl("https://evil.example/oauth/authorize").ok).toBe(false);
    expect(parseCodexAuthorizationUrl("http://auth.openai.com/oauth/authorize").ok).toBe(false);
  });
});

describe("receiveCodexCallback", () => {
  it("opens the authorize URL and returns the loopback callback without echoing the code in the page", async () => {
    const port = await freePort();
    const authorizationUrl = authorize(port);
    const callbackUrl = `http://127.0.0.1:${port}/auth/callback?code=secret-code&state=state-state`;
    const received = receiveCodexCallback(authorizationUrl, async (opened) => {
      expect(opened).toBe(authorizationUrl);
      const response = await fetch(callbackUrl);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).not.toContain("secret-code");
      return true;
    });
    await expect(received).resolves.toBe(callbackUrl);
  });

  it("cancels a waiting sign-in", async () => {
    const port = await freePort();
    const authorizationUrl = authorize(port, "state-state-2");
    const received = receiveCodexCallback(authorizationUrl, async () => {
      cancelCodexCallback(authorizationUrl);
      return true;
    });
    await expect(received).rejects.toThrow(/cancelled/);
  });

  it("accepts the same callback from a deep link", async () => {
    const port = await freePort();
    const authorizationUrl = authorize(port, "state-state-3");
    const callbackUrl = `http://127.0.0.1:${port}/auth/callback?code=from-link&state=state-state-3`;
    const received = receiveCodexCallback(authorizationUrl, async () => {
      expect(submitCodexCallback(callbackUrl)).toBe(true);
      return true;
    });
    await expect(received).resolves.toBe(callbackUrl);
  });
});
