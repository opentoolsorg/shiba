/**
 * Subscription sign-in for the sandbox adapter cards.
 *
 * Codex uses the ChatGPT device-code grant (the same grant the Codex CLI
 * polls). Claude Code uses PKCE against Anthropic's code-display redirect,
 * so a Worker with no browser on loopback can still finish. Gemini, Grok,
 * and OpenCode stay on the API-credential path: they do not share this grant.
 *
 * The request/response shape follows opencodex (MIT License, Copyright (c)
 * 2026 opencodex contributors, https://github.com/lidge-jun/opencodex),
 * specifically the device grant in src/oauth/chatgpt-device.ts and the
 * code-mode PKCE grant in src/oauth/anthropic.ts. This module is not a copy
 * of those files. Tokens are encrypted with MODEL_CREDENTIAL_KEY and attached
 * at Worker egress. They are not written into the sandbox and are not read
 * from ~/.claude or ~/.codex.
 *
 * Storing a Claude.ai subscription token in a third-party app can conflict
 * with Anthropic's terms. This path is the operator signing in on their own
 * self-hosted install. API-key mode remains available.
 */
import type { AcpProviderId } from "@shiba/shared";

type StoreEnv = {
  AGENT_TOKENS?: KVNamespace;
  MODEL_CREDENTIAL_KEY?: string;
};
import {
  decryptAuthJson,
  encryptAuthJson,
  modelCredentialKeyConfigured,
} from "./subscription-credentials.js";

export class ProviderLoginError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProviderLoginError";
  }
}

/** Public Codex CLI PKCE client. Not a secret. */
export const CODEX_DEVICE_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const CODEX_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_DEVICE_REDIRECT = "https://auth.openai.com/deviceauth/callback";
export const CODEX_DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";

/** Public Claude Code OAuth client. Not a secret. */
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const CLAUDE_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const CLAUDE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const CLAUDE_SCOPES = "org:create_api_key user:profile user:inference";

const PENDING_PREFIX = "acp_login_pending:";
const TOKEN_PREFIX = "acp_login_token:";
const INSTALL_PREFIX = "acp_login_install:";
const WORKSPACE = "installation";
const FLOW_TTL_MS = 15 * 60 * 1000;

export interface LoginStart {
  userCode: string | null;
  verificationUri: string;
  message: string;
  expiresAt: number;
}

export interface LoginFinish {
  phase: "waiting" | "connected" | "failed";
  message: string;
}

export interface AdapterAuthorization {
  authorization: string;
  accountId: string | null;
  provider: "codex" | "claude";
}

export interface ProviderLogin {
  start(env: StoreEnv, id: AcpProviderId, org: string, now: number): Promise<LoginStart>;
  finish(env: StoreEnv, id: AcpProviderId, org: string, userCode: string, now: number): Promise<LoginFinish>;
  forget(env: StoreEnv, id: AcpProviderId, org: string): Promise<void>;
  probe(env: StoreEnv, id: AcpProviderId, org: string, now: number): Promise<{ ok: boolean; message: string }>;
}

type Pending =
  | { kind: "codex-device"; deviceAuthId: string; userCode: string }
  | { kind: "claude-code"; verifier: string; state: string };

interface StoredGrant {
  provider: "codex" | "claude";
  access: string;
  refresh: string;
  expiresAt: number;
  accountId: string | null;
}

function keyName(env: StoreEnv): string {
  const key = env.MODEL_CREDENTIAL_KEY ?? "";
  if (!modelCredentialKeyConfigured(env)) {
    throw new ProviderLoginError(
      "Set MODEL_CREDENTIAL_KEY to 64 hex characters before subscription sign-in. Generate one with `openssl rand -hex 32` and store it in apps/backend/.dev.vars (local) or as a Worker secret. API-key mode does not need it.",
      503,
    );
  }
  return key;
}

function kv(env: StoreEnv): KVNamespace {
  if (!env.AGENT_TOKENS) {
    throw new ProviderLoginError("Provider connection store is not configured.", 503);
  }
  return env.AGENT_TOKENS;
}

function pendingKey(org: string, id: string): string {
  return `${PENDING_PREFIX}${encodeURIComponent(org)}:${id}`;
}
function tokenKey(org: string, id: string): string {
  return `${TOKEN_PREFIX}${encodeURIComponent(org)}:${id}`;
}
function installKey(id: string): string {
  return `${INSTALL_PREFIX}${id}`;
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256b64url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return b64url(new Uint8Array(digest));
}

function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function encrypt(env: StoreEnv, org: string, id: string, plaintext: string): Promise<string> {
  return encryptAuthJson(plaintext, keyName(env), WORKSPACE, org, `adapter-${id}`);
}

