/**
 * Per-user ChatGPT SIWC connect API (Sign in with ChatGPT — paste callback URL).
 */
import type { Env } from "./env.js";
import { chatGptAuthStub } from "./chatgpt-auth-do.js";
import { isAuthorizedRequest, rejectCrossSiteDashboardMutation, resolveUserId } from "./request-auth.js";
import { deleteUserSubscriptionCredential } from "./subscription-credentials.js";
import {
  clearUserOpenAiAuthMode,
  deviceAuthVolumeHint,
  readUserOpenAiAuthMode,
  setUserOpenAiAuthMode,
} from "./subscription-device-auth.js";
import { codexDeviceAuthDeploymentEnabled } from "./harness/codex-device-auth.js";

const BASE = "/api/subscription/openai";

async function forwardJson(stub: DurableObjectStub, path: string, init?: RequestInit): Promise<Response> {
  return stub.fetch(`https://chatgpt-auth.internal${path}`, init);
}

export async function handleUserOpenAiSubscription(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(BASE)) return null;
  if (!(await isAuthorizedRequest(request, env))) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  const csrf = rejectCrossSiteDashboardMutation(request);
  if (csrf) return csrf;
  const userId = (await resolveUserId(request, env)) ?? "default";
  if (!env.ChatGptAuth) {
    return Response.json({ error: "ChatGPT auth is not configured on this deployment." }, { status: 503 });
  }
  const stub = chatGptAuthStub(env, userId);
  const sub = url.pathname.slice(BASE.length).replace(/^\/+|\/+$/g, "");

  if (request.method === "GET" && sub === "") {
    return forwardJson(stub, "/status");
  }
  if (request.method === "POST" && sub === "begin") {
    return forwardJson(stub, "/begin", { method: "POST" });
  }
  if (request.method === "POST" && sub === "complete") {
    const body = await request.text();
    return forwardJson(stub, "/complete", { method: "POST", body, headers: { "content-type": "application/json" } });
  }
  if (request.method === "POST" && sub === "paste") {
    return Response.json(
      {
        error:
          "Pasting auth.json is deprecated. Use Sign in with ChatGPT (POST /api/subscription/openai/begin) or device-auth in your sandbox.",
      },
      { status: 410 },
    );
  }
  if (request.method === "DELETE" && sub === "") {
    const response = await forwardJson(stub, "/logout", { method: "DELETE" });
    await deleteUserSubscriptionCredential(env, userId).catch(() => undefined);
    await clearUserOpenAiAuthMode(env, userId).catch(() => undefined);
    return response;
  }
  if (sub === "device-auth") {
    if (!codexDeviceAuthDeploymentEnabled(env)) {
      return Response.json({ error: "Codex device-auth fallback is not enabled on this deployment." }, { status: 404 });
    }
    if (request.method === "GET") {
      const mode = (await readUserOpenAiAuthMode(env, userId)) ?? "siwc";
      return Response.json({
        mode,
        volumePath: deviceAuthVolumeHint(userId),
        loginCommand: "codex login --device-auth",
      });
    }
    if (request.method === "POST") {
      await setUserOpenAiAuthMode(env, userId, "device-auth");
      await forwardJson(stub, "/logout", { method: "DELETE" }).catch(() => undefined);
      await deleteUserSubscriptionCredential(env, userId).catch(() => undefined);
      return Response.json({
        mode: "device-auth",
        volumePath: deviceAuthVolumeHint(userId),
        loginCommand: "codex login --device-auth",
        message: "Device-auth mode enabled. Run codex login --device-auth in your sandbox; auth.json stays on your volume only.",
      });
    }
    if (request.method === "DELETE") {
      await clearUserOpenAiAuthMode(env, userId);
      return Response.json({ mode: "siwc", connected: false });
    }
  }
  return Response.json({ error: "Not found." }, { status: 404 });
}
