import type { Env } from "./env.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { resolveUserId } from "./request-auth.js";
import { requireV1Read, requireV1Write, v1Forbidden } from "./v1-auth.js";
import { methodNotAllowed } from "./route-utils.js";
import {
  activateSkill,
  createSkill,
  disableSkill,
  getSkill,
  listSkillVersions,
  listSkills,
  reviewSkill,
  type SkillRecord,
  updateSkill,
} from "./skills-store.js";

const MAX_NAME = 100;
const MAX_INSTRUCTIONS = 16_000;
const MAX_SOURCE_URL = 512;
const MAX_PAGE = 50;
const MAX_OFFSET = 10_000;

function publicSkill(skill: SkillRecord, ownerId: string) {
  return {
    id: skill.id,
    version: skill.version,
    status: skill.status,
    ...(skill.activeVersion !== undefined ? { activeVersion: skill.activeVersion } : {}),
    ...(skill.reviewedVersion !== undefined ? { reviewedVersion: skill.reviewedVersion } : {}),
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    owned: skill.ownerId === ownerId,
    name: skill.content.name,
    instructions: skill.content.instructions,
    ...(skill.content.sourceUrl ? { sourceUrl: skill.content.sourceUrl } : {}),
  };
}

function pageNumber(value: string | null, fallback: number, max: number): number | null {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : null;
}

async function parseJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseSkillContent(body: Record<string, unknown>): { name: string; instructions: string; sourceUrl?: string } | null {
  if (typeof body.name !== "string" || typeof body.instructions !== "string") return null;
  const name = body.name.trim();
  const instructions = body.instructions.trim();
  if (!name || name.length > MAX_NAME || instructions.length > MAX_INSTRUCTIONS) return null;
  let sourceUrl: string | undefined;
  if (body.sourceUrl !== undefined && body.sourceUrl !== null && body.sourceUrl !== "") {
    if (typeof body.sourceUrl !== "string" || body.sourceUrl.length > MAX_SOURCE_URL) return null;
    try {
      const url = new URL(body.sourceUrl);
      if (url.protocol !== "https:" || !url.hostname) return null;
      sourceUrl = url.toString();
    } catch {
      return null;
    }
  }
  return { name, instructions, ...(sourceUrl ? { sourceUrl } : {}) };
}

