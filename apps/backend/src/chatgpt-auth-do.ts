/**
 * Per-user ChatGPT auth — single-writer refresh and sign-in state (one DO / user).
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";
import {
  assertDiscoveryEndpoints,
  buildAuthorizeUrl,
  connectionStatusFromRecord,
  loopbackRedirectUri,
  newHostId,
  pickLoopbackPort,
  pkceChallengeS256,
  randomBase64Url,
  validateCallbackUrl,
  type ChatGptConnectionRecord,
  type PendingChatGptSignIn,
  CHATGPT_DISCOVERY_URL,
} from "./chatgpt/siwc.js";
import {
  ChatGptOAuthError,
  connectionFromTokenResponse,
  exchangeTokenResilient,
  fetchDiscovery,
  refreshConnection,
  revokeRefreshToken,
  verifyIdToken,
} from "./chatgpt/siwc-oauth.js";
import { createSandboxOAuthRunner, sandboxOAuthEnabled } from "./chatgpt/sandbox-oauth-client.js";
import {
  CODEX_DEVICE_CLIENT_ID,
  CODEX_DEVICE_REDIRECT,
  exchangeDeviceCode,
  finishDevicePoll,
  requestDeviceCode,
  type DeviceCodeTokens,
} from "./chatgpt/device-auth.js";
import { deleteConnection, loadConnection, loadHostId, saveConnection, saveHostId } from "./chatgpt/connection-store.js";
import { modelCredentialKeyConfigured } from "./subscription-credentials.js";
import { redactSecrets } from "./security.js";

const PENDING_KEY = "pending";
const DEVICE_PENDING_KEY = "device-pending";
const CONNECTION_GENERATION_KEY = "connectionGeneration";
const PENDING_TTL_MS = 15 * 60_000;

interface DevicePending {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  createdAt: number;
}

export function chatGptAuthStub(env: Pick<Env, "ChatGptAuth">, userId: string): DurableObjectStub {
  if (!env.ChatGptAuth) throw new Error("ChatGptAuth binding is not configured.");
  const ns = env.ChatGptAuth;
  return ns.get(ns.idFromName(userId));
}

export class ChatGptAuth extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/status" && request.method === "GET") {
        const record = await loadConnection(this.env, this.userId());
        if (!record) return Response.json({ connected: false });
        const status = connectionStatusFromRecord(record);
        const body: Record<string, unknown> = {
          ...status,
          planUsageEnabled: record.planUsageEnabled,
          expiresAt: record.expiresAt,
        };
        if (record.email) body.accountEmailHash = await this.emailHash(record.email);
        return Response.json(body);
      }
      if (url.pathname === "/begin" && request.method === "POST") {
        return await this.beginSignIn();
      }
      if (url.pathname === "/complete" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as { callbackUrl?: unknown } | null;
        const callbackUrl = typeof body?.callbackUrl === "string" ? body.callbackUrl : "";
        return await this.completeSignIn(callbackUrl);
      }
      if (url.pathname === "/device/begin" && request.method === "POST") {
        return await this.beginDeviceSignIn();
      }
      if (url.pathname === "/device/finish" && request.method === "POST") {
        return await this.finishDeviceSignIn();
      }
      if (url.pathname === "/access" && request.method === "GET") {
        const record = await this.ensureFreshAccess();
        return Response.json({
          accessToken: record.accessToken,
          expiresAt: record.expiresAt,
          planUsageEnabled: record.planUsageEnabled,
          threadId: record.threadId ?? null,
        });
      }
      if (url.pathname === "/thread" && request.method === "PUT") {
        const body = (await request.json().catch(() => null)) as { threadId?: unknown } | null;
        const threadId = typeof body?.threadId === "string" ? body.threadId : "";
        if (!threadId) return Response.json({ error: "threadId required." }, { status: 400 });
        const record = await loadConnection(this.env, this.userId());
        if (!record) return Response.json({ error: "Not connected." }, { status: 404 });
        await saveConnection(this.env, this.userId(), { ...record, threadId });
        return Response.json({ ok: true });
      }
      if (url.pathname === "/logout" && request.method === "DELETE") {
        return await this.logout();
      }
      return Response.json({ error: "Not found." }, { status: 404 });
    } catch (error) {
      const message = error instanceof ChatGptOAuthError ? error.message : "ChatGPT auth failed.";
      console.error("ChatGptAuth", redactSecrets(message));
      if (error instanceof ChatGptOAuthError && error.clearConnection) {
        await deleteConnection(this.env, this.userId());
      }
      return Response.json({ error: message }, { status: error instanceof ChatGptOAuthError ? 400 : 500 });
    }
  }

  private userId(): string {
    return this.ctx.id.name ?? "default";
  }

  private oauthResilienceOptions() {
    const allowSandboxFallback = sandboxOAuthEnabled(this.env);
    return {
      allowSandboxFallback,
      sandboxRunner: allowSandboxFallback ? createSandboxOAuthRunner(this.env) : null,
      userId: this.userId(),
    };
  }

  private async emailHash(email: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  private async beginSignIn(): Promise<Response> {
    const userId = this.userId();
    let hostId = await loadHostId(this.env, userId);
    if (!hostId) {
      hostId = newHostId();
      await saveHostId(this.env, userId, hostId);
    }
    const discovery = await fetchDiscovery(CHATGPT_DISCOVERY_URL);
    const discoveryError = assertDiscoveryEndpoints(discovery);
    if (discoveryError) return Response.json({ error: "ChatGPT discovery failed validation." }, { status: 503 });

    const existing = await loadConnection(this.env, userId);
    const port = pickLoopbackPort();
    const redirectUri = loopbackRedirectUri(port);
    const state = randomBase64Url(32);
    const nonce = randomBase64Url(32);
    const codeVerifier = randomBase64Url(64);
    const codeChallenge = await pkceChallengeS256(codeVerifier);
    const registeredClientId = existing?.clientId;
    const authorizeUrl = buildAuthorizeUrl({
      discovery,
      hostId,
      redirectUri,
      state,
      nonce,
      codeChallenge,
      registeredClientId,
      loginHint: existing?.email ?? undefined,
      idTokenHint: undefined,
      promptConsent: existing ? !existing.planUsageEnabled : false,
    });
    const pending: PendingChatGptSignIn = {
      state,
      nonce,
      codeVerifier,
      redirectUri,
      registeredClientId,
      hostId,
      createdAt: Date.now(),
    };
    await this.ctx.storage.put(PENDING_KEY, pending);
    return Response.json({ authorizeUrl, redirectUri, flowId: state });
  }

  private async completeSignIn(callbackUrl: string): Promise<Response> {
    const pending = await this.ctx.storage.get<PendingChatGptSignIn>(PENDING_KEY);
    if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) {
      return Response.json({ error: "No active sign-in. Start again." }, { status: 400 });
    }
    const validated = validateCallbackUrl(callbackUrl, pending);
    if (!validated.ok) return Response.json({ error: validated.reason }, { status: 400 });

    const discovery = await fetchDiscovery(CHATGPT_DISCOVERY_URL);
    const tokens = await exchangeTokenResilient(
      discovery,
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: validated.clientId,
        code: validated.code,
        code_verifier: pending.codeVerifier,
        redirect_uri: validated.redirectUri,
        resource: "https://api.openai.com/v1",
      }),
      this.oauthResilienceOptions(),
    );
    if (!tokens.id_token) return Response.json({ error: "ChatGPT did not return id_token." }, { status: 400 });
    const identity = await verifyIdToken({
      idToken: tokens.id_token,
      discovery,
      audience: validated.clientId,
      nonce: pending.nonce,
    });
    const now = Date.now();
    const record = connectionFromTokenResponse({
      tokens,
      clientId: validated.clientId,
      redirectUri: validated.redirectUri,
      hostId: pending.hostId,
      subject: identity.subject,
      email: identity.email,
      now,
    });
    await saveConnection(this.env, this.userId(), record);
    await this.ctx.storage.delete(PENDING_KEY);
    const status = connectionStatusFromRecord(record);
    return Response.json({
      ...status,
      planUsageDisabled: !record.planUsageEnabled,
      message: record.planUsageEnabled
        ? "Connected with ChatGPT plan usage."
        : "Signed in, but chatgpt.tokens.use.direct was not granted. Re-consent or use an API key.",
    });
  }

  private async ensureFreshAccess(): Promise<ChatGptConnectionRecord> {
    const generationAtStart = await this.connectionGeneration();
    const record = await loadConnection(this.env, this.userId());
    if (!record) throw new ChatGptOAuthError("Sign in with ChatGPT first.", "not_connected");
    if (!record.planUsageEnabled) throw new ChatGptOAuthError("ChatGPT plan usage is disabled for this connection.");
    const discovery = await fetchDiscovery(CHATGPT_DISCOVERY_URL);
    const refreshed = await refreshConnection(discovery, record, fetch, Date.now(), this.oauthResilienceOptions());
    if ((await this.connectionGeneration()) !== generationAtStart) {
      throw new ChatGptOAuthError("Sign in with ChatGPT first.", "not_connected");
    }
    if (!(await loadConnection(this.env, this.userId()))) {
      throw new ChatGptOAuthError("Sign in with ChatGPT first.", "not_connected");
    }
    if (refreshed.accessToken !== record.accessToken || refreshed.expiresAt !== record.expiresAt) {
      await saveConnection(this.env, this.userId(), refreshed);
    }
    return refreshed;
  }

  private async connectionGeneration(): Promise<number> {
    return (await this.ctx.storage.get<number>(CONNECTION_GENERATION_KEY)) ?? 0;
  }

  private async bumpConnectionGeneration(): Promise<void> {
    const next = (await this.connectionGeneration()) + 1;
    await this.ctx.storage.put(CONNECTION_GENERATION_KEY, next);
  }

  private async beginDeviceSignIn(): Promise<Response> {
    if (!modelCredentialKeyConfigured(this.env)) {
      return Response.json({ error: "Sign-in storage is not ready on this deployment." }, { status: 503 });
    }
    let started;
    try {
      started = await requestDeviceCode(fetch);
    } catch (error) {
      const message = error instanceof Error ? error.message : "ChatGPT device sign-in could not start.";
      return Response.json({ error: message }, { status: 502 });
    }
    const pending: DevicePending = {
      deviceAuthId: started.deviceAuthId,
      userCode: started.userCode,
      intervalMs: started.intervalMs,
      createdAt: Date.now(),
    };
    await this.ctx.storage.put(DEVICE_PENDING_KEY, pending);
    return Response.json({
      userCode: started.userCode,
      verificationUri: started.verificationUri,
      expiresAt: pending.createdAt + PENDING_TTL_MS,
    });
  }

  private async finishDeviceSignIn(): Promise<Response> {
    const pending = await this.ctx.storage.get<DevicePending>(DEVICE_PENDING_KEY);
    if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) {
      return Response.json({ error: "No device sign-in is in progress. Start again." }, { status: 409 });
    }
    const poll = await finishDevicePoll(fetch, pending);
    if (poll.status === "pending") {
      return Response.json({
        pending: true,
        message: "Still waiting. Enter the code at auth.openai.com/codex/device, then choose Finish sign-in again.",
      });
    }
    if (poll.status === "error") {
      return Response.json({ error: poll.message }, { status: 502 });
    }
    let tokens: DeviceCodeTokens;
    try {
      tokens = poll.status === "tokens" ? poll.tokens : await exchangeDeviceCode(fetch, poll.authorizationCode, poll.codeVerifier);
    } catch (error) {
      const message = error instanceof Error ? error.message : "ChatGPT token exchange failed.";
      return Response.json({ error: message }, { status: 502 });
    }
    await this.saveDeviceTokens(tokens);
    await this.ctx.storage.delete(DEVICE_PENDING_KEY);
    return Response.json({
      connected: true,
      planUsageEnabled: true,
      message:
        "ChatGPT plan connected. The access token stays encrypted for this user and is attached at egress.",
    });
  }

  private async saveDeviceTokens(tokens: DeviceCodeTokens): Promise<void> {
    const userId = this.userId();
    let hostId = await loadHostId(this.env, userId);
    if (!hostId) {
      hostId = newHostId();
      await saveHostId(this.env, userId, hostId);
    }
    const now = Date.now();
    await saveConnection(this.env, userId, {
      hostId,
      clientId: CODEX_DEVICE_CLIENT_ID,
      redirectUri: CODEX_DEVICE_REDIRECT,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: now + tokens.expiresIn * 1000,
      earliestRefreshAt: null,
      scopes: [],
      subject: tokens.accountId ?? "codex-device",
      email: tokens.email,
      planUsageEnabled: true,
      grantKind: "device",
    });
  }

  private async logout(): Promise<Response> {
    const record = await loadConnection(this.env, this.userId());
    if (record) {
      try {
        const discovery = await fetchDiscovery(CHATGPT_DISCOVERY_URL);
        await revokeRefreshToken(discovery, record);
      } catch {
        // Revocation is best-effort.
      }
    }
    await deleteConnection(this.env, this.userId());
    await this.bumpConnectionGeneration();
    await this.ctx.storage.delete(PENDING_KEY);
    return Response.json({ connected: false });
  }
}
