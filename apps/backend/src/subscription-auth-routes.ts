/**
 * Per-user ChatGPT subscription connect API (paste auth.json, status, disconnect).
 */
import type { Env } from "./env.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import {
  deleteUserSubscriptionCredential,
  readUserSubscriptionStatus,
  saveUserSubscriptionAuthJson,
  SubscriptionCredentialError,
} from "./subscription-credentials.js";

const BASE = "/api/subscription/openai";

export async function handleUserOpenAiSubscription(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(BASE)) return null;
  if (!(await isAuthorizedRequest(request, env))) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  const userId = (await resolveUserId(request, env)) ?? "default";
  const sub = url.pathname.slice(BASE.length).replace(/^\/+|\/+$/g, "");

  try {
    if (request.method === "GET" && sub === "") {
      const status = await readUserSubscriptionStatus(env, userId);
      return Response.json(status, { headers: { "Cache-Control": "no-store" } });
    }
    if (request.method === "POST" && sub === "paste") {
      const body = (await request.json().catch(() => null)) as { authJson?: unknown } | null;
      const authJson = typeof body?.authJson === "string" ? body.authJson : "";
      if (authJson.trim() === "") {
        return Response.json({ error: "authJson must be a non-empty string." }, { status: 400 });
      }
      const status = await saveUserSubscriptionAuthJson(env, userId, authJson.trim());
      return Response.json(status, { headers: { "Cache-Control": "no-store" } });
    }
    if (request.method === "DELETE" && sub === "") {
      await deleteUserSubscriptionCredential(env, userId);
      return Response.json({ connected: false }, { headers: { "Cache-Control": "no-store" } });
    }
  } catch (error) {
    if (error instanceof SubscriptionCredentialError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
  return Response.json({ error: "Not found." }, { status: 404 });
}
