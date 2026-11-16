import type { Env } from "./env.js";
import { connectedDefaultForUser } from "./acp-providers.js";
import { readModelConfig } from "./model-policy.js";
import { verifyStandinEnabled } from "@shiba/shared";
import { webSearchConfigured } from "./tools/web-search.js";

export interface ModelRouteStatus {
  ready: boolean;
  via: "personal-provider" | "gateway" | "connection" | null;
  fix: { kind: "connect-provider"; label: string; href: string } | null;
}

export interface ToolSetupRow {
  id: "web_search" | "generate_image" | "browser";
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

/** Mirrors the credential checks in run-preflight.ts: personal default, ready connection, then gateway token. */
export async function readModelRoute(env: Env, userId?: string): Promise<ModelRouteStatus> {
  if (userId && await connectedDefaultForUser(env, userId)) {
    return { ready: true, via: "personal-provider", fix: null };
  }
  const snapshot = await readModelConfig(env);
  if (snapshot.connections.some((connection) => connection.status === "ready")) {
    return { ready: true, via: "connection", fix: null };
  }
  if (env.AI_GATEWAY_TOKEN?.trim() || verifyStandinEnabled(env)) {
    return { ready: true, via: "gateway", fix: null };
  }
  return { ready: false, via: null, fix: PROVIDERS_FIX };
}

export function readToolSetup(env: Env): ToolSetupRow[] {
  return [
    { id: "web_search", label: "Web search", ready: webSearchConfigured(env), env: "WEB_SEARCH_API_KEY" },
    { id: "generate_image", label: "Image generation", ready: Boolean(env.AI), env: "AI" },
    { id: "browser", label: "Browser", ready: Boolean(env.BROWSER), env: "BROWSER" },
  ];
}
