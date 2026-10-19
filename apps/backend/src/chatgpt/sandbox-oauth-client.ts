/**
 * Short-lived sandbox OAuth token exchange/refresh for ChatGPT SIWC.
 * Refresh tokens enter the auth sandbox only for the request, never task sandboxes.
 */
import type { Env } from "../env.js";
import { shellJoin } from "@shiba/shared";
import type { OpenIdDiscovery } from "./siwc.js";
import { ChatGptOAuthError, type TokenResponse } from "./siwc-oauth.js";

const AUTH_HOSTS = ["auth.openai.com"] as const;
const BODY_PATH = "/tmp/shiba-siwc-oauth-body.txt";
const RESPONSE_PATH = "/tmp/shiba-siwc-oauth-response.json";

export interface SandboxOAuthRunner {
  exchange(discovery: OpenIdDiscovery, body: URLSearchParams, userId: string): Promise<TokenResponse>;
}

export interface SandboxOAuthExecSurface {
  setAllowedHosts?(hosts: string[]): Promise<void>;
  setSleepAfter?(sleepAfter: string | number): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  exec(command: string, opts?: { cwd?: string }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  destroy?(): Promise<void>;
}

function parseTokenResponse(raw: string): TokenResponse {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ChatGptOAuthError("Sandbox OAuth returned non-JSON.");
  }
  const access = parsed.access_token;
  const tokenType = parsed.token_type;
  const expiresIn = parsed.expires_in;
  const scope = parsed.scope;
  if (typeof access !== "string" || access === "") throw new ChatGptOAuthError("Token response missing access_token.");
  if (typeof tokenType !== "string") throw new ChatGptOAuthError("Token response missing token_type.");
  if (typeof expiresIn !== "number" || expiresIn <= 0) throw new ChatGptOAuthError("Token response missing expires_in.");
  if (typeof scope !== "string") throw new ChatGptOAuthError("Token response missing scope.");
  return {
    access_token: access,
    refresh_token: typeof parsed.refresh_token === "string" ? parsed.refresh_token : undefined,
    id_token: typeof parsed.id_token === "string" ? parsed.id_token : undefined,
    token_type: tokenType,
    expires_in: expiresIn,
    scope,
    earliest_refresh_at: parsed.earliest_refresh_at as number | string | undefined,
  };
}

export async function runSandboxOAuthExchange(
  sandbox: SandboxOAuthExecSurface,
  discovery: OpenIdDiscovery,
  body: URLSearchParams,
): Promise<TokenResponse> {
  await sandbox.setSleepAfter?.("5m");
  await sandbox.setAllowedHosts?.([...AUTH_HOSTS]);
  await sandbox.writeFile(BODY_PATH, body.toString());
  const endpoint = discovery.token_endpoint;
  const curl = shellJoin([
    "curl",
    "-sS",
    "-X",
    "POST",
    endpoint,
    "-H",
    "accept: application/json",
    "-H",
    "content-type: application/x-www-form-urlencoded",
    "--data-binary",
    `@${BODY_PATH}`,
    "-o",
    RESPONSE_PATH,
    "-w",
    "%{http_code}",
  ]);
  const result = await sandbox.exec(curl);
  if (result.exitCode !== 0) {
    throw new ChatGptOAuthError(`Sandbox OAuth curl failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  const statusLine = result.stdout.trim();
  const status = Number.parseInt(statusLine.slice(-3), 10);
  const read = await sandbox.exec(shellJoin(["cat", RESPONSE_PATH]));
  if (read.exitCode !== 0) {
    throw new ChatGptOAuthError("Sandbox OAuth response file missing.");
  }
  const responseBody = read.stdout;
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    const code = (() => {
      try {
        const err = JSON.parse(responseBody) as { error?: unknown };
        return typeof err.error === "string" ? err.error : "exchange_failed";
      } catch {
        return "exchange_failed";
      }
    })();
    throw new ChatGptOAuthError("ChatGPT token exchange failed in sandbox.", code);
  }
  return parseTokenResponse(responseBody);
}

export function createSandboxOAuthRunner(env: Pick<Env, "Sandbox">): SandboxOAuthRunner | null {
  if (!env.Sandbox) return null;
  return {
    async exchange(discovery, body, userId) {
      const safeUser = userId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48);
      const sandboxId = `siwc-oauth-${safeUser}-${crypto.randomUUID().slice(0, 8)}`;
      const { getSandbox } = await import("../sandbox/client.js");
      const sandbox = getSandbox(env.Sandbox, sandboxId) as unknown as SandboxOAuthExecSurface;
      try {
        return await runSandboxOAuthExchange(sandbox, discovery, body);
      } finally {
        await sandbox.destroy?.().catch(() => undefined);
      }
    },
  };
}

export function sandboxOAuthEnabled(env: Pick<Env, "SHIBA_CHATGPT_SIWC_SANDBOX_OAUTH">): boolean {
  return env.SHIBA_CHATGPT_SIWC_SANDBOX_OAUTH === "1";
}
