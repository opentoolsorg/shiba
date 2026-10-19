/**
 * `/api/providers` — list, connect, verify, test, disconnect, and the
 * per-org default for ACP adapters.
 *
 * Authenticated by the worker gate like every other dashboard route.
 * Bodies that carry key material are refused before any write.
 */
import { claudeSubscriptionAuth, codexSubscriptionAuth, AuthFlowError } from "@shiba/auth";
import {
  connectProvider,
  disconnectProvider,
  ProviderFlowError,
  readProviderSnapshot,
  setDefaultProvider,
  testProvider,
  verifyProvider,
  type OauthConfirm,
  type ProviderDefinition,
  type ProviderDeps,
} from "./acp-providers.js";
import type { Env } from "./env.js";
import { forwardClaudeSubscription, forwardCodexSubscription, type EgressEnv } from "./egress.js";
import { codexSubscriptionInstanceId } from "./harness/codex-subscription.js";
import { resolveUserId } from "./request-auth.js";
import { methodNotAllowed } from "./route-utils.js";
import { InputError } from "./security.js";
import type { SubscriptionForwarder } from "@shiba/auth";

const FORBIDDEN_BODY_KEYS = new Set([
  "apikey",
  "api_key",
  "token",
  "secret",
  "authorization",
  "password",
  "authjson",
  "refresh_token",
  "access_token",
]);

export interface ProviderRouteDeps extends ProviderDeps {
  forwardClaude?: SubscriptionForwarder;
  forwardCodex?: SubscriptionForwarder;
}

async function orgFor(request: Request, env: Env): Promise<string> {
  const id = await resolveUserId(request, env);
  return id !== null && id.trim() !== "" ? id.trim() : "default";
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === "") return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new InputError("Request body is not valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InputError("Request body must be a JSON object.");
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_BODY_KEYS.has(key.toLowerCase())) {
      throw new InputError("This API does not accept credential material. Provision a Worker secret or gateway token instead.");
    }
  }
  return record;
}

/**
 * Token step for the device flow. When the subscription lane is enabled,
 * this is the existing T47 controller (begin, then the capability probe).
 * Otherwise the code cannot be redeemed — the page says why.
 */
export async function confirmProviderOauth(
  env: Env,
  provider: ProviderDefinition,
  org: string,
  forwarders: { claude?: SubscriptionForwarder; codex?: SubscriptionForwarder } = {},
): Promise<{ ok: boolean; message: string }> {
  if (provider.subscription === "claude-subscription") {
    if (env.SHIBA_CLAUDE_SUBSCRIPTION !== "1") {
      return {
        ok: false,
        message: "Claude subscription sign-in is not enabled. Set SHIBA_CLAUDE_SUBSCRIPTION=1 and store CLAUDE_SUBSCRIPTION_TOKEN, or connect with the API credential.",
      };
    }
    const forward = forwarders.claude ?? ((request, e, ctx) => forwardClaudeSubscription(request, e as EgressEnv, ctx));
    const controller = claudeSubscriptionAuth(env, "claude-sub:default", forward);
    try {
      await controller.begin(org);
      const snapshot = await controller.verify(org);
      return { ok: snapshot.phase === "succeeded", message: snapshot.message ?? snapshot.phase };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Claude sign-in failed." };
    }
  }
  if (provider.subscription === "codex-subscription") {
    if (env.SHIBA_CODEX_SUBSCRIPTION !== "1") {
      return {
        ok: false,
        message: "Codex subscription sign-in is not enabled. Set SHIBA_CODEX_SUBSCRIPTION=1 and store CODEX_SUBSCRIPTION_AUTH_JSON, or connect with the API credential.",
      };
    }
    const forward = forwarders.codex ?? ((request, e, ctx) => forwardCodexSubscription(request, e as EgressEnv, ctx));
    const controller = codexSubscriptionAuth(env, codexSubscriptionInstanceId({ authAccount: "default" }), forward);
    try {
      await controller.begin(org);
      const snapshot = await controller.verify(org);
      return { ok: snapshot.phase === "succeeded", message: snapshot.message ?? snapshot.phase };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Codex sign-in failed." };
    }
  }
  return { ok: false, message: `${provider.label} has no subscription sign-in.` };
}

function jsonError(error: unknown): Response {
  if (error instanceof InputError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof ProviderFlowError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof AuthFlowError) {
    return Response.json(
      { error: error.message },
      { status: error.reason === "not_owner" ? 403 : 400 },
    );
  }
  const message = error instanceof Error ? error.message : "Provider request failed.";
  return Response.json({ error: message }, { status: 500 });
}

export async function handleAcpProviders(
  request: Request,
  env: Env,
  deps: ProviderRouteDeps = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/providers" && !url.pathname.startsWith("/api/providers/")) {
    return null;
  }
  const confirm: OauthConfirm = deps.confirmOauth ?? ((e, provider, org) =>
    confirmProviderOauth(e, provider, org, { claude: deps.forwardClaude, codex: deps.forwardCodex }));
  const flowDeps: ProviderDeps = { confirmOauth: confirm, ...(deps.now !== undefined ? { now: deps.now } : {}) };
  try {
    const org = await orgFor(request, env);
    if (url.pathname === "/api/providers") {
      if (request.method !== "GET") return methodNotAllowed();
      return Response.json(await readProviderSnapshot(env, org, flowDeps), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    const match = /^\/api\/providers\/([a-z0-9-]+)\/(connect|verify|test|disconnect|default)$/.exec(url.pathname);
    if (match === null) {
      return Response.json({ error: "Not found." }, { status: 404 });
    }
    if (request.method !== "POST") return methodNotAllowed();
    const id = match[1] as string;
    const action = match[2] as "connect" | "verify" | "test" | "disconnect" | "default";
    const body = await readBody(request);
    const snapshot =
      action === "connect"
        ? await connectProvider(env, org, id, body.mode, flowDeps)
        : action === "verify"
          ? await verifyProvider(env, org, id, body.userCode, flowDeps)
          : action === "test"
            ? await testProvider(env, org, id, flowDeps)
            : action === "disconnect"
              ? await disconnectProvider(env, org, id, flowDeps)
              : await setDefaultProvider(env, org, id, flowDeps);
    return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
