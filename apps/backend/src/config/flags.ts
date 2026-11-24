/**
 * M04 flag registry (docs/proposals/target-architecture-2026-11.md §18).
 *
 * Every SHIBA_* deployment flag the Worker reads is declared here exactly
 * once: name, source (`var` = plain Worker var/env var, `secret` = Worker
 * secret), documented default, and description. Call sites read flags through
 * {@link flag} — never `env.SHIBA_*` directly — so scripts/check-flags.mjs can
 * enforce the single registry and GET /api/admin/flags can enumerate the
 * whole surface.
 *
 * INTERNAL_SIGNING_KEY is registered too (M06): it is not SHIBA_-prefixed so
 * the lint guard does not force its ~15 call-site reads through flag() yet,
 * but the admin surface lists it with the rest of the deployment config.
 *
 * Non-SHIBA feature vars (REASON_NETWORK_ENABLED, AUTOMATIONS_ENABLED, …)
 * stay at their call sites; they are ordinary Env fields outside this
 * registry's SHIBA_* scope.
 */

/** Where a flag's value comes from at runtime. */
export type FlagSource = "var" | "secret";

export interface FlagDefinition {
  /** The env var / secret name, e.g. "SHIBA_LOCAL_RUNTIME". */
  readonly name: string;
  readonly source: FlagSource;
  /** Documented fallback when the deployment leaves the flag unset. */
  readonly default?: string;
  readonly description: string;
}

