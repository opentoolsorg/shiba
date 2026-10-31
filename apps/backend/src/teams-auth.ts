/**
 * Bot Framework inbound JWT verification and connector OAuth for Teams outbound
 * posts. Microsoft signs each activity delivery with a Bearer JWT whose
 * `serviceurl` claim must match the activity's `serviceUrl`.
 *
 * @see https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authenticate-requests
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export const BOTFRAMEWORK_JWKS_URL = "https://login.botframework.com/v1/.well-known/keys";
export const BOTFRAMEWORK_TOKEN_URL = "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";
export const BOTFRAMEWORK_TOKEN_SCOPE = "https://api.botframework.com/.default";

const defaultJwks = createRemoteJWKSet(new URL(BOTFRAMEWORK_JWKS_URL));

function bearerToken(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

function issuerAllowed(iss: string): boolean {
  return iss === "https://api.botframework.com" || iss.startsWith("https://sts.windows.net/");
}

export interface VerifyTeamsBearerInput {
  authorization: string | null;
  appId: string;
  serviceUrl: string;
  /** Test hook: substitute JWKS verification. */
  jwks?: JWTVerifyGetKey;
}

/** True only when the Bot Framework JWT matches this app id and activity serviceUrl. */
export async function verifyTeamsBearerToken(input: VerifyTeamsBearerInput): Promise<boolean> {
  const token = bearerToken(input.authorization);
  const appId = input.appId.trim();
  const serviceUrl = input.serviceUrl.trim();
  if (!token || !appId || !serviceUrl) return false;
  try {
    const { payload } = await jwtVerify(token, input.jwks ?? defaultJwks, {
      audience: appId,
      algorithms: ["RS256"],
    });
    const iss = payload.iss;
    if (typeof iss !== "string" || !issuerAllowed(iss)) return false;
    const claimUrl = typeof payload.serviceurl === "string" ? payload.serviceurl : "";
    return claimUrl.toLowerCase() === serviceUrl.toLowerCase();
  } catch {
    return false;
  }
}

let cachedConnectorToken: { token: string; expiresAtMs: number } | null = null;

export interface ConnectorTokenDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Client-credentials token for Bot Connector REST (post/update activities). */
export async function getBotFrameworkConnectorToken(
  appId: string,
  appPassword: string,
  deps: ConnectorTokenDeps = {},
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const id = appId.trim();
  const secret = appPassword.trim();
  if (!id || !secret) {
    throw new Error("Teams connector credentials are missing.");
  }
  if (cachedConnectorToken && cachedConnectorToken.expiresAtMs > now() + 60_000) {
    return cachedConnectorToken.token;
  }
  let response: Response;
  try {
    response = await fetchImpl(BOTFRAMEWORK_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: id,
        client_secret: secret,
        scope: BOTFRAMEWORK_TOKEN_SCOPE,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("Bot Framework token request failed.");
  }
  const json = (await response.json().catch(() => ({}))) as {
    access_token?: unknown;
    expires_in?: unknown;
    error?: unknown;
  };
  if (!response.ok || typeof json.access_token !== "string") {
    const reason = typeof json.error === "string" ? json.error : `HTTP ${response.status}`;
    throw new Error(`Bot Framework token failed: ${reason}`);
  }
  const expiresIn = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
  cachedConnectorToken = { token: json.access_token, expiresAtMs: now() + expiresIn * 1000 };
  return json.access_token;
}

/** Test hook: drop cached connector token between cases. */
export function clearBotFrameworkConnectorTokenCache(): void {
  cachedConnectorToken = null;
}
