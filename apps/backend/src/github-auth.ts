/**
 * GitHub API credentials: fine-grained PAT (legacy) or GitHub App installation token (multi-repo).
 * Tokens never enter sandboxes; only Worker code calls these helpers.
 */
import type { Env } from "./env.js";
import { parseGitHubRepoUrl } from "./security.js";

export type GitHubCredentialMode = "pat" | "app";

export interface ResolvedGitHubCredential {
  mode: GitHubCredentialMode;
  token: string;
  apiBase: string;
  installationId?: number;
}

interface InstallationTokenCache {
  token: string;
  expiresAtMs: number;
  installationId: number;
}

const tokenCache = new Map<number, InstallationTokenCache>();

const API_DEFAULT = "https://api.github.com";

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** RS256 JWT for GitHub App authentication (10 minute max). */
export async function createGitHubAppJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: nowSec - 60, exp: nowSec + 9 * 60, iss: appId };
  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unsigned = `${encode(header)}.${encode(payload)}`;
  const rsaKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rsaKey, new TextEncoder().encode(unsigned));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${unsigned}.${sigB64}`;
}

async function fetchInstallationToken(
  installationId: number,
  appId: string,
  privateKeyPem: string,
  apiBase: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAtMs > Date.now() + 60_000) {
    return cached.token;
  }
  const jwt = await createGitHubAppJwt(appId, privateKeyPem);
  const response = await fetchImpl(`${apiBase}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "User-Agent": "shiba",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub installation token failed (${response.status})`);
  }
  const json = JSON.parse(text) as { token?: string; expires_at?: string };
  if (!json.token) {
    throw new Error("GitHub installation token response missing token.");
  }
  const expiresAtMs = json.expires_at ? Date.parse(json.expires_at) : Date.now() + 55 * 60_000;
  tokenCache.set(installationId, { token: json.token, expiresAtMs, installationId });
  return json.token;
}

function parseRepoInstallations(raw: string | undefined): Record<string, number> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [repo, id] of Object.entries(parsed)) {
      const n = typeof id === "number" ? id : Number(id);
      if (Number.isFinite(n) && n > 0) out[repo.toLowerCase()] = n;
    }
    return out;
  } catch {
    return {};
  }
}

export function resolveInstallationId(env: Env, repoFullName?: string): number | null {
  const map = parseRepoInstallations(env.GITHUB_APP_REPO_INSTALLATIONS);
  if (repoFullName) {
    const hit = map[repoFullName.toLowerCase()];
    if (hit) return hit;
  }
  const fallback = env.GITHUB_APP_INSTALLATION_ID?.trim();
  if (!fallback) return null;
  const n = Number(fallback);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function isGitHubPublishConfigured(env: Env): boolean {
  if (env.GITHUB_TOKEN?.trim()) return true;
  return Boolean(
    env.GITHUB_APP_ID?.trim() &&
      env.GITHUB_APP_PRIVATE_KEY?.trim() &&
      (env.GITHUB_APP_INSTALLATION_ID?.trim() || env.GITHUB_APP_REPO_INSTALLATIONS?.trim()),
  );
}

/**
 * Resolve a Bearer token for GitHub REST calls. Prefers App installation token when App env is set.
 */
export async function resolveGitHubCredential(
  env: Env,
  repoUrl?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedGitHubCredential | null> {
  const apiBase = (env.GITHUB_API_BASE ?? API_DEFAULT).replace(/\/$/, "");
  const appId = env.GITHUB_APP_ID?.trim();
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (appId && privateKey) {
    let repoFullName: string | undefined;
    if (repoUrl) {
      try {
        const { owner, repo } = parseGitHubRepoUrl(repoUrl);
        repoFullName = `${owner}/${repo}`;
      } catch {
        repoFullName = undefined;
      }
    }
    const installationId = resolveInstallationId(env, repoFullName);
    if (!installationId) {
      return null;
    }
    const token = await fetchInstallationToken(installationId, appId, privateKey, apiBase, fetchImpl);
    return { mode: "app", token, apiBase, installationId };
  }
  const pat = env.GITHUB_TOKEN?.trim();
  if (pat) {
    return { mode: "pat", token: pat, apiBase };
  }
  return null;
}

/** Synchronous token when only a PAT is configured (App mode must use async resolver). */
export function githubPatOrNull(env: Env): string | null {
  return env.GITHUB_TOKEN?.trim() ?? null;
}
