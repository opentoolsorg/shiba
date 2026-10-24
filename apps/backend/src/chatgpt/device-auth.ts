/**
 * ChatGPT device-code grant used by the Codex CLI
 * (openai/codex codex-rs/login/src/device_code_auth.rs).
 *
 * usercode → poll deviceauth/token → authorization_code exchange at oauth/token.
 * 403/404 (and authorization_pending) mean the user has not approved yet.
 * HTML 403 is a bot challenge, not a pending grant.
 */
export const CODEX_DEVICE_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";
export const CODEX_DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const CODEX_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
export const CODEX_DEVICE_OAUTH_URL = "https://auth.openai.com/oauth/token";
export const CODEX_DEVICE_REDIRECT = "https://auth.openai.com/deviceauth/callback";

const PENDING_ERRORS = new Set(["authorization_pending", "slow_down", "access_pending"]);

export interface DeviceCodeStart {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  verificationUri: string;
}

export interface DeviceCodeTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  idToken: string | null;
  accountId: string | null;
  email: string | null;
}

export type DevicePoll =
  | { status: "pending" }
  | { status: "ready"; authorizationCode: string; codeVerifier: string }
  | { status: "tokens"; tokens: DeviceCodeTokens }
  | { status: "error"; message: string };

export function codexDeviceHeaders(contentType: string): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": contentType,
    originator: "codex_cli_rs",
    "User-Agent": "codex_cli_rs/0.0.0",
  };
}

function asRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(body: Record<string, unknown> | null, key: string): string {
  const value = body?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function intervalMs(value: unknown): number {
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : 5;
  if (!Number.isFinite(seconds) || seconds < 0) return 5_000;
  return Math.min(Math.max(seconds * 1000, 0), 15_000);
}

export function looksLikeDeviceChallenge(status: number, bodyText: string, contentType = ""): boolean {
  if (status !== 403 && status !== 503) return false;
  const type = contentType.toLowerCase();
  if (type.includes("text/html")) return true;
  const sample = bodyText.slice(0, 4096).toLowerCase();
  return sample.includes("<html") || sample.includes("just a moment") || sample.includes("challenge-platform");
}

function tokensFrom(body: Record<string, unknown> | null): DeviceCodeTokens | null {
  const accessToken = str(body, "access_token");
  const refreshToken = str(body, "refresh_token");
  if (accessToken === "" || refreshToken === "") return null;
  const expiresRaw = body?.expires_in;
  const expiresIn = typeof expiresRaw === "number" && expiresRaw > 0 ? expiresRaw : 3_600;
  const idToken = str(body, "id_token") || null;
  return {
    accessToken,
    refreshToken,
    expiresIn,
    idToken,
    accountId: accountIdFromTokens(accessToken, idToken),
    email: emailFromIdToken(idToken),
  };
}

export function interpretDevicePoll(status: number, bodyText: string, contentType = ""): DevicePoll {
  if (looksLikeDeviceChallenge(status, bodyText, contentType)) {
    return {
      status: "error",
      message: "ChatGPT blocked the sign-in check from this network. Choose Finish sign-in again.",
    };
  }
  const body = asRecord(bodyText);
  const error = str(body, "error");
  if (status === 403 || status === 404 || PENDING_ERRORS.has(error)) {
    return { status: "pending" };
  }
  if (status >= 200 && status < 300) {
    const authorizationCode = str(body, "authorization_code") || str(body, "code");
    const codeVerifier = str(body, "code_verifier");
    if (authorizationCode !== "" && codeVerifier !== "") {
      return { status: "ready", authorizationCode, codeVerifier };
    }
    const tokens = tokensFrom(body);
    if (tokens) return { status: "tokens", tokens };
    return { status: "error", message: "ChatGPT returned an incomplete device grant. Start again." };
  }
  if (error !== "" && !PENDING_ERRORS.has(error)) {
    return { status: "error", message: "ChatGPT did not finish sign-in. Start again." };
  }
  return { status: "error", message: `ChatGPT did not finish sign-in (HTTP ${status}). Start again.` };
}

export function deviceTokenForm(code: string, verifier: string): string {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: CODEX_DEVICE_REDIRECT,
    client_id: CODEX_DEVICE_CLIENT_ID,
    code_verifier: verifier,
  }).toString();
}

export function deviceRefreshForm(refreshToken: string): string {
  return new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CODEX_DEVICE_CLIENT_ID,
    refresh_token: refreshToken,
  }).toString();
}

