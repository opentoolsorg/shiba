export interface SsoEnv {
  SHIBA_SSO_ENABLED?: string;
  SSO_OIDC_ISSUER?: string;
  SSO_OIDC_CLIENT_ID?: string;
  SSO_OIDC_CLIENT_SECRET?: string;
  SSO_OIDC_DISPLAY_NAME?: string;
  SSO_ALLOWED_DOMAINS?: string;
  SSO_AUTO_JOIN?: string;
  BETTER_AUTH_OWNER_EMAIL?: string;
}

const required = ["SSO_OIDC_ISSUER", "SSO_OIDC_CLIENT_ID", "SSO_OIDC_CLIENT_SECRET"] as const;

/** Parse locally without making discovery requests or exposing values to public options. */
export function getSsoConfig(env: SsoEnv) {
  const missing: string[] = required.filter(name => !env[name]?.trim());
  let issuer = env.SSO_OIDC_ISSUER?.trim().replace(/\/+$/, "");
  if (issuer) {
    try {
      const url = new URL(issuer);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
        url.username || url.password || url.search || url.hash) throw new Error("Invalid issuer");
    } catch {
      if (!missing.includes("SSO_OIDC_ISSUER")) missing.push("SSO_OIDC_ISSUER");
      issuer = undefined;
    }
  }
  return {
    enabled: env.SHIBA_SSO_ENABLED === "1" && missing.length === 0,
    displayName: env.SSO_OIDC_DISPLAY_NAME?.trim() || "Company SSO",
    missing, issuer,
    clientId: env.SSO_OIDC_CLIENT_ID?.trim(),
    clientSecret: env.SSO_OIDC_CLIENT_SECRET?.trim(),
    allowedDomains: (env.SSO_ALLOWED_DOMAINS ?? "").split(",").map(domain => domain.trim().toLowerCase()).filter(Boolean),
    // Automatic workspace enrollment is deliberately outside this core slice.
    autoJoin: false,
  };
}

export function isSsoEmailAllowed(env: SsoEnv, value: unknown): boolean {
  if (typeof value !== "string") return false;
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return false;
  if (email === env.BETTER_AUTH_OWNER_EMAIL?.trim().toLowerCase()) return true;
  return getSsoConfig(env).allowedDomains.includes(email.split("@")[1] ?? "");
}
