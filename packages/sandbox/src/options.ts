import { SandboxError } from "./errors.js";
import type { BuiltinSandboxProviderId } from "./types.js";

/** Cross-provider knobs parsed from env / config. */
export interface SandboxCommonOptions {
  /** Default exec timeout (ms). */
  timeoutMs: number;
  /** Opaque region hint for hosted backends (provider-specific). */
  region?: string;
  /** Extra hosts merged into harness egress pins where supported. */
  egressAllowlist: string[];
  /** Non-secret env vars forwarded into sandbox exec (never credentials). */
  envPassthrough: Record<string, string>;
}

export interface CloudflareProviderOptions extends SandboxCommonOptions {
  instanceType: string;
}

export interface DockerLocalProviderOptions extends SandboxCommonOptions {
  image: string;
  previewHost: string;
}

export interface ComputesdkProviderOptions extends SandboxCommonOptions {
  backend: string;
}

export interface E2bStubProviderOptions extends SandboxCommonOptions {
  mockInstance: boolean;
}

export type ParsedSandboxProviderConfig =
  | { id: "cloudflare"; options: CloudflareProviderOptions }
  | { id: "docker-local"; options: DockerLocalProviderOptions }
  | { id: "computesdk"; options: ComputesdkProviderOptions }
  | { id: "e2b"; options: E2bStubProviderOptions }
  | { id: Exclude<string, BuiltinSandboxProviderId>; options: SandboxCommonOptions };

export interface SandboxProviderEnvInput {
  SHIBA_SANDBOX_PROVIDER?: string | undefined;
  SHIBA_SANDBOX_TIMEOUT_MS?: string | undefined;
  SHIBA_SANDBOX_REGION?: string | undefined;
  SHIBA_SANDBOX_EGRESS_ALLOWLIST?: string | undefined;
  /** Comma-separated `KEY=value` pairs (no secrets). */
  SHIBA_SANDBOX_ENV_PASSTHROUGH?: string | undefined;
  INSTANCE_TYPE?: string | undefined;
  SHIBA_DOCKER_SANDBOX_IMAGE?: string | undefined;
  SHIBA_DOCKER_PREVIEW_HOST?: string | undefined;
  SHIBA_COMPUTESDK_PROVIDER?: string | undefined;
  SHIBA_E2B_MOCK?: string | undefined;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function parsePositiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new SandboxError("provider_misconfigured", `${label} must be a positive integer.`, {
      provider: "config",
    });
  }
  return n;
}

function parseHostList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

function parseEnvPassthrough(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) {
      throw new SandboxError(
        "provider_misconfigured",
        `SHIBA_SANDBOX_ENV_PASSTHROUGH entry "${part}" must be KEY=value.`,
        { provider: "config" },
      );
    }
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key) continue;
    out[key] = value;
  }
  return out;
}

function parseCommon(env: SandboxProviderEnvInput): SandboxCommonOptions {
  const common: SandboxCommonOptions = {
    timeoutMs: parsePositiveInt(env.SHIBA_SANDBOX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, "SHIBA_SANDBOX_TIMEOUT_MS"),
    egressAllowlist: parseHostList(env.SHIBA_SANDBOX_EGRESS_ALLOWLIST),
    envPassthrough: parseEnvPassthrough(env.SHIBA_SANDBOX_ENV_PASSTHROUGH),
  };
  const region = env.SHIBA_SANDBOX_REGION?.trim();
  if (region) common.region = region;
  return common;
}

export function parseSandboxProviderConfig(
  env: SandboxProviderEnvInput,
  providerId: string,
): ParsedSandboxProviderConfig {
  const common = parseCommon(env);
  const id = providerId.trim().toLowerCase() as BuiltinSandboxProviderId | string;

  switch (id) {
    case "cloudflare":
      return {
        id: "cloudflare",
        options: {
          ...common,
          instanceType: env.INSTANCE_TYPE?.trim() || "standard-1",
        },
      };
    case "docker-local":
      return {
        id: "docker-local",
        options: {
          ...common,
          image: env.SHIBA_DOCKER_SANDBOX_IMAGE?.trim() || "shiba-sandbox:local",
          previewHost: env.SHIBA_DOCKER_PREVIEW_HOST?.trim() || "127.0.0.1",
        },
      };
    case "computesdk": {
      const backend = env.SHIBA_COMPUTESDK_PROVIDER?.trim().toLowerCase();
      if (!backend) {
        throw new SandboxError(
          "provider_misconfigured",
          "SHIBA_COMPUTESDK_PROVIDER is required when SHIBA_SANDBOX_PROVIDER=computesdk.",
          { provider: "computesdk" },
        );
      }
      return { id: "computesdk", options: { ...common, backend } };
    }
    case "e2b":
      return {
        id: "e2b",
        options: {
          ...common,
          mockInstance: env.SHIBA_E2B_MOCK?.trim() === "1",
        },
      };
    default:
      return { id, options: common };
  }
}