export async function handleSkills(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/skills")) return null;
  const match = url.pathname.match(/^\/api\/skills(?:\/([^/]+)(?:\/(versions|review|activate|disable))?)?\/?$/);
  if (!match) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  if (!env.AGENT_AUDIT) return Response.json({ ok: false, error: "skill_storage_unavailable" }, { status: 503 });

  const auth = await resolveOrgForApiRequest(request, env);
  if (auth instanceof Response) return auth;
  const isRead = request.method === "GET";
  if (auth.principal) {
    if (isRead ? !requireV1Read(auth.principal) : !requireV1Write(auth.principal)) return v1Forbidden();
  }
  const ownerId = auth.principal?.principal ?? await resolveUserId(request, env);
  if (!ownerId) return Response.json({ ok: false, error: "authentication_required" }, { status: 401 });

  let id: string | null = null;
  if (match[1]) {
    try { id = decodeURIComponent(match[1]); } catch { return Response.json({ ok: false, error: "invalid_skill_id" }, { status: 400 }); }
    if (!id || /[/\\]/.test(id) || id.length > 100) return Response.json({ ok: false, error: "invalid_skill_id" }, { status: 400 });
  }
  const subroute = match[2];

  if (!id && request.method === "GET") {
    const limit = pageNumber(url.searchParams.get("limit"), 25, MAX_PAGE);
    const offset = pageNumber(url.searchParams.get("cursor"), 0, MAX_OFFSET);
    if (limit === null || limit < 1 || offset === null) return Response.json({ ok: false, error: "invalid_page" }, { status: 400 });
    const page = await listSkills(env, auth.orgId, ownerId, { limit, offset });
    return Response.json({
      ok: true,
      skills: page.skills.map((skill) => publicSkill(skill, ownerId)),
      ...(page.nextOffset !== undefined ? { nextCursor: String(page.nextOffset) } : {}),
    }, { headers: { "cache-control": "no-store" } });
  }

  if (!id && request.method === "POST") {
    const body = await parseJson(request);
    const content = body && parseSkillContent(body);
    if (!content) return Response.json({ ok: false, error: "invalid_skill" }, { status: 400 });
    const skill = await createSkill(env, auth.orgId, ownerId, content);
    return Response.json({ ok: true, skill: publicSkill(skill, ownerId) }, { status: 201, headers: { "cache-control": "no-store" } });
  }

  if (!id) return methodNotAllowed();
  const existing = await getSkill(env, auth.orgId, ownerId, id, { includeSharedActive: true });
  if (!existing) return Response.json({ ok: false, error: "not_found" }, { status: 404 });

  if (subroute === "versions") {
    if (request.method !== "GET") return methodNotAllowed();
    const limit = pageNumber(url.searchParams.get("limit"), 20, MAX_PAGE);
    const offset = pageNumber(url.searchParams.get("cursor"), 0, MAX_OFFSET);
    if (limit === null || limit < 1 || offset === null) return Response.json({ ok: false, error: "invalid_page" }, { status: 400 });
    const page = await listSkillVersions(env, auth.orgId, id, limit, offset);
    const versions = existing.ownerId === ownerId
      ? page.versions
      : page.versions.filter((version) => version.version === existing.activeVersion);
    return Response.json({
      ok: true,
      versions: versions.map((version) => ({
        version: version.version,
        name: version.name,
        instructions: version.instructions,
        ...(version.sourceUrl ? { sourceUrl: version.sourceUrl } : {}),
        createdAt: version.createdAt,
      })),
      ...(existing.ownerId === ownerId && page.nextOffset !== undefined ? { nextCursor: String(page.nextOffset) } : {}),
    }, { headers: { "cache-control": "no-store" } });
  }

  if (!subroute && request.method === "GET") {
    return Response.json({ ok: true, skill: publicSkill(existing, ownerId) }, { headers: { "cache-control": "no-store" } });
  }
  if (existing.ownerId !== ownerId) return Response.json({ ok: false, error: "not_found" }, { status: 404 });

  if (!subroute && request.method === "PATCH") {
    const body = await parseJson(request);
    const content = body && parseSkillContent(body);
    const expectedVersion = body?.expectedVersion;
    if (!content || !Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1) {
      return Response.json({ ok: false, error: "invalid_skill" }, { status: 400 });
    }
    try {
      const skill = await updateSkill(env, auth.orgId, ownerId, id, Number(expectedVersion), content);
      return skill
        ? Response.json({ ok: true, skill: publicSkill(skill, ownerId) }, { headers: { "cache-control": "no-store" } })
        : Response.json({ ok: false, error: "not_found" }, { status: 404 });
    } catch (error) {
      if (error instanceof Error && error.message === "version_conflict") return Response.json({ ok: false, error: "version_conflict" }, { status: 409 });
      throw error;
    }
  }

  if (subroute === "review" || subroute === "activate") {
    if (request.method !== "POST") return methodNotAllowed();
    const body = await parseJson(request);
    const version = body?.version;
    const reviewedInstructions = body?.reviewedInstructions;
    if (!Number.isSafeInteger(version) || Number(version) < 1 || typeof reviewedInstructions !== "string" || reviewedInstructions.length > MAX_INSTRUCTIONS) {
      return Response.json({ ok: false, error: "invalid_review" }, { status: 400 });
    }
    try {
      const skill = subroute === "review"
        ? await reviewSkill(env, auth.orgId, ownerId, id, Number(version), reviewedInstructions)
        : await activateSkill(env, auth.orgId, ownerId, id, Number(version), reviewedInstructions);
      return skill
        ? Response.json({ ok: true, skill: publicSkill(skill, ownerId) }, { headers: { "cache-control": "no-store" } })
        : Response.json({ ok: false, error: "not_found" }, { status: 404 });
    } catch (error) {
      if (error instanceof Error && error.message === "review_mismatch") return Response.json({ ok: false, error: "review_mismatch" }, { status: 409 });
      if (error instanceof Error && error.message === "review_required") return Response.json({ ok: false, error: "review_required" }, { status: 409 });
      throw error;
    }
  }

  if (subroute === "disable" && request.method === "POST" || !subroute && request.method === "DELETE") {
    const skill = await disableSkill(env, auth.orgId, ownerId, id);
    return skill
      ? Response.json({ ok: true, skill: publicSkill(skill, ownerId) }, { headers: { "cache-control": "no-store" } })
      : Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  return methodNotAllowed();
}
