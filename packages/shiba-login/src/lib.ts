export function parseListenTarget(redirectUri: string): { host: string; port: number; pathname: string } {
  const url = new URL(redirectUri);
  if (url.hostname !== "127.0.0.1") {
    throw new Error("redirect URI must use 127.0.0.1 (not localhost).");
  }
  const port = url.port ? Number.parseInt(url.port, 10) : 80;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error("redirect URI port is invalid.");
  }
  return { host: url.hostname, port, pathname: url.pathname };
}

export function completeRequestBody(callbackUrl: string): string {
  return JSON.stringify({ callbackUrl });
}

export async function postComplete(
  baseUrl: string,
  callbackUrl: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const url = new URL("/api/subscription/openai/complete", baseUrl.replace(/\/$/, ""));
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: completeRequestBody(callbackUrl),
  });
  const body = (await response.json().catch(() => null)) as unknown;
  return { ok: response.ok, status: response.status, body };
}

export async function beginSignIn(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<{ authorizeUrl: string; redirectUri: string }> {
  const url = new URL("/api/subscription/openai/begin", baseUrl.replace(/\/$/, ""));
  const response = await fetch(url, { method: "POST", headers });
  if (!response.ok) {
    throw new Error(`begin failed (${response.status}).`);
  }
  const body = (await response.json()) as { authorizeUrl?: string; redirectUri?: string };
  if (typeof body.authorizeUrl !== "string" || typeof body.redirectUri !== "string") {
    throw new Error("begin response missing authorizeUrl or redirectUri.");
  }
  return { authorizeUrl: body.authorizeUrl, redirectUri: body.redirectUri };
}
