import type { ExtensionSkillRecord, ExtensionSkillScope, ExtensionSkillView } from "@shiba/shared";
import type { V1Context } from "./context.js";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "../dashboard-mutation.js";
import {
  archiveExtensionSkill,
  createExtensionSkill,
  getExtensionSkill,
  getExtensionSkillInstructions,
  listExtensionSkillDirectory,
  listExtensionSkills,
  removeExtensionSkill,
  restoreExtensionSkill,
  setExtensionSkillScope,
  updateExtensionSkill,
} from "../extension-skills-store.js";

const BASE = "/api/v1/extensions/skills";
const scopes = ["personal", "workspace"] as const;
const views = ["personal", "workspace", "archived"] as const;

function withPermissions(skill: ExtensionSkillRecord, userId: string, canManageWorkspace: boolean): ExtensionSkillRecord {
  const archived = skill.archivedAt !== undefined;
  const scope = archived ? skill.archivedFromScope ?? skill.scope ?? "personal" : skill.scope ?? "personal";
  const canEdit = skill.userId === userId || (canManageWorkspace && scope === "workspace");
  return {
    ...skill,
    permissions: {
      canEdit,
      canMove: skill.userId === userId && !archived,
      canArchive: canEdit && !archived,
      canRestore: canEdit && archived,
      canDelete: canEdit,
    },
  };
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

function scopeFailure(result: { ok: false; reason: string }): Response {
  const status = result.reason === "not_found" ? 404 : result.reason === "forbidden" ? 403 : 409;
  return Response.json({ ok: false, error: result.reason }, { status });
}

function decodeSkillId(raw: string): string | null {
  try {
    const id = decodeURIComponent(raw);
    return id && id.length <= 160 && !/[\\/]/.test(id) && !id.includes("\0") ? id : null;
  } catch {
    return null;
  }
}

/** Session/API-key-authenticated `/api/v1/extensions/skills` routes. */
export async function handleExtensionSkills(ctx: V1Context): Promise<Response | null> {
  const { request, url, env, principal } = ctx;
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) return null;
  if (!env.AGENT_AUDIT) return Response.json({ error: "skill_storage_unavailable" }, { status: 503 });

  if (request.method !== "GET" && request.method !== "HEAD") {
    if (!principal.apiKey) {
      const originBlock = rejectCrossOriginMutation(request);
      if (originBlock) return originBlock;
    }
    const bodyBearing = (pathname === BASE && request.method === "POST")
      || request.method === "PATCH"
      || (pathname.endsWith("/scope") && request.method === "POST");
    if (bodyBearing) {
      const jsonBlock = rejectNonJsonMutation(request);
      if (jsonBlock) return jsonBlock;
    }
  }

  const userId = principal.principal;
  // Shiba's existing org API grants distinguish org managers via the
  // api:keys:admin scope. Dashboard sessions retain their existing full scope.
  const canManageWorkspace = principal.scopes.includes("api:keys:admin");
  // Shiba's authenticated org is the current workspace boundary. Callers cannot
  // select a different workspace through query/body input.
  const workspaceId = principal.orgId;

  if (pathname === BASE) {
    if (request.method === "GET") {
      const rawView = url.searchParams.get("view");
      const view = views.includes(rawView as ExtensionSkillView) ? rawView as ExtensionSkillView : undefined;
      const skills = await listExtensionSkills(env, principal.orgId, userId, { workspaceId, view });
      return Response.json(skills.map((skill) => withPermissions(skill, userId, canManageWorkspace)), { headers: { "cache-control": "no-store" } });
    }
    if (request.method === "POST") {
      const body = await jsonBody(request);
      if (!body || typeof body.name !== "string" || typeof body.description !== "string" || typeof body.instructions !== "string") {
        return badRequest("name, description, and instructions are required");
      }
      const scope = scopes.includes(body.scope as ExtensionSkillScope) ? body.scope as ExtensionSkillScope : undefined;
      const id = await createExtensionSkill(env, principal.orgId, userId, {
        name: body.name,
        description: body.description,
        instructions: body.instructions,
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        workspaceId,
        ...(scope ? { scope } : {}),
      });
      return Response.json({ id }, { status: 201, headers: { "cache-control": "no-store" } });
    }
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }

  if (pathname === `${BASE}/directory`) {
    if (request.method !== "GET") return Response.json({ error: "Method not allowed." }, { status: 405 });
    const directory = await listExtensionSkillDirectory(env, principal.orgId, userId, {
      workspaceId,
      workspaceOnly: url.searchParams.get("workspaceOnly") === "true",
    });
    return Response.json(directory, { headers: { "cache-control": "no-store" } });
  }

  const match = pathname.match(/^\/api\/v1\/extensions\/skills\/([^/]+)(?:\/(instructions|scope|archive|restore))?$/);
  if (!match) return Response.json({ error: "Not found." }, { status: 404 });
  const id = decodeSkillId(match[1]!);
  if (!id) return badRequest("Invalid skill id.");
  const action = match[2];

  if (action === "instructions") {
    if (request.method !== "GET") return Response.json({ error: "Method not allowed." }, { status: 405 });
    const skill = await getExtensionSkillInstructions(env, principal.orgId, userId, id);
    return Response.json(skill, { headers: { "cache-control": "no-store" } });
  }

  if (action === "scope") {
    if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
    const body = await jsonBody(request);
    if (!body || !scopes.includes(body.to as ExtensionSkillScope)) return badRequest("to must be personal or workspace");
    const result = await setExtensionSkillScope(env, principal.orgId, userId, id, body.to as ExtensionSkillScope);
    return result.ok ? Response.json({ ok: true }) : scopeFailure(result);
  }

  if (action === "archive" || action === "restore") {
    if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
    const result = action === "archive"
      ? await archiveExtensionSkill(env, principal.orgId, userId, id, Date.now(), { canManageWorkspace })
      : await restoreExtensionSkill(env, principal.orgId, userId, id, { canManageWorkspace });
    return result.ok ? Response.json({ ok: true }) : scopeFailure(result);
  }

  if (request.method === "GET") {
    const skill = await getExtensionSkill(env, principal.orgId, userId, id, { workspaceId });
    return skill ? Response.json(withPermissions(skill, userId, canManageWorkspace), { headers: { "cache-control": "no-store" } }) : Response.json(null, { status: 404 });
  }
  if (request.method === "PATCH") {
    const body = await jsonBody(request);
    if (!body) return badRequest("Invalid request body.");
    const updates: { name?: string; description?: string; instructions?: string; enabled?: boolean } = {};
    for (const key of ["name", "description", "instructions"] as const) {
      if (body[key] !== undefined) {
        if (typeof body[key] !== "string") return badRequest(`${key} must be a string`);
        updates[key] = body[key] as string;
      }
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") return badRequest("enabled must be a boolean");
      updates.enabled = body.enabled;
    }
    const result = await updateExtensionSkill(env, principal.orgId, userId, id, updates, Date.now(), { canManageWorkspace });
    if (result === "not_found") return Response.json({ error: "Not found." }, { status: 404 });
    if (result === "forbidden") return Response.json({ error: "Unauthorized." }, { status: 403 });
    return Response.json({ success: true });
  }
  if (request.method === "DELETE") {
    const result = await removeExtensionSkill(env, principal.orgId, userId, id, { canManageWorkspace });
    if (result === "not_found") return Response.json({ error: "Not found." }, { status: 404 });
    if (result === "forbidden") return Response.json({ error: "Unauthorized." }, { status: 403 });
    return Response.json({ success: true });
  }
  return Response.json({ error: "Method not allowed." }, { status: 405 });
}
