import {
  getFounderSkillLibraryEntry,
  listFounderSkillLibrary,
} from "@shiba/shared";
import type { Env } from "./env.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { resolveUserId } from "./request-auth.js";
import { requireV1Read, requireV1Write, v1Forbidden } from "./v1-auth.js";
import { methodNotAllowed } from "./route-utils.js";
import { createSkill } from "./skills-store.js";

const automationsPath = /^\/api\/founder-skills(?:\/([^/]+)(?:\/(install|deploy))?)?\/?$/;

export async function handleFounderSkills(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/founder-skills")) return null;
  const match = url.pathname.match(automationsPath);
  if (!match) return Response.json({ ok: false, error: "not_found" }, { status: 404 });

  const auth = await resolveOrgForApiRequest(request, env);
  if (auth instanceof Response) return auth;
  const isRead = request.method === "GET";
  if (auth.principal) {
    if (isRead ? !requireV1Read(auth.principal) : !requireV1Write(auth.principal)) return v1Forbidden();
  }
  const ownerId = auth.principal?.principal ?? await resolveUserId(request, env);
  if (!ownerId) return Response.json({ ok: false, error: "authentication_required" }, { status: 401 });

  const skillId = match[1] ? decodeURIComponent(match[1]) : null;
  const action = match[2];

  if (!skillId && request.method === "GET") {
    return Response.json({
      ok: true,
      skills: listFounderSkillLibrary().map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        author: entry.author,
        schedule: entry.schedule,
        integrationCatalogIds: entry.integrationCatalogIds,
        requiresSensitiveApproval: entry.requiresSensitiveApproval,
      })),
    }, { headers: { "cache-control": "public, max-age=300" } });
  }

  if (!skillId || !getFounderSkillLibraryEntry(skillId)) {
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  if (action === "install" && request.method === "POST") {
    if (!env.AGENT_AUDIT) return Response.json({ ok: false, error: "skill_storage_unavailable" }, { status: 503 });
    const entry = getFounderSkillLibraryEntry(skillId)!;
    const skill = await createSkill(env, auth.orgId, ownerId, {
      name: entry.name,
      instructions: entry.instructions,
      sourceUrl: entry.sourceUrl,
    });
    return Response.json({
      ok: true,
      skill: {
        id: skill.id,
        version: skill.version,
        status: skill.status,
        name: skill.content.name,
        libraryId: entry.id,
        note: "Review and activate the draft before pinning it on automations.",
      },
    }, { status: 201 });
  }

  if (action === "deploy" && request.method === "POST") {
    return Response.json({
      ok: false,
      error: "integration_schedule_configuration_required",
      message: "Install the draft, then configure reviewed employee integration grants and action approvals before scheduling connector work.",
    }, { status: 409 });
  }

  return methodNotAllowed();
}
