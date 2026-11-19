import type { Env } from "./env.js";
import { updateExtensionSkill } from "./extension-skills-store.js";
import { type ResolvedOrgAuth, resolveOrgForApiRequest } from "./org-request-auth.js";
import { dismissLearningCheckIn, listLearningCheckIns } from "./ports/learning/check-ins.js";
import { d1LearningPort } from "./ports/learning/d1-adapter.js";
import { LEARNING_TURN_OPTIONS, parseLearningTurnSetting } from "./ports/learning/index.js";
import {
  requireJsonContentType,
  requireSameOriginBrowserMutation,
  resolveUserId,
} from "./request-auth.js";
import { requireV1Read, requireV1Write, v1Forbidden } from "./v1-auth.js";

const noStore = { "cache-control": "no-store" };

function canManageLearning(auth: ResolvedOrgAuth): boolean {
  if (auth.workspace) return auth.workspace.role !== "member";
  if (auth.principal) return auth.principal.scopes.includes("api:keys:admin");
  return true;
}

export async function handleLearning(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(
    /^\/api\/learning\/(settings|suggestions|check-ins)(?:\/([^/]+)\/(apply|dismiss))?\/?$/,
  );
  if (!match)
    return url.pathname.startsWith("/api/learning")
      ? Response.json({ error: "not_found" }, { status: 404 })
      : null;
  const isRead = request.method === "GET";
  const checkIns = match[1] === "check-ins";
  if (checkIns && request.headers.has("authorization"))
    return Response.json({ error: "authentication_required" }, { status: 401 });
  if (!isRead) {
    const csrf = requireSameOriginBrowserMutation(request);
    if (csrf) return csrf;
  }
  const auth = await resolveOrgForApiRequest(request, env, {
    allowMemberWrite: match[1] === "suggestions" || checkIns,
  });
  if (auth instanceof Response) return auth;
  if (auth.principal && (isRead ? !requireV1Read(auth.principal) : !requireV1Write(auth.principal)))
    return v1Forbidden();
  if (!env.AGENT_AUDIT)
    return Response.json({ error: "learning_storage_unavailable" }, { status: 503 });
  const port = d1LearningPort(env.AGENT_AUDIT);
  const workspaceId = auth.orgId;

  if (match[1] === "settings") {
    if (isRead) {
      return Response.json(
        {
          turns: await port.getSetting(workspaceId),
          options: LEARNING_TURN_OPTIONS,
          usage: await port.usageByEmployee(workspaceId),
        },
        { headers: noStore },
      );
    }
    if (request.method !== "PUT")
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    if (!canManageLearning(auth))
      return Response.json({ error: "admin_required" }, { status: 403 });
    const contentType = requireJsonContentType(request);
    if (contentType) return contentType;
    const body = (await request.json().catch(() => null)) as { turns?: unknown } | null;
    const turns = parseLearningTurnSetting(body?.turns);
    if (turns === null) return Response.json({ error: "invalid_turns" }, { status: 400 });
    await port.setSetting(workspaceId, turns, Date.now());
    return Response.json({ turns }, { headers: noStore });
  }

  const ownerId =
    auth.workspace?.userId ?? auth.principal?.principal ?? (await resolveUserId(request, env));
  if (!ownerId) return Response.json({ error: "authentication_required" }, { status: 401 });
  if (checkIns) {
    if (isRead && !match[2]) {
      return Response.json(
        { checkIns: await listLearningCheckIns(env.AGENT_AUDIT, workspaceId, ownerId) },
        { headers: noStore },
      );
    }
    if (request.method !== "POST" || match[3] !== "dismiss" || !match[2])
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    const dismissed = await dismissLearningCheckIn(env.AGENT_AUDIT, workspaceId, ownerId, match[2]);
    return dismissed
      ? Response.json({ status: "dismissed" }, { headers: noStore })
      : Response.json({ error: "not_found" }, { status: 404 });
  }
  if (!match[2]) {
    if (!isRead) return Response.json({ error: "method_not_allowed" }, { status: 405 });
    return Response.json(
      { suggestions: await port.listSuggestions(workspaceId, ownerId) },
      { headers: noStore },
    );
  }
  if (request.method !== "POST")
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  let id: string;
  try {
    id = decodeURIComponent(match[2]);
  } catch {
    return Response.json({ error: "invalid_id" }, { status: 400 });
  }
  const suggestion = await port.getSuggestion(id, ownerId);
  if (!suggestion || suggestion.workspaceId !== workspaceId || suggestion.status !== "pending") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (match[3] === "dismiss") {
    await port.resolveSuggestion(id, ownerId, "dismissed");
    return Response.json({ status: "dismissed" });
  }
  const result = await updateExtensionSkill(
    env,
    auth.orgId,
    ownerId,
    suggestion.skillId,
    {
      description: suggestion.description,
      instructions: suggestion.instructions,
    },
    Date.now(),
    { expectedVersion: suggestion.skillVersion },
  );
  if (result !== "updated") {
    return Response.json(
      { error: result === "conflict" ? "skill_changed" : result },
      { status: result === "conflict" ? 409 : result === "forbidden" ? 403 : 404 },
    );
  }
  await port.resolveSuggestion(id, ownerId, "applied");
  return Response.json({ status: "applied" });
}
