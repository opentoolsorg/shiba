/**
 * Local verify-shiba stand-in: completes publish+review loops without a
 * sandbox when SHIBA_VERIFY_STANDIN=1 AND GitHub is an explicit loopback mock.
 * Never enabled in production deploys.
 */
export const VERIFY_STANDIN_FLAG = "SHIBA_VERIFY_STANDIN";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** True only for an explicit http loopback origin (the verify-shiba GitHub stub). */
export function isLoopbackMockGithub(apiBase: string | undefined): boolean {
  if (!apiBase) return false;
  try {
    const url = new URL(apiBase);
    return (
      url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

// Fails closed: a missing or non-loopback GITHUB_API_BASE (live GitHub) never enables synthetic runs.
export function verifyStandinEnabled(env: {
  [VERIFY_STANDIN_FLAG]?: string;
  GITHUB_API_BASE?: string;
}): boolean {
  return env[VERIFY_STANDIN_FLAG] === "1" && isLoopbackMockGithub(env.GITHUB_API_BASE);
}