async function decrypt(env: StoreEnv, org: string, id: string, cipher: string): Promise<string> {
  return decryptAuthJson(cipher, keyName(env), WORKSPACE, org, `adapter-${id}`);
}

async function writePending(env: StoreEnv, org: string, id: AcpProviderId, pending: Pending): Promise<void> {
  const cipher = await encrypt(env, org, id, JSON.stringify(pending));
  await kv(env).put(pendingKey(org, id), cipher);
}

async function readPending(env: StoreEnv, org: string, id: AcpProviderId): Promise<Pending | null> {
  const cipher = await kv(env).get(pendingKey(org, id), { type: "text" });
  if (!cipher) return null;
  try {
    const parsed = JSON.parse(await decrypt(env, org, id, cipher)) as Pending;
    if (parsed.kind === "codex-device" || parsed.kind === "claude-code") return parsed;
  } catch {
    return null;
  }
  return null;
}

async function writeGrant(env: StoreEnv, org: string, id: AcpProviderId, grant: StoredGrant): Promise<void> {
  const cipher = await encrypt(env, org, id, JSON.stringify(grant));
  await kv(env).put(tokenKey(org, id), cipher);
  await kv(env).put(installKey(id), org);
  await kv(env).delete(pendingKey(org, id));
}

async function readGrant(env: StoreEnv, org: string, id: AcpProviderId): Promise<StoredGrant | null> {
  if (!modelCredentialKeyConfigured(env) || !env.AGENT_TOKENS) return null;
  const cipher = await env.AGENT_TOKENS.get(tokenKey(org, id), { type: "text" });
  if (!cipher) return null;
  try {
    const parsed = JSON.parse(await decrypt(env, org, id, cipher)) as StoredGrant;
    if (typeof parsed.access !== "string" || parsed.access === "") return null;
    return parsed;
  } catch {
    return null;
  }
}

function providerForHost(host: string): "codex" | "claude" | null {
  if (host === "api.openai.com") return "codex";
  if (host === "api.anthropic.com") return "claude";
  return null;
}

function accountIdFromToken(access: string, idToken?: string): string | null {
  for (const token of [idToken, access]) {
    if (!token) continue;
    const parts = token.split(".");
    if (parts.length < 2 || !parts[1]) continue;
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
      if (typeof payload.chatgpt_account_id === "string") return payload.chatgpt_account_id;
      const ns = payload["https://api.openai.com/auth"];
      if (ns && typeof ns === "object" && typeof (ns as Record<string, unknown>).chatgpt_account_id === "string") {
        return (ns as Record<string, unknown>).chatgpt_account_id as string;
      }
    } catch {
      // A non-JWT access token simply has no account id.
    }
  }
  return null;
}

