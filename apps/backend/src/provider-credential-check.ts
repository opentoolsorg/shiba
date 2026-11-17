import type { Env } from "./env.js";

export type CredentialCheck =
  | { ok: true }
  | { ok: false; reason: "rejected" | "unreachable"; message: string };

export async function checkAnthropicCredential(
  _env: Env,
  token: string,
  kind: "setup-token" | "api-key",
  fetchImpl: typeof fetch = fetch,
): Promise<CredentialCheck> {
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (kind === "setup-token") {
    headers.Authorization = `Bearer ${token}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  } else {
    headers["x-api-key"] = token;
  }
  try {
    const response = await fetchImpl("https://api.anthropic.com/v1/models?limit=1", {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5_000),
      // Workers supports manual redirects, not error; never forward credentials.
      redirect: "manual",
    });
    console.info("Anthropic credential check", `${Math.floor(response.status / 100)}xx`);
    if (response.status === 200) return { ok: true };
    let rejected = response.status === 401 || response.status === 403;
    if (!rejected && response.status >= 400 && response.status < 500 && response.status !== 429) {
      const body = await response.json().catch(() => null) as { error?: { type?: unknown } } | null;
      rejected = body?.error?.type === "authentication_error" || body?.error?.type === "permission_error";
    }
    if (rejected) {
      return {
        ok: false,
        reason: "rejected",
        message: kind === "setup-token"
          ? "Anthropic rejected this token. Run claude setup-token again and paste the new token."
          : "Anthropic rejected this API key. Paste a new key from Anthropic.",
      };
    }
  } catch {
    // Provider errors can contain credentials; return only our fixed message.
  }
  return {
    ok: false,
    reason: "unreachable",
    message: "Couldn't reach Anthropic to check the token. Try again in a minute.",
  };
}
