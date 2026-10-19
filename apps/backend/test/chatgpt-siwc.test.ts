import { describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  buildAuthorizeUrl,
  CHATGPT_PLAN_SCOPE,
  pickNewerConnection,
  pkceChallengeS256,
  randomBase64Url,
  validateCallbackUrl,
  type ChatGptConnectionRecord,
  type OpenIdDiscovery,
} from "../src/chatgpt/siwc.js";
import {
  connectionFromTokenResponse,
  exchangeToken,
  refreshConnection,
  verifyIdToken,
} from "../src/chatgpt/siwc-oauth.js";
import { applyTokenRenewal, resumeThreadAfterRestart, shouldRestartAppServer } from "../src/chatgpt/plan-session.js";

const discovery: OpenIdDiscovery = {
  issuer: "https://auth.openai.com",
  authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
  token_endpoint: "https://auth.openai.com/oauth/token",
  jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
  revocation_endpoint: "https://auth.openai.com/oauth/revoke",
};

describe("callback validation", () => {
  it("accepts a valid 127.0.0.1 callback with code and oaiapp client", () => {
    const pending = {
      state: "state-1",
      redirectUri: "http://127.0.0.1:52841/auth/callback",
    };
    const result = validateCallbackUrl(
      "http://127.0.0.1:52841/auth/callback?state=state-1&code=abc&client_id=oaiapp_test123",
      pending,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.clientId).toBe("oaiapp_test123");
      expect(result.code).toBe("abc");
    }
  });

  it("rejects localhost and state mismatch", () => {
    const pending = { state: "s", redirectUri: "http://127.0.0.1:1234/auth/callback" };
    expect(validateCallbackUrl("http://localhost:1234/auth/callback?state=s&code=x&client_id=oaiapp_x", pending).ok).toBe(
      false,
    );
    expect(
      validateCallbackUrl("http://127.0.0.1:1234/auth/callback?state=wrong&code=x&client_id=oaiapp_x", pending).ok,
    ).toBe(false);
  });
});

describe("PKCE + authorize URL", () => {
  it("builds authorize URL with dynamic client and PKCE S256", async () => {
    const verifier = randomBase64Url(64);
    const challenge = await pkceChallengeS256(verifier);
    const url = buildAuthorizeUrl({
      discovery,
      hostId: "urn:uuid:11111111-1111-4111-8111-111111111111",
      redirectUri: "http://127.0.0.1:55555/auth/callback",
      state: "st",
      nonce: "no",
      codeChallenge: challenge,
    });
    const parsed = new URL(url);
    expect(parsed.hostname).toBe("auth.openai.com");
    expect(parsed.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(parsed.searchParams.get("agent_name_hint")).toBe("shiba");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("scope")).toContain(CHATGPT_PLAN_SCOPE);
  });
});

describe("id_token verification", () => {
  it("verifies issuer, audience, and nonce", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwks = async () => exportJWK(publicKey);
    const nonce = "nonce-xyz";
    const clientId = "oaiapp_unit";
    const idToken = await new SignJWT({ email: "u@example.com", nonce })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(discovery.issuer)
      .setAudience(clientId)
      .setSubject("sub-1")
      .setExpirationTime("2h")
      .sign(privateKey);
    const identity = await verifyIdToken({
      idToken,
      discovery,
      audience: clientId,
      nonce,
      jwks,
    });
    expect(identity.subject).toBe("sub-1");
    expect(identity.email).toBe("u@example.com");
  });
});

describe("token exchange + missing plan scope", () => {
  it("marks plan usage disabled when scope omits chatgpt.tokens.use.direct", () => {
    const now = Date.now();
    const record = connectionFromTokenResponse({
      tokens: {
        access_token: "at",
        refresh_token: "rt",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid profile",
        id_token: "x",
      },
      clientId: "oaiapp_x",
      redirectUri: "http://127.0.0.1:1/auth/callback",
      hostId: "urn:uuid:x",
      subject: "sub",
      email: null,
      now,
    });
    expect(record.planUsageEnabled).toBe(false);
  });

  it("refresh rotates tokens when mocked fetch returns new refresh", async () => {
    const record: ChatGptConnectionRecord = {
      hostId: "urn:uuid:1",
      clientId: "oaiapp_x",
      redirectUri: "http://127.0.0.1:1/auth/callback",
      accessToken: "old",
      refreshToken: "rt",
      expiresAt: Date.now() + 30_000,
      earliestRefreshAt: null,
      scopes: [CHATGPT_PLAN_SCOPE],
      subject: "s",
      email: null,
      planUsageEnabled: true,
    };
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          access_token: "new-at",
          refresh_token: "new-rt",
          token_type: "Bearer",
          expires_in: 3600,
          scope: CHATGPT_PLAN_SCOPE,
        }),
        { status: 200 },
      );
    const refreshed = await refreshConnection(discovery, record, fetchImpl as typeof fetch, Date.now());
    expect(refreshed.accessToken).toBe("new-at");
    expect(refreshed.refreshToken).toBe("new-rt");
  });

  it("exchange clears connection on invalid_grant refresh errors", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "refresh_token_reused" }), { status: 400 });
    await expect(
      exchangeToken(
        discovery,
        new URLSearchParams({ grant_type: "refresh_token", refresh_token: "x", client_id: "oaiapp_x" }),
        fetchImpl as typeof fetch,
      ),
    ).rejects.toMatchObject({ clearConnection: true });
  });
});

describe("concurrent refresh pick + app-server restart", () => {
  it("keeps the connection with later expiry", () => {
    const a: ChatGptConnectionRecord = {
      hostId: "h",
      clientId: "c",
      redirectUri: "http://127.0.0.1:1/auth/callback",
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 100,
      earliestRefreshAt: null,
      scopes: [],
      subject: "s",
      email: null,
      planUsageEnabled: true,
    };
    const b = { ...a, accessToken: "b", expiresAt: 200 };
    expect(pickNewerConnection(a, b).expiresAt).toBe(200);
  });

  it("restarts app-server when access token changes", () => {
    const state = { accessToken: "a", expiresAt: 1, threadId: "t1", serverGeneration: 0 };
    expect(shouldRestartAppServer(state, { accessToken: "b", expiresAt: 2 })).toBe(true);
    const next = applyTokenRenewal(state, { accessToken: "b", expiresAt: 2 });
    expect(next.serverGeneration).toBe(1);
    expect(resumeThreadAfterRestart(next, "t1").threadId).toBe("t1");
  });
});
