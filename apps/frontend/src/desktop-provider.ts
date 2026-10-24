/** True when the desktop shell can receive this ChatGPT PKCE authorize URL on loopback. */
export function desktopCodexAuthorizationUrl(value: string | null | undefined): string | null {
  if (!value || value.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "auth.openai.com" ||
    url.username ||
    url.password
  ) {
    return null;
  }
  if (
    !url.searchParams.get("code_challenge") ||
    url.searchParams.get("code_challenge_method") !== "S256"
  ) {
    return null;
  }
  const redirect = url.searchParams.get("redirect_uri");
  if (!redirect) return null;
  let redir: URL;
  try {
    redir = new URL(redirect);
  } catch {
    return null;
  }
  const port = Number(redir.port);
  if (
    redir.protocol !== "http:" ||
    redir.hostname !== "127.0.0.1" ||
    redir.pathname !== "/auth/callback" ||
    !Number.isInteger(port) ||
    port < 1024
  ) {
    return null;
  }
  return url.toString();
}

export function desktopCanSignInClaude(
  bridge: { startClaudeLogin?: unknown } | undefined,
  providerId: string,
): boolean {
  return providerId === "claude" && typeof bridge?.startClaudeLogin === "function";
}
