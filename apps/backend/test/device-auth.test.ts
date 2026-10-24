/**
 * Codex CLI device-code grant, mocked. No live calls to auth.openai.com.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CODEX_DEVICE_CLIENT_ID,
  exchangeDeviceCode,
  finishDevicePoll,
  interpretDevicePoll,
  requestDeviceCode,
} from "../src/chatgpt/device-auth.js";

function jsonResponse(status: number, body: unknown, type = "application/json"): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": type } });
}

describe("codex device auth", () => {
  it("requests a user code with the Codex CLI client id and headers", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("originator")).toBe("codex_cli_rs");
      expect(headers.get("User-Agent")).toBe("codex_cli_rs/0.0.0");
      expect(JSON.parse(String(init?.body))).toEqual({ client_id: CODEX_DEVICE_CLIENT_ID });
      return jsonResponse(200, { device_auth_id: "dev-1", user_code: "3S97-5TB3", interval: "5" });
    });
    const started = await requestDeviceCode(fetchImpl as typeof fetch);
    expect(started.userCode).toBe("3S97-5TB3");
    expect(started.intervalMs).toBe(5_000);
    expect(started.verificationUri).toBe("https://auth.openai.com/codex/device");
  });

  it("treats a JSON 403 as still waiting and an HTML 403 as a block", () => {
    expect(interpretDevicePoll(403, JSON.stringify({ error: "authorization_pending" })).status).toBe("pending");
    expect(interpretDevicePoll(404, "").status).toBe("pending");
    const challenge = interpretDevicePoll(403, "<html>Just a moment</html>", "text/html");
    expect(challenge.status).toBe("error");
    if (challenge.status === "error") expect(challenge.message).not.toMatch(/SHIBA_|AI_GATEWAY/);
  });

  it("polls until the grant is ready, then exchanges without a resource parameter", async () => {
    let polls = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/deviceauth/token")) {
        const body = JSON.parse(String(init?.body)) as { device_auth_id: string; user_code: string };
        expect(body).toEqual({ device_auth_id: "dev-1", user_code: "3S97-5TB3" });
        polls += 1;
        if (polls < 2) return jsonResponse(403, { error: "authorization_pending" });
        return jsonResponse(200, { authorization_code: "auth-code", code_verifier: "verifier-1" });
      }
      expect(url).toBe("https://auth.openai.com/oauth/token");
      const form = String(init?.body);
      expect(form).toContain("grant_type=authorization_code");
      expect(form).toContain(`client_id=${CODEX_DEVICE_CLIENT_ID}`);
      expect(form).toContain("code=auth-code");
      expect(form).toContain("code_verifier=verifier-1");
      expect(form).toContain("redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback");
      expect(form).not.toContain("resource=");
      return jsonResponse(200, {
        access_token: "access-secret",
        refresh_token: "refresh-secret",
      });
    });
    const poll = await finishDevicePoll(
      fetchImpl as typeof fetch,
      { deviceAuthId: "dev-1", userCode: "3S97-5TB3", intervalMs: 5_000 },
      async () => {},
    );
    expect(poll.status).toBe("ready");
    if (poll.status !== "ready") return;
    const tokens = await exchangeDeviceCode(fetchImpl as typeof fetch, poll.authorizationCode, poll.codeVerifier);
    expect(tokens.accessToken).toBe("access-secret");
    expect(tokens.refreshToken).toBe("refresh-secret");
    expect(tokens.expiresIn).toBe(3_600);
    expect(JSON.stringify(poll)).not.toContain("access-secret");
  });
});