function expiresAtFrom(body: Record<string, unknown>, now: number): number {
  const seconds = body.expires_in;
  const ttl = typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds : 3600;
  return now + ttl * 1000;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const VENDOR_TIMEOUT_MS = 20_000;

export function createProviderLogin(fetchRaw: typeof fetch = fetch): ProviderLogin {
  const fetchImpl: typeof fetch = (input, init) => {
    const timeout = AbortSignal.timeout(VENDOR_TIMEOUT_MS);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetchRaw(input, { ...init, redirect: "manual", signal });
  };
  async function refreshGrant(env: StoreEnv, org: string, id: AcpProviderId, grant: StoredGrant, now: number): Promise<StoredGrant> {
    if (grant.expiresAt > now + 60_000) return grant;
    if (grant.refresh === "") {
      throw new ProviderLoginError("The saved sign-in has no refresh token. Start sign-in again.", 409);
    }
    if (grant.provider === "codex") {
      const response = await fetchImpl(CODEX_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: CODEX_DEVICE_CLIENT_ID,
          refresh_token: grant.refresh,
        }),
      });
      if (!response.ok) throw new ProviderLoginError(`Codex refresh failed (HTTP ${response.status}). Start sign-in again.`, 502);
      const body = await readJson(response);
      const access = typeof body.access_token === "string" ? body.access_token : "";
      if (access === "") throw new ProviderLoginError("Codex refresh returned no access token.", 502);
      const next: StoredGrant = {
        provider: "codex",
        access,
        refresh: typeof body.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : grant.refresh,
        expiresAt: expiresAtFrom(body, now),
        accountId: accountIdFromToken(access, typeof body.id_token === "string" ? body.id_token : undefined) ?? grant.accountId,
      };
      await writeGrant(env, org, id, next);
      return next;
    }
    const response = await fetchImpl(CLAUDE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLAUDE_OAUTH_CLIENT_ID,
        refresh_token: grant.refresh,
      }),
    });
    if (!response.ok) throw new ProviderLoginError(`Claude refresh failed (HTTP ${response.status}). Start sign-in again.`, 502);
    const body = await readJson(response);
    const access = typeof body.access_token === "string" ? body.access_token : "";
    if (access === "") throw new ProviderLoginError("Claude refresh returned no access token.", 502);
    const next: StoredGrant = {
      provider: "claude",
      access,
      refresh: typeof body.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : grant.refresh,
      expiresAt: expiresAtFrom(body, now),
      accountId: null,
    };
    await writeGrant(env, org, id, next);
    return next;
  }

  return {
    async start(env, id, org, now) {
      keyName(env);
      if (id === "codex") {
        const response = await fetchImpl(CODEX_USERCODE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: CODEX_DEVICE_CLIENT_ID }),
        });
        if (!response.ok) {
          throw new ProviderLoginError(`ChatGPT device sign-in could not start (HTTP ${response.status}).`, 502);
        }
        const body = await readJson(response);
        const deviceAuthId = typeof body.device_auth_id === "string" ? body.device_auth_id : "";
        const userCode = typeof body.user_code === "string" ? body.user_code : typeof body.usercode === "string" ? body.usercode : "";
        if (deviceAuthId === "" || userCode === "") {
          throw new ProviderLoginError("ChatGPT device sign-in returned no user code.", 502);
        }
        await writePending(env, org, id, { kind: "codex-device", deviceAuthId, userCode });
        return {
          userCode,
          verificationUri: CODEX_DEVICE_VERIFICATION_URL,
          expiresAt: now + FLOW_TTL_MS,
          message:
            "Open the sign-in page and enter this code on your ChatGPT account. Finish sign-in checks whether you approved it. The code is not sent anywhere else.",
        };
      }
      if (id === "claude") {
        const verifier = randomToken();
        const challenge = await sha256b64url(verifier);
        const state = randomToken(16);
        const url = new URL(CLAUDE_AUTHORIZE_URL);
        url.searchParams.set("code", "true");
        url.searchParams.set("client_id", CLAUDE_OAUTH_CLIENT_ID);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("redirect_uri", CLAUDE_REDIRECT_URI);
        url.searchParams.set("scope", CLAUDE_SCOPES);
        url.searchParams.set("code_challenge", challenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("state", state);
        await writePending(env, org, id, { kind: "claude-code", verifier, state });
        return {
          userCode: null,
          verificationUri: url.toString(),
          expiresAt: now + FLOW_TTL_MS,
          message:
            "Open sign-in, approve access, then paste the code Claude displays (it looks like code#state). This stores the token for your self-hosted install. Anthropic limits how third-party apps may hold Claude.ai subscription tokens. API-key mode remains available.",
        };
      }
      throw new ProviderLoginError(`${id} has no subscription sign-in. Use the API credential.`, 400);
    },

    async finish(env, id, org, userCode, now) {
      const pending = await readPending(env, org, id);
      if (pending === null) {
        throw new ProviderLoginError("There is no sign-in in progress for this provider.", 409);
      }
      if (pending.kind === "codex-device") {
        if (userCode.trim() !== pending.userCode) {
          throw new ProviderLoginError("The confirmation code does not match this sign-in.", 400);
        }
        const poll = await fetchImpl(CODEX_DEVICE_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_auth_id: pending.deviceAuthId, user_code: pending.userCode }),
        });
        if (poll.status === 403 || poll.status === 404) {
          return {
            phase: "waiting",
            message: "Still waiting. Enter the code at auth.openai.com/codex/device, then choose Finish sign-in again.",
          };
        }
        if (!poll.ok) {
          return { phase: "failed", message: `ChatGPT did not finish sign-in (HTTP ${poll.status}). Start again.` };
        }
        const grantBody = await readJson(poll);
        const code = typeof grantBody.authorization_code === "string" ? grantBody.authorization_code : "";
        const verifier = typeof grantBody.code_verifier === "string" ? grantBody.code_verifier : "";
        if (code === "" || verifier === "") {
          return { phase: "failed", message: "ChatGPT returned an incomplete device grant. Start again." };
        }
        const exchanged = await fetchImpl(CODEX_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: CODEX_DEVICE_CLIENT_ID,
            code,
            code_verifier: verifier,
            redirect_uri: CODEX_DEVICE_REDIRECT,
          }),
        });
        if (!exchanged.ok) {
          return { phase: "failed", message: `ChatGPT token exchange failed (HTTP ${exchanged.status}). Start again.` };
        }
        const token = await readJson(exchanged);
        const access = typeof token.access_token === "string" ? token.access_token : "";
        if (access === "") return { phase: "failed", message: "ChatGPT returned no access token. Start again." };
        await writeGrant(env, org, id, {
          provider: "codex",
          access,
          refresh: typeof token.refresh_token === "string" ? token.refresh_token : "",
          expiresAt: expiresAtFrom(token, now),
          accountId: accountIdFromToken(access, typeof token.id_token === "string" ? token.id_token : undefined),
        });
        return {
          phase: "connected",
          message: "ChatGPT subscription is connected. Sandbox runs attach the access token at egress. The container does not receive it.",
        };
      }
      const pasted = userCode.trim();
      const hash = pasted.indexOf("#");
      const code = hash >= 0 ? pasted.slice(0, hash) : pasted;
      const state = hash >= 0 ? pasted.slice(hash + 1) : "";
      if (code === "" || state === "" || state !== pending.state) {
        throw new ProviderLoginError("Paste the full code#state value Claude displayed.", 400);
      }
      const exchanged = await fetchImpl(CLAUDE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: CLAUDE_OAUTH_CLIENT_ID,
          code,
          state,
          redirect_uri: CLAUDE_REDIRECT_URI,
          code_verifier: pending.verifier,
        }),
      });
      if (!exchanged.ok) {
        return { phase: "failed", message: `Claude token exchange failed (HTTP ${exchanged.status}). Start sign-in again.` };
      }
      const token = await readJson(exchanged);
      const access = typeof token.access_token === "string" ? token.access_token : "";
      if (access === "") return { phase: "failed", message: "Claude returned no access token. Start sign-in again." };
      await writeGrant(env, org, id, {
        provider: "claude",
        access,
        refresh: typeof token.refresh_token === "string" ? token.refresh_token : "",
        expiresAt: expiresAtFrom(token, now),
        accountId: null,
      });
      return {
        phase: "connected",
        message: "Claude subscription is connected. Sandbox runs attach the access token at egress. The container does not receive it.",
      };
    },

    async forget(env, id, org) {
      if (!env.AGENT_TOKENS) return;
      await env.AGENT_TOKENS.delete(pendingKey(org, id));
      await env.AGENT_TOKENS.delete(tokenKey(org, id));
      const installed = await env.AGENT_TOKENS.get(installKey(id), { type: "text" });
      if (installed === org) await env.AGENT_TOKENS.delete(installKey(id));
    },

    async probe(env, id, org, now) {
      const grant = await readGrant(env, org, id);
      if (grant === null) return { ok: false, message: "No saved subscription sign-in for this provider." };
      let current = grant;
      try {
        current = await refreshGrant(env, org, id, grant, now);
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "Refresh failed." };
      }
      const url = id === "codex" ? "https://api.openai.com/v1/models" : "https://api.anthropic.com/v1/models?limit=1";
      const headers = new Headers({ Authorization: `Bearer ${current.access}` });
      if (id === "claude") {
        headers.set("anthropic-beta", "claude-code-20250219,oauth-2025-04-20");
        headers.set("anthropic-version", "2023-06-01");
      }
      const response = await fetchImpl(url, { method: "GET", headers });
      if (response.status === 200) return { ok: true, message: "Subscription credential reached the provider." };
      if (response.status === 401 || response.status === 403) {
        return { ok: false, message: `Provider rejected the saved sign-in (HTTP ${response.status}).` };
      }
      return { ok: false, message: `Provider probe returned HTTP ${response.status}.` };
    },
  };
}

