/**
 * Worker-side Codex access-token refresh — auth.openai.com is never admitted
 * to the sandbox egress allowlist; only this module talks to it.
 */
import { parseCodexAuthJson } from "@shiba/shared";

const REFRESH_URL = "https://auth.openai.com/oauth/token";
const EXPIRY_SKEW_MS = 5 * 60_000;

interface CodexAuthFile {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string | null;
    account_id?: string;
  };
}

function jwtExpMs(accessToken: string): number | null {
  const parts = accessToken.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function accessTokenNeedsRefresh(accessToken: string, now = Date.now()): boolean {
  const exp = jwtExpMs(accessToken);
  if (exp === null) return false;
  return exp - now <= EXPIRY_SKEW_MS;
}

export async function refreshCodexAuthJson(
  raw: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ authJson: string; rotated: boolean }> {
  const parsed = JSON.parse(raw) as CodexAuthFile;
  const access = parsed.tokens?.access_token;
  const refresh = parsed.tokens?.refresh_token;
  if (typeof access !== "string" || access === "") {
    throw new Error("auth.json has no access_token.");
  }
  if (!accessTokenNeedsRefresh(access)) {
    return { authJson: raw, rotated: false };
  }
  if (typeof refresh !== "string" || refresh === "") {
    throw new Error("access token expired and no refresh_token is stored.");
  }
  const response = await fetchImpl(REFRESH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refresh }),
  });
  if (!response.ok) {
    throw new Error(`token refresh failed (${response.status}).`);
  }
  const body = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
  };
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new Error("token refresh returned no access_token.");
  }
  const next: CodexAuthFile = {
    ...parsed,
    tokens: {
      ...parsed.tokens,
      access_token: body.access_token,
      refresh_token: typeof body.refresh_token === "string" && body.refresh_token !== ""
        ? body.refresh_token
        : refresh,
      id_token: body.id_token ?? parsed.tokens?.id_token ?? null,
    },
  };
  const serialized = JSON.stringify(next);
  if (parseCodexAuthJson(serialized) === null) {
    throw new Error("refreshed auth.json is invalid.");
  }
  return { authJson: serialized, rotated: true };
}