const DEFINITIONS = [
  {
    name: "SHIBA_LOCAL_RUNTIME",
    source: "var",
    default: "0",
    description:
      "T51 opt-in (§18.13): \"1\" admits runtime:\"local\" at intake and opens the /api/local daemon surface. Absent = every local-runtime request refuses 403 before any approval exists.",
  },
  {
    name: "SHIBA_PERSONAL_LOCAL_EXECUTION",
    source: "var",
    default: "0",
    description:
      "Opt-in owner-bound personal machines; requires SHIBA_LOCAL_RUNTIME=1 plus a >=32-char pairing/signing key. No deployment provider or account fallback.",
  },
  {
    name: "SHIBA_TEAM_MODEL_SESSIONS",
    source: "var",
    default: "0",
    description:
      "Explicit operator-funded, bounded native team text turns. Never enables an implicit billing fallback.",
  },
  {
    name: "SHIBA_TEAM_MODEL_MODEL",
    source: "var",
    default: "@cf/zai-org/glm-4.7-flash",
    description:
      "Exact supported Workers AI model for team sessions; changes invalidate prior funding grants.",
  },
  {
    name: "SHIBA_SHARED_COMPUTER",
    source: "var",
    default: "0",
    description:
      "Opt-in shared offline desktop sessions; also needs SHIBA_SHARED_COMPUTER_IMAGE, the ComputerSession binding, and INTERNAL_SIGNING_KEY.",
  },
  {
    name: "SHIBA_SHARED_COMPUTER_IMAGE",
    source: "var",
    description:
      "Pinned sha256 container image for shared computers (name@sha256:<64 hex>). Unset = the lane reports shared_computer_image_unavailable.",
  },
  {
    name: "SHIBA_ROUTER_CLASSIFY",
    source: "var",
    default: "0",
    description:
      "When \"1\", a close collaboration routing margin may call grok-4.7 once at temperature 0.",
  },
  {
    name: "SHIBA_VERIFY_STANDIN",
    source: "var",
    default: "0",
    description:
      "verify-shiba: \"1\" runs deterministic publish/review without containers.",
  },
  {
    name: "SHIBA_SANDBOX_PROVIDER",
    source: "var",
    default: "cloudflare",
    description:
      "Sandbox backend: cloudflare (default), docker-local, computesdk, e2b stub, or a custom provider registered via SHIBA_SANDBOX_PLUGIN.",
  },
  {
    name: "SHIBA_SANDBOX_PLUGIN",
    source: "var",
    description:
      "Module id/path loaded at Worker startup that calls registerSandboxProvider from @shiba/sandbox (docs/sandbox-custom-provider.md).",
  },
  {
    name: "SHIBA_SANDBOX_TIMEOUT_MS",
    source: "var",
    description: "Sandbox exec timeout override in milliseconds.",
  },
  {
    name: "SHIBA_SANDBOX_REGION",
    source: "var",
    description: "Sandbox provider region hint.",
  },
  {
    name: "SHIBA_SANDBOX_EGRESS_ALLOWLIST",
    source: "var",
    description: "Comma-separated hostnames merged into egress pins where the provider supports them.",
  },
  {
    name: "SHIBA_SANDBOX_ENV_PASSTHROUGH",
    source: "var",
    description: "Comma-separated KEY=value pairs forwarded into sandbox exec (non-secret).",
  },
  {
    name: "SHIBA_E2B_MOCK",
    source: "var",
    default: "0",
    description: "When SHIBA_SANDBOX_PROVIDER=e2b stub: \"1\" = mock instance (tests).",
  },
  {
    name: "SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS",
    source: "var",
    default: "0",
    description:
      "Opt-in for docker-local / hosted sandboxes that cannot enforce Worker egress. Required for coding runs on providers without edge egress enforcement.",
  },
  {
    name: "SHIBA_DOCKER_SANDBOX_IMAGE",
    source: "var",
    default: "shiba-sandbox:local",
    description: "Image for the docker-local provider (defaults to shiba-sandbox:local).",
  },
  {
    name: "SHIBA_DOCKER_PREVIEW_HOST",
    source: "var",
    default: "127.0.0.1",
    description: "Hostname or IP for docker-local preview URLs.",
  },
  {
    name: "SHIBA_COMPUTESDK_PROVIDER",
    source: "var",
    default: "e2b",
    description:
      "When SHIBA_SANDBOX_PROVIDER=computesdk, selects the ComputeSDK backend (e2b, modal, daytona, …). Requires a Node/Bun control plane — not Worker edge.",
  },
  {
    name: "SHIBA_COMPUTESDK_RUNNER_URL",
    source: "var",
    description:
      "When set, the Worker proxies ComputeSDK sandbox ops to this Node/Bun runner (scripts/computesdk-runner.mjs) instead of loading computesdk in-process.",
  },
  {
    name: "SHIBA_COMPUTESDK_RUNNER_TOKEN",
    source: "secret",
    description: "Bearer token for the ComputeSDK runner — never logged.",
  },
  {
    name: "SHIBA_CLAUDE_SUBSCRIPTION",
    source: "var",
    description:
      "Personal Claude subscription kill switch: exactly \"0\" disables the lane. Unset allows per-user storage; legacy operator routes still require \"1\". Deprecated — prefer claude-login (may violate Anthropic terms).",
  },
  {
    name: "SHIBA_CODEX_SUBSCRIPTION",
    source: "var",
    description:
      "Personal ChatGPT subscription kill switch: exactly \"0\" disables the lane. Unset allows per-user storage; legacy operator routes still require \"1\".",
  },
  {
    name: "SHIBA_ANTIGRAVITY_SUBSCRIPTION",
    source: "var",
    description:
      "Personal Antigravity subscription kill switch: exactly \"0\" disables the lane. Unset allows ready per-user OAuth storage; operator routes require \"1\".",
  },
  {
    name: "SHIBA_CURSOR_SUBSCRIPTION",
    source: "var",
    description:
      "Personal Cursor subscription kill switch: exactly \"0\" disables the lane. Unset allows ready per-user OAuth storage; operator routes require \"1\".",
  },
  {
    name: "SHIBA_SINGLE_USER",
    source: "var",
    default: "0",
    description:
      "When \"1\", deployment-wide CODEX_SUBSCRIPTION_AUTH_JSON Worker secrets remain the codex-subscription credential fallback (single-operator mode).",
  },
  {
    name: "SHIBA_DEV_OAUTH_LOOPBACK_SECRET",
    source: "secret",
    description:
      "Local dev only: shared secret (>=16 chars) between scripts/oauth-loopback.mjs and POST /api/dev/oauth-loopback. Minted into .dev.vars by pnpm dev.",
  },
  {
    name: "SHIBA_CHATGPT_SIWC_SANDBOX_OAUTH",
    source: "var",
    default: "0",
    description:
      "When \"1\", ChatGptAuth may run OAuth exchange/refresh inside a short-lived auth sandbox when Worker fetches to auth.openai.com get a bot challenge.",
  },
  {
    name: "SHIBA_CODEX_DEVICE_AUTH",
    source: "var",
    default: "0",
    description:
      "When \"1\", users may opt into codex login --device-auth on a per-user sandbox volume instead of Worker-stored SIWC tokens.",
  },
  {
    name: "SHIBA_ELEVATED_CONCURRENCY",
    source: "var",
    default: "0",
    description:
      "Phase 2b: when \"1\"/\"true\", raise in-app concurrency toward wrangler max_instances (still bounded by the daily budget when set).",
  },
  {
    name: "SHIBA_DAILY_CONTAINER_BUDGET_USD",
    source: "var",
    description: "Phase 2b: optional UTC-day USD cap on summed run.usage.costUsd.",
  },
  {
    name: "SHIBA_SSO_ENABLED",
    source: "var",
    default: "0",
    description: "WS02: optional generic OIDC SSO (per-workspace connections in D1).",
  },
  {
    name: "SHIBA_VIDEO_GENERATION",
    source: "var",
    default: "0",
    description: "Video generation is disabled unless explicitly enabled.",
  },
  {
    name: "VAULT_KEYRING",
    source: "secret",
    description:
      "Optional JSON {current: kid, keys: {kid: hex64}} keyring for keyed vault ciphertext; legacy master keys stay usable for rollback.",
  },
  {
    name: "VAULT_WRITE_V2",
    source: "var",
    default: "0",
    description:
      "Exactly \"1\" enables keyed vault writes; unset preserves rollback-compatible ciphertext.",
  },
  {
    name: "INTERNAL_SIGNING_KEY",
    source: "secret",
    description:
      "M06: HMAC key for Worker→DO vouched-header requests (X-Agent-Principal / X-Shiba-Intake) and the parent→child dispatch seal. Unset = header-trust fallback plus MODEL_CREDENTIAL_KEY dispatch signing, each with a once-per-isolate warning. Registered here for the admin surface; call sites keep their own reads pending M06 conversion.",
  },
] as const satisfies readonly FlagDefinition[];

