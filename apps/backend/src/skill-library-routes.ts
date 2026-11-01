import type { Env } from "./env.js";
import { listLibrarySkills } from "./skill-library/index.js";
import { installLibrarySkill, uninstallLibrarySkill } from "./skill-library/install.js";
import { listSkillInstalls } from "./skill-library-store.js";
import { getSkill } from "./skills-store.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { resolveUserId } from "./request-auth.js";
import { methodNotAllowed } from "./route-utils.js";
import { requireV1Read, requireV1Write, v1Forbidden } from "./v1-auth.js";

/** Curated skill library under `/api/skills/library/*` — must run before `handleSkills`. */
export async function handleSkillLibrary(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/skills/library")) return null;
  if (!env.AGENT_AUDIT) return Response.json({ ok: false, error: "skill_storage_unavailable" }, { status: 503 });

  const auth = await resolveOrgForApiRequest(request, env);
  if (auth instanceof Response) return auth;
  const ownerId = auth.principal?.principal ?? await resolveUserId(request, env);
  if (!ownerId) return Response.json({ ok: false, error: "authentication_required" }, { status: 401 });

  const isRead = request.method === "GET";
  if (auth.principal) {
    if (isRead ? !requireV1Read(auth.principal) : !requireV1Write(auth.principal)) return v1Forbidden();
  }

  const rest = url.pathname.replace(/^\/api\/skills\/library\/?/, "");
  if (rest === "" || rest === "/") {
    if (request.method !== "GET") return methodNotAllowed();
    const installs = await listSkillInstalls(env, auth.orgId, ownerId);
    const installBySlug = new Map(installs.map((row) => [row.librarySlug, row]));
    const skills = listLibrarySkills().map((entry) => {
      const install = installBySlug.get(entry.slug);
      const updateAvailable = install ? install.libraryVersion !== entry.version : false;
      return {
        slug: entry.slug,
        name: entry.name,
        summary: entry.summary,
        tags: entry.tags,
        version: entry.version,
        installed: install !== undefined,
        ...(install ? { installedSkillId: install.skillId } : {}),
        updateAvailable,
      };
    });
    return Response.json({ ok: true, skills }, { headers: { "cache-control": "no-store" } });
  }

  const installMatch = rest.match(/^([^/]+)\/install\/?$/);
  if (installMatch) {
    let slug: string;
    try {
      slug = decodeURIComponent(installMatch[1]!);
    } catch {
      return Response.json({ ok: false, error: "invalid_slug" }, { status: 400 });
    }
    if (request.method === "POST") {
      try {
        const result = await installLibrarySkill(env, auth.orgId, ownerId, slug);
        const skill = await getSkill(env, auth.orgId, ownerId, result.skillId);
        return Response.json(
          {
            ok: true,
            slug,
            skillId: result.skillId,
            status: result.status,
            skill: skill
              ? {
                  id: skill.id,
                  status: skill.status,
                  version: skill.version,
                  name: skill.content.name,
                }
              : undefined,
          },
          { status: result.created ? 201 : 200, headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        if (error instanceof Error && error.message === "unknown_slug") {
          return Response.json({ ok: false, error: "not_found" }, { status: 404 });
        }
        throw error;
      }
    }
    if (request.method === "DELETE") {
      const removed = await uninstallLibrarySkill(env, auth.orgId, ownerId, slug);
      return removed
        ? Response.json({ ok: true, slug, installed: false }, { headers: { "cache-control": "no-store" } })
        : Response.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    return methodNotAllowed();
  }

  return Response.json({ ok: false, error: "not_found" }, { status: 404 });
}