function decodeJwtPayload(token: string | null): Record<string, unknown> | null {
  if (!token) return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function accountIdFromTokens(accessToken: string, idToken: string | null): string | null {
  for (const token of [idToken, accessToken]) {
    const payload = decodeJwtPayload(token);
    if (!payload) continue;
    if (typeof payload.chatgpt_account_id === "string") return payload.chatgpt_account_id;
    const ns = payload["https://api.openai.com/auth"];
    if (ns && typeof ns === "object") {
      const id = (ns as Record<string, unknown>).chatgpt_account_id;
      if (typeof id === "string") return id;
    }
  }
  return null;
}

function emailFromIdToken(idToken: string | null): string | null {
  const payload = decodeJwtPayload(idToken);
  return payload && typeof payload.email === "string" ? payload.email : null;
}

async function readBody(response: Response): Promise<{ text: string; type: string }> {
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  return { text, type };
}

export async function requestDeviceCode(fetchImpl: typeof fetch): Promise<DeviceCodeStart> {
  const response = await fetchImpl(CODEX_DEVICE_USERCODE_URL, {
    method: "POST",
    headers: codexDeviceHeaders("application/json"),
    body: JSON.stringify({ client_id: CODEX_DEVICE_CLIENT_ID }),
  });
  const { text, type } = await readBody(response);
  if (!response.ok) {
    if (looksLikeDeviceChallenge(response.status, text, type)) {
      throw new Error("ChatGPT blocked the device sign-in request. Try again in a moment.");
    }
    throw new Error(`ChatGPT device sign-in could not start (HTTP ${response.status}).`);
  }
  const body = asRecord(text);
  const deviceAuthId = str(body, "device_auth_id");
  const userCode = str(body, "user_code") || str(body, "usercode");
  if (deviceAuthId === "" || userCode === "") {
    throw new Error("ChatGPT device sign-in returned no user code.");
  }
  return {
    deviceAuthId,
    userCode,
    intervalMs: intervalMs(body?.interval),
    verificationUri: CODEX_DEVICE_VERIFICATION_URL,
  };
}

export async function pollDeviceOnce(
  fetchImpl: typeof fetch,
  pending: { deviceAuthId: string; userCode: string },
): Promise<DevicePoll> {
  const response = await fetchImpl(CODEX_DEVICE_TOKEN_URL, {
    method: "POST",
    headers: codexDeviceHeaders("application/json"),
    body: JSON.stringify({
      device_auth_id: pending.deviceAuthId,
      user_code: pending.userCode,
    }),
  });
  const { text, type } = await readBody(response);
  return interpretDevicePoll(response.status, text, type);
}

export async function exchangeDeviceCode(fetchImpl: typeof fetch, code: string, verifier: string): Promise<DeviceCodeTokens> {
  const response = await fetchImpl(CODEX_DEVICE_OAUTH_URL, {
    method: "POST",
    headers: codexDeviceHeaders("application/x-www-form-urlencoded"),
    body: deviceTokenForm(code, verifier),
  });
  const { text, type } = await readBody(response);
  if (looksLikeDeviceChallenge(response.status, text, type) || !response.ok) {
    throw new Error(
      looksLikeDeviceChallenge(response.status, text, type)
        ? "ChatGPT blocked the token exchange. Choose Finish sign-in again."
        : `ChatGPT token exchange failed (HTTP ${response.status}). Start again.`,
    );
  }
  const tokens = tokensFrom(asRecord(text));
  if (!tokens) throw new Error("ChatGPT returned no access token. Start again.");
  return tokens;
}

export async function refreshDeviceTokens(fetchImpl: typeof fetch, refreshToken: string): Promise<DeviceCodeTokens> {
  const response = await fetchImpl(CODEX_DEVICE_OAUTH_URL, {
    method: "POST",
    headers: codexDeviceHeaders("application/x-www-form-urlencoded"),
    body: deviceRefreshForm(refreshToken),
  });
  const { text } = await readBody(response);
  if (!response.ok) throw new Error("ChatGPT could not renew the saved sign-in.");
  const tokens = tokensFrom(asRecord(text));
  if (!tokens) throw new Error("ChatGPT could not renew the saved sign-in.");
  return tokens;
}

/** One Finish click polls a few times so an approval that lands mid-click still connects. */
export async function finishDevicePoll(
  fetchImpl: typeof fetch,
  pending: { deviceAuthId: string; userCode: string; intervalMs: number },
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<DevicePoll> {
  const attempts = 4;
  for (let i = 0; i < attempts; i += 1) {
    const poll = await pollDeviceOnce(fetchImpl, pending);
    if (poll.status !== "pending") return poll;
    if (i < attempts - 1) await sleep(Math.min(pending.intervalMs || 1_000, 1_000));
  }
  return { status: "pending" };
}