export type FlagName = (typeof DEFINITIONS)[number]["name"];

/** The registry, in declaration order (literal types preserved for FlagName). */
export const FLAGS = DEFINITIONS;

const FLAG_NAMES = new Set<string>(FLAGS.map((def) => def.name));

/** True when `name` is a registered flag — guards against typos at call sites. */
export function isFlagName(name: string): name is FlagName {
  return FLAG_NAMES.has(name);
}

/**
 * Read a registered flag from any env-shaped object (Env, Pick<Env,…>,
 * HarnessGateEnv | undefined, VaultEnv, …). Returns the raw string value or
 * undefined — callers keep their own "1"/"0"/trim semantics.
 */
export function flag(env: unknown, name: FlagName): string | undefined {
  if (env === null || typeof env !== "object") return undefined;
  const value = (env as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

/** One flag's effective state for the admin surface. */
export interface FlagState {
  readonly name: FlagName;
  readonly source: FlagSource;
  /**
   * Raw value for `var` flags (null when unset); always null for `secret`
   * flags — secret values never leave the Worker through this surface.
   */
  readonly value: string | null;
  /** Whether the deployment supplies a non-empty value. */
  readonly set: boolean;
  readonly default?: string;
  readonly description: string;
}

/** Enumerate every registered flag with its source and effective value. */
export function flagStates(env: unknown): FlagState[] {
  return FLAGS.map((def) => {
    const raw = flag(env, def.name);
    const set = raw !== undefined && raw.trim() !== "";
    return {
      name: def.name,
      source: def.source,
      value: def.source === "secret" ? null : (raw ?? null),
      set,
      ...("default" in def && def.default !== undefined ? { default: def.default } : {}),
      description: def.description,
    };
  });
}