/** Worker egress: bearer for a connected adapter, or null when API-key mode is in use. */
export async function readAdapterAuthorization(
  env: StoreEnv,
  host: string,
  now = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<AdapterAuthorization | null> {
  const store = env.AGENT_TOKENS;
  const id = providerForHost(host);
  if (id === null || !store || !modelCredentialKeyConfigured(env)) return null;
  const org = await store.get(installKey(id), { type: "text" });
  if (!org) return null;
  const grantCipher = await store.get(tokenKey(org, id), { type: "text" });
  if (!grantCipher) return null;
  let grant: StoredGrant;
  try {
    grant = JSON.parse(await decrypt(env, org, id, grantCipher)) as StoredGrant;
  } catch {
    return null;
  }
  if (typeof grant.access !== "string" || grant.access === "") return null;
  if (grant.expiresAt <= now + 60_000 && grant.refresh !== "") {
    const login = createProviderLogin(fetchImpl);
    try {
      grant = await login.probe(env, id, org, now).then(async (verdict) => {
        if (!verdict.ok) throw new Error(verdict.message);
        const cipher = await store.get(tokenKey(org, id), { type: "text" });
        if (!cipher) throw new Error("missing");
        return JSON.parse(await decrypt(env, org, id, cipher)) as StoredGrant;
      });
    } catch {
      return null;
    }
  }
  return { authorization: `Bearer ${grant.access}`, accountId: grant.accountId, provider: grant.provider };
}
