import type { Env } from "./env.js";
import { connectedDefaultForUser } from "./acp-providers.js";
import { readModelConfig, resolveCodingRoute } from "./model-policy.js";
import { describeRoleModels } from "./agents/roles.js";
import { defaultCodingFromConnection } from "./model-defaults.js";
import { assertModelRunPreflight } from "./run-preflight.js";
import { verifyStandinEnabled } from "@shiba/shared";
import { webSearchConfigured } from "./tools/web-search.js";

export interface ModelRouteStatus {
  ready: boolean;
  via: "personal-provider" | "gateway" | "connection" | null;
  fix: { kind: "connect-provider"; label: string; href: string } | null;
}

export interface ToolSetupRow {
  id: "web_search" | "generate_image" | "browser" | "knowledge_search";
  label: string;
  ready: boolean;
  /** Env var or binding name to set; names only, never values. */
  env: string;
}

const PROVIDERS_FIX = {
  kind: "connect-provider",
  label: "Connect ChatGPT or Claude",
  href: "/settings/?section=providers",
} as const;

/** Reuses run authorization without requiring sandbox infrastructure for model readiness. */
export async function readModelRoute(env: Env, userId?: string, gatewayReachable: "yes" | "unauthorized" | "error" | "unknown" = "unknown"): Promise<ModelRouteStatus> {
  if (userId && await connectedDefaultForUser(env, userId)) {
    return { ready: true, via: "personal-provider", fix: null };
  }
  const snapshot = await readModelConfig(env);
  const authorizationEnv = gatewayReachable === "unauthorized" ? { ...env, AI_GATEWAY_TOKEN: "" } : env;
  const candidates = [
    ...snapshot.connections.flatMap((connection) => {
      const pair = connection.status === "ready" ? defaultCodingFromConnection(connection) : null;
      return pair ? [{ harness: pair.harness, model: pair.model, connectionId: connection.id }] : [];
    }),
    ...describeRoleModels(env, snapshot.policy.rolePins, snapshot).filter((row) => !row.error),
  ];
  for (const candidate of candidates) {
    try {
      const route = resolveCodingRoute(snapshot, candidate, { initiatorUserId: userId });
      await assertModelRunPreflight(authorizationEnv, {
        harness: candidate.harness, codingModel: candidate.model, route, initiatorUserId: userId,
      }, snapshot);
      return { ready: true, via: route.connectionId ? "connection" : authorizationEnv.AI_GATEWAY_TOKEN?.trim() ? "gateway" : "personal-provider", fix: null };
    } catch {
      // A ready catalog row alone does not prove this user's credentials are usable.
    }
  }
  if (authorizationEnv.AI_GATEWAY_TOKEN?.trim() || verifyStandinEnabled(env)) {
    return { ready: true, via: "gateway", fix: null };
  }
  return { ready: false, via: null, fix: PROVIDERS_FIX };
}

export function readToolSetup(env: Env): ToolSetupRow[] {
  const imageMissing = [!env.AI ? "AI" : null, !(env.FILES ?? env.ARTIFACTS) ? "FILES or ARTIFACTS" : null].filter(Boolean);
  return [
    { id: "web_search", label: "Web search", ready: webSearchConfigured(env), env: "WEB_SEARCH_API_KEY" },
    { id: "generate_image", label: "Image generation", ready: imageMissing.length === 0, env: imageMissing.join("; ") || "AI; FILES or ARTIFACTS" },
    { id: "browser", label: "Browser", ready: Boolean(env.BROWSER), env: "BROWSER" },
    // Keyword search needs only the database; semantic ranking is an optional
    // upgrade, so the label says so rather than reporting the tool unavailable.
    {
      id: "knowledge_search",
      label: env.AI && env.MEMORY_VECTORS ? "Knowledge search" : "Knowledge search (keyword only)",
      ready: Boolean(env.AGENT_AUDIT),
      env: "AGENT_AUDIT",
    },
  ];
}
