import { askUserAnswerSchema } from "@shiba/shared";
import type { Env } from "./env.js";
import { answerAskUser, AskUserError, getPendingAskUser } from "./ask-user-store.js";
import { publishWorkspaceEvent } from "./platform/workspace-events-do.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import { resolveRunStoreTarget } from "./runs-routes.js";

const json = (body: unknown, status = 200) =>
  Response.json(body, { headers: { "content-type": "application/json; charset=utf-8" }, status });

export async function handleAskUser(request: Request, env: Env): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  const pendingMatch = pathname.match(/^\/api\/runs\/([^/]+)\/ask-user\/pending$/);
  const answerMatch = pathname.match(/^\/api\/runs\/([^/]+)\/ask-user\/([^/]+)\/answer$/);
  if (!pendingMatch && !answerMatch) return null;
  if (!(await isAuthorizedRequest(request, env))) return json({ error: "Authentication required." }, 401);
  const url = new URL(request.url);
  const resolved = await resolveRunStoreTarget(request, env, url);
  if ("error" in resolved) return resolved.error;
  const ownerId = resolved.userId;
  const runId = decodeURIComponent((pendingMatch ?? answerMatch)![1]!);
  try {
    if (pendingMatch) {
      if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
      const pending = await getPendingAskUser(env, ownerId, runId);
      return json({ ok: true, pending });
    }
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
    if (request.headers.get("origin") !== url.origin) {
      return json({ error: "Same-origin request required." }, 403);
    }
    const askId = decodeURIComponent(answerMatch![2]!);
    const body = (await request.json().catch(() => null)) as { answer?: unknown } | null;
  if (!body?.answer) return json({ error: "Answer required." }, 400);
    const answer = askUserAnswerSchema.parse(body.answer);
    const { pending, receipt } = await answerAskUser(env, ownerId, runId, askId, answer);
    const workspaceId = request.headers.get("X-Shiba-Workspace") ?? "";
    if (workspaceId) {
      await publishWorkspaceEvent(env, workspaceId, { kind: "ask_user.answered", entityId: runId, payload: { askId } });
    }
    return json({ ok: true, pending, receipt });
  } catch (error) {
    if (error instanceof AskUserError) return json({ error: error.message }, error.status);
    return json({ error: "Ask-user is temporarily unavailable." }, 503);
  }
}