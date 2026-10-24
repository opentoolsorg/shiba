import { AuthFlowError } from "@shiba/auth";
import type { SubscriptionForwarder } from "@shiba/auth";
import {
  connectProvider,
  disconnectProvider,
  type ProviderDeps,
  ProviderFlowError,
  readProviderSnapshot,
  setDefaultProvider,
  testProvider,
  verifyProvider,
} from "./acp-providers.js";
import type { Env } from "./env.js";
import {
  beginProviderSignIn,
  completeProviderSignIn,
  inspectProviderSignIn,
  type SignInLanes,
} from "./provider-sign-in.js";
import { resolveUserId } from "./request-auth.js";
import { methodNotAllowed } from "./route-utils.js";
import { InputError } from "./security.js";

const ALLOWED_BODY_KEYS = new Set(["mode", "usercode", "callbackurl", "credential"]);

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
  const lanes: SignInLanes = { forwardClaude: deps.forwardClaude };
  const origin = url.origin;
  const flowDeps: ProviderDeps = {
    origin,
    beginOauth:
      deps.beginOauth ??
      ((e, provider, org, ctx) => beginProviderSignIn(e, provider, org, ctx, lanes)),
    completeOauth:
      deps.completeOauth ??
      ((e, provider, org, callbackUrl, credential) =>
        completeProviderSignIn(e, provider, org, callbackUrl, credential)),
    inspectOauth:
      deps.inspectOauth ??
      ((e, provider, org) => inspectProviderSignIn(e, provider, org, lanes)),
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
    const credential = typeof body.credential === "string" ? body.credential : undefined;
    const requestDeps: ProviderDeps = credential !== undefined ? { ...flowDeps, credential } : flowDeps;
    const snapshot =
      action === "connect"
        ? await connectProvider(env, org, id, body.mode, requestDeps)
        : action === "verify"
          ? await verifyProvider(env, org, id, body.callbackUrl, requestDeps)
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
