/**
 * Provider OAuth — mocked vendor endpoints (login, exchange, refresh, egress).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  beginAntigravityOAuth,
  exchangeAntigravityCode,
  refreshAntigravityToken,
} from "../src/provider-oauth/antigravity.js";
import { beginCursorOAuth, pollCursorOAuth, refreshCursorToken } from "../src/provider-oauth/cursor.js";
import {
  beginXaiOAuth,
  exchangeXaiCode,
  refreshXaiToken,
  XAI_REDIRECT_URI,
} from "../src/provider-oauth/xai.js";
import {
  forwardAntigravityUser,
  forwardCursorUser,
  forwardXaiUser,
  type EgressEnv,
} from "../src/egress.js";
import { UserProviderOAuth, userProviderOAuthStub } from "../src/user-provider-oauth-do.js";

const KEY = "ab".repeat(32);

class FakeD1 {
  async prepare() {
    return {
      bind: () => ({
        first: async () => null,
        run: async () => ({}),
      }),
    };
  }
  async batch() {}
}

class FakeKV {}

function oauthEnv(stubFetch: typeof fetch): EgressEnv {
  const ns = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: stubFetch,
    }),
  };
  return {
    AGENT_TOKENS: new FakeKV() as unknown as EgressEnv["AGENT_TOKENS"],
    AGENT_AUDIT: new FakeD1() as unknown as EgressEnv["AGENT_AUDIT"],
    MODEL_CREDENTIAL_KEY: KEY,
    UserProviderOAuth: ns as unknown as EgressEnv["UserProviderOAuth"],
  } as EgressEnv;
}

describe("provider-oauth modules", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("antigravity: exchange, refresh, and authenticated egress", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        const body = String(init?.body ?? "");
        if (body.includes("authorization_code")) {
          return Response.json({
            access_token: "agy-access",
            refresh_token: "agy-refresh",
            expires_in: 3600,
          });
        }
        return Response.json({
          access_token: "agy-access-2",
          refresh_token: "agy-refresh",
          expires_in: 3600,
        });
      }
      if (url.includes("loadCodeAssist")) {
        return Response.json({ projectId: "cca-project-1" });
      }
      if (url.includes("cloudcode-pa.googleapis.com/v1/models")) {
        const auth = new Headers(init?.headers).get("Authorization");
        return new Response(auth === "Bearer agy-access" ? "ok" : "no", { status: auth ? 200 : 401 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const begin = await beginAntigravityOAuth();
    expect(begin.authorizeUrl).toContain("accounts.google.com");
    const record = await exchangeAntigravityCode("code-1", begin.codeVerifier);
    expect(record.projectId).toBe("cca-project-1");

    const refreshed = await refreshAntigravityToken(record.refreshToken);
    expect(refreshed.accessToken).toBe("agy-access-2");

    const egressEnv = oauthEnv(async (input) => {
      const url = String(input);
      if (url.includes("/access?")) {
        return Response.json({ accessToken: "agy-access", projectId: "cca-project-1" });
      }
      return originalFetch(input);
    });

    const response = await forwardAntigravityUser(
      new Request("https://cloudcode-pa.googleapis.com/v1/models", { method: "GET" }),
      egressEnv,
      { params: { userId: "ada" } },
    );
    expect(response.status).toBe(200);
  });

  it("cursor: poll, refresh, and authenticated egress", async () => {
    let polls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/poll")) {
        polls++;
        if (polls < 2) return new Response("", { status: 404 });
        return Response.json({ accessToken: "cur-access", refreshToken: "cur-refresh" });
      }
      if (url.includes("/auth/exchange_user_api_key")) {
        return Response.json({ accessToken: "cur-access-2", refreshToken: "cur-refresh" });
      }
      if (url.includes("api2.cursor.sh/health")) {
        return new Response("ok", { status: 200 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const begin = await beginCursorOAuth();
    expect(begin.loginUrl).toContain("cursor.com/loginDeepControl");
    const record = await pollCursorOAuth(begin.uuid, begin.verifier, { baseDelayMs: 1, maxAttempts: 5 });
    expect(record.accessToken).toBe("cur-access");

    const refreshed = await refreshCursorToken(record.refreshToken);
    expect(refreshed.accessToken).toBe("cur-access-2");

    const egressEnv = oauthEnv(async (input) => {
      if (String(input).includes("/access?")) {
        return Response.json({ accessToken: "cur-access-2" });
      }
      return originalFetch(input);
    });
    const response = await forwardCursorUser(
      new Request("https://api2.cursor.sh/health", { method: "GET" }),
      egressEnv,
      { params: { userId: "ada" } },
    );
    expect(response.status).toBe(200);
  });

  it("xai: discovery, exchange, refresh, and authenticated egress", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("openid-configuration")) {
        return Response.json({
          authorization_endpoint: "https://auth.x.ai/authorize",
          token_endpoint: "https://auth.x.ai/token",
        });
      }
      if (url.includes("auth.x.ai/token")) {
        const body = String(init?.body ?? "");
        if (body.includes("authorization_code")) {
          return Response.json({
            access_token: "xai-access",
            refresh_token: "xai-refresh",
            expires_in: 3600,
            id_token: btoa(JSON.stringify({ alg: "none" })).replace(/=+$/, "") + "." + btoa(JSON.stringify({ sub: "u1", email: "a@x.ai" })).replace(/=+$/, "") + ".sig",
          });
        }
        return Response.json({
          access_token: "xai-access-2",
          refresh_token: "xai-refresh",
          expires_in: 3600,
        });
      }
      if (url.includes("api.x.ai/v1/models")) {
        const auth = new Headers(init?.headers).get("Authorization");
        return new Response(auth === "Bearer xai-access" ? "ok" : "no", { status: auth ? 200 : 401 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const begin = await beginXaiOAuth();
    expect(begin.authorizeUrl).toContain("auth.x.ai");
    const record = await exchangeXaiCode("code-x", begin.codeVerifier, begin.tokenEndpoint);
    expect(record.accessToken).toBe("xai-access");

    const refreshed = await refreshXaiToken(record.refreshToken, begin.tokenEndpoint);
    expect(refreshed.accessToken).toBe("xai-access-2");

    const egressEnv = oauthEnv(async (input) => {
      if (String(input).includes("/access?")) {
        return Response.json({ accessToken: "xai-access" });
      }
      return originalFetch(input);
    });
    const response = await forwardXaiUser(
      new Request("https://api.x.ai/v1/models", { method: "POST", body: "{}" }),
      egressEnv,
      { params: { userId: "ada" } },
    );
    expect(response.status).toBe(200);
  });
});

describe("UserProviderOAuth durable object", () => {
  it("exports stub helper", () => {
    const env = oauthEnv(async () => Response.json({ ok: true }));
    const stub = userProviderOAuthStub(env, "user-1");
    expect(stub).toBeTruthy();
  });

  it("class is registered for wrangler", () => {
    expect(UserProviderOAuth).toBeDefined();
  });
});
