import {
  getFounderSkillLibraryEntry,
  listFounderSkillLibrary,
} from "@shiba/shared";
import type { Env } from "./env.js";
import { resolveOrgForApiRequest, type ResolvedOrgAuth } from "./org-request-auth.js";
import { skillTeamGrant, withCurrentSkillAuthority } from "./team-skill-authority.js";
import { resolveUserId } from "./request-auth.js";
import { requireV1Read, requireV1Write, v1Forbidden } from "./v1-auth.js";
import { methodNotAllowed } from "./route-utils.js";
import { getSkill } from "./skills-store.js";
import { listSkillInstalls } from "./skill-library-store.js";
import { installSkillDefinition } from "./skill-library/install.js";
import { founderSkillSetup, FOUNDER_SKILL_LIBRARY_VERSION } from "./founder-skill-setup.js";
import { handleFounderReviewSchedule } from "./founder-review-routes.js";

const automationsPath = /^\/api\/founder-skills(?:\/([^/]+)(?:\/(install|deploy|setup))?)?\/?$/;

export async function handleFounderSkills(request: Request, env: Env): Promise<Response | null> {
  if (!new URL(request.url).pathname.startsWith("/api/founder-skills")) return null;
  const auth = await resolveOrgForApiRequest(request, env);
  if (auth instanceof Response) return auth;
  const reviewSchedule = await handleFounderReviewSchedule(request, env, auth);
  if (reviewSchedule) return reviewSchedule;
  return withCurrentSkillAuthority(request, env, auth, () => handleFounderRoutes(request, env, auth));
}

async function handleFounderRoutes(request: Request, env: Env, auth: ResolvedOrgAuth): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/founder-skills")) return null;
  const match = url.pathname.match(automationsPath);
  if (!match) return Response.json({ ok: false, error: "not_found" }, { status: 404 });

  const isRead = request.method === "GET";
  if (auth.principal) {
    if (isRead ? !requireV1Read(auth.principal) : !requireV1Write(auth.principal)) return v1Forbidden();
  }
  const ownerId = auth.workspace?.userId ?? auth.principal?.principal ?? await resolveUserId(request, env);
  if (!ownerId) return Response.json({ ok: false, error: "authentication_required" }, { status: 401 });

  let skillId: string | null;
  try { skillId = match[1] ? decodeURIComponent(match[1]) : null; }
  catch { return Response.json({ ok: false, error: "invalid_skill_id" }, { status: 400 }); }
  const action = match[2];

  if (!skillId && request.method === "GET") {
    const installs = env.AGENT_AUDIT ? await listSkillInstalls(env, auth.orgId, ownerId) : [];
    return Response.json({
      ok: true,
      skills: await Promise.all(listFounderSkillLibrary().map(async (entry) => {
        const install = installs.find((candidate) => candidate.librarySlug === entry.id);
        const skill = install && env.AGENT_AUDIT ? await getSkill(env, auth.orgId, ownerId, install.skillId) : null;
        const installed = Boolean(skill && skill.status !== "disabled");
        return {
          id: entry.id,
          name: entry.name,
          description: entry.description,
          author: entry.author,
          schedule: entry.schedule,
          integrationCatalogIds: entry.integrationCatalogIds,
          requiresSensitiveApproval: entry.requiresSensitiveApproval,
          installed,
          ...(installed && skill ? { installedSkillId: skill.id, installedStatus: skill.status, installedVersion: skill.version } : {}),
        };
      })),
    }, { headers: { "cache-control": "no-store" } });
  }

  if (!skillId || !getFounderSkillLibraryEntry(skillId)) {
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  if (action === "install" && request.method === "POST") {
    if (!env.AGENT_AUDIT) return Response.json({ ok: false, error: "skill_storage_unavailable" }, { status: 503 });
    const entry = getFounderSkillLibraryEntry(skillId)!;
    const result = await installSkillDefinition(env, auth.orgId, ownerId, {
      slug: entry.id,
      version: FOUNDER_SKILL_LIBRARY_VERSION,
      name: entry.name,
      instructions: entry.instructions,
      sourceUrl: entry.sourceUrl,
    }, { teamGrant: skillTeamGrant(auth) });
    const skill = await getSkill(env, auth.orgId, ownerId, result.skillId);
    if (!skill) return Response.json({ ok: false, error: "skill_install_conflict" }, { status: 409 });
    return Response.json({
      ok: true,
      skill: {
        id: result.skillId,
        version: skill.version,
        status: skill.status,
        name: entry.name,
        libraryId: entry.id,
        note: "Review and activate draft instructions before selecting them for work. Scheduling and app grants require separate configuration.",
      },
    }, { status: result.created ? 201 : 200, headers: { "cache-control": "no-store" } });
  }

  if (action === "setup" && request.method === "GET") {
    return Response.json({ ok: true, recipe: founderSkillSetup(getFounderSkillLibraryEntry(skillId)!) },
      { headers: { "cache-control": "no-store" } });
  }

  if (action === "deploy" && request.method === "POST") {
    return Response.json({
      ok: false,
      error: "scheduled_connector_execution_unavailable",
      message: "Scheduled connector execution requires an explicit account, funding and execution contract. You can separately configure private storage-only review drafts.",
      setupPath: `/api/founder-skills/${encodeURIComponent(skillId)}/setup`,
      setupState: "manual_review_required",
      reviewDraftPath: `/api/founder-skills/${encodeURIComponent(skillId)}/review-schedule`,
      executionUnavailableReason: "automation_provider_billing_and_connected_app_contract_unavailable",
    }, { status: 501, headers: { "cache-control": "no-store" } });
  }

  return methodNotAllowed();
}
