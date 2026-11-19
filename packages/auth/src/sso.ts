export interface SsoEnv {
  SHIBA_SSO_ENABLED?: string;
  SSO_OIDC_PRESET?: string;
  SSO_OIDC_ISSUER?: string;
  SSO_OIDC_CLIENT_ID?: string;
  SSO_OIDC_CLIENT_SECRET?: string;
  SSO_OIDC_DISPLAY_NAME?: string;
  SSO_ALLOWED_DOMAINS?: string;
  SSO_AUTO_JOIN?: string;
  BETTER_AUTH_OWNER_EMAIL?: string;
}

/** Opt-in issuer presets. Without SSO_OIDC_PRESET the issuer comes from SSO_OIDC_ISSUER. */
const SSO_OIDC_PRESETS = {
  "google-workspace": { issuer: "https://accounts.google.com", displayName: "Google Workspace" },
} as const;
type SsoOidcPreset = keyof typeof SSO_OIDC_PRESETS;

const clientSettings = ["SSO_OIDC_CLIENT_ID", "SSO_OIDC_CLIENT_SECRET"] as const;

function isValidIssuer(value: string): boolean {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/** Parse locally without making discovery requests or exposing values to public options. */
export function getSsoConfig(env: SsoEnv) {
  const missing: string[] = [];
  const conflicting: string[] = [];
  const presetName = env.SSO_OIDC_PRESET?.trim().toLowerCase() || undefined;
  const preset = presetName && Object.hasOwn(SSO_OIDC_PRESETS, presetName) ? presetName as SsoOidcPreset : undefined;
  const configuredIssuer = env.SSO_OIDC_ISSUER?.trim().replace(/\/+$/, "") || undefined;
  let issuer: string | undefined;
  if (presetName && !preset) {
    missing.push("SSO_OIDC_PRESET");
  } else if (preset) {
    if (configuredIssuer && configuredIssuer !== SSO_OIDC_PRESETS[preset].issuer) conflicting.push("SSO_OIDC_PRESET", "SSO_OIDC_ISSUER");
    else issuer = SSO_OIDC_PRESETS[preset].issuer;
  } else if (configuredIssuer && isValidIssuer(configuredIssuer)) {
    issuer = configuredIssuer;
  } else {
    missing.push("SSO_OIDC_ISSUER");
  }
  missing.push(...clientSettings.filter(name => !env[name]?.trim()));
  return {
    enabled: env.SHIBA_SSO_ENABLED === "1" && missing.length === 0 && conflicting.length === 0,
    displayName: env.SSO_OIDC_DISPLAY_NAME?.trim() || (preset ? SSO_OIDC_PRESETS[preset].displayName : "Company SSO"),
    preset, missing, conflicting, issuer,
    /** Setting names this mode reads, for name-only status reporting. */
    settings: [presetName ? "SSO_OIDC_PRESET" : "SSO_OIDC_ISSUER", ...clientSettings],
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
