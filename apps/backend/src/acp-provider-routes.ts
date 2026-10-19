import type { SubscriptionForwarder } from "@shiba/auth";
import { AuthFlowError, claudeSubscriptionAuth, codexSubscriptionAuth } from "@shiba/auth";
import {
  connectProvider,
  disconnectProvider,
  type OauthConfirm,
  type ProviderDefinition,
  type ProviderDeps,
  ProviderFlowError,
  readProviderSnapshot,
  setDefaultProvider,
  testProvider,
  verifyProvider,
} from "./acp-providers.js";
import { type EgressEnv, forwardClaudeSubscription, forwardCodexSubscription } from "./egress.js";
import type { Env } from "./env.js";
import { codexSubscriptionInstanceId } from "./harness/codex-subscription.js";
import { resolveUserId } from "./request-auth.js";
import { methodNotAllowed } from "./route-utils.js";
import { InputError } from "./security.js";

const ALLOWED_BODY_KEYS = new Set(["mode", "usercode"]);

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
    if (!ALLOWED_BODY_KEYS.has(key.toLowerCase())) {
      throw new InputError(
        "This API does not accept credential material. Provision a Worker secret or gateway token instead.",
      );
    }
  }
  return record;
}

const QUIET_AUTH_PHASES = new Set(["idle", "cleared", "failed"]);

async function subscriptionController(
  env: Env,
  provider: ProviderDefinition,
  forwarders: { claude?: SubscriptionForwarder; codex?: SubscriptionForwarder },
) {
  if (provider.subscription === "claude-subscription") {
    if (env.SHIBA_CLAUDE_SUBSCRIPTION !== "1") {
      return {
        controller: null,
        message:
          "Claude subscription sign-in is not enabled. Set SHIBA_CLAUDE_SUBSCRIPTION=1 and store CLAUDE_SUBSCRIPTION_TOKEN, or connect with the API credential.",
      };
    }
    const forward =
      forwarders.claude ??
      ((request, e, ctx) => forwardClaudeSubscription(request, e as EgressEnv, ctx));
    return { controller: claudeSubscriptionAuth(env, "claude-sub:default", forward), message: "" };
  }
  if (provider.subscription === "codex-subscription") {
    if (env.SHIBA_CODEX_SUBSCRIPTION !== "1") {
      return {
        controller: null,
        message:
          "Codex subscription sign-in is not enabled. Set SHIBA_CODEX_SUBSCRIPTION=1 and store CODEX_SUBSCRIPTION_AUTH_JSON, or connect with the API credential.",
      };
    }
    const forward =
      forwarders.codex ??
      ((request, e, ctx) => forwardCodexSubscription(request, e as EgressEnv, ctx));
    return {
      controller: codexSubscriptionAuth(
        env,
        codexSubscriptionInstanceId({ authAccount: "default" }),
        forward,
      ),
      message: "",
    };
  }
  return { controller: null, message: `${provider.label} has no subscription sign-in.` };
}

export async function inspectProviderOauth(
  env: Env,
  provider: ProviderDefinition,
  _org: string,
  forwarders: { claude?: SubscriptionForwarder; codex?: SubscriptionForwarder } = {},
): Promise<{ ok: boolean; message: string }> {
  const lane = await subscriptionController(env, provider, forwarders);
  if (lane.controller === null) return { ok: false, message: lane.message };
  const current = await lane.controller.snapshot();
  if (current.phase === "succeeded") {
    return { ok: true, message: current.message ?? "Subscription lane is already authenticated." };
  }
  return {
    ok: false,
    message: `Subscription lane is ${current.phase}. Test does not start or restart sign-in.`,
  };
}

export async function confirmProviderOauth(
  env: Env,
  provider: ProviderDefinition,
  org: string,
  forwarders: { claude?: SubscriptionForwarder; codex?: SubscriptionForwarder } = {},
): Promise<{ ok: boolean; message: string }> {
  const lane = await subscriptionController(env, provider, forwarders);
  if (lane.controller === null) return { ok: false, message: lane.message };
  const current = await lane.controller.snapshot();
  if (current.phase === "succeeded") {
    return { ok: true, message: current.message ?? "Subscription lane is already authenticated." };
  }
  if (!QUIET_AUTH_PHASES.has(current.phase)) {
    return {
      ok: false,
      message: `Subscription sign-in is ${current.phase}. This page will not interrupt it.`,
    };
  }
  try {
    await lane.controller.begin(org);
    const snapshot = await lane.controller.verify(org);
    return { ok: snapshot.phase === "succeeded", message: snapshot.message ?? snapshot.phase };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Sign-in failed." };
  }
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
  const forwarders = { claude: deps.forwardClaude, codex: deps.forwardCodex };
  const confirm: OauthConfirm =
    deps.confirmOauth ?? ((e, provider, org) => confirmProviderOauth(e, provider, org, forwarders));
  const inspect: OauthConfirm =
    deps.inspectOauth ?? ((e, provider, org) => inspectProviderOauth(e, provider, org, forwarders));
  const flowDeps: ProviderDeps = {
    confirmOauth: confirm,
    inspectOauth: inspect,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };
  try {
    const org = await orgFor(request, env);
    if (url.pathname === "/api/providers") {
      if (request.method !== "GET") return methodNotAllowed();
      return Response.json(await readProviderSnapshot(env, org, flowDeps), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    const match = /^\/api\/providers\/([a-z0-9-]+)\/(connect|verify|test|disconnect|default)$/.exec(
      url.pathname,
    );
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
