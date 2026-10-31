import { randomHex } from "./mailbox-store.js";
import type { Env } from "./env.js";
import { installLibrarySkill } from "./skill-library/install.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { resolveUserId } from "./request-auth.js";
import { methodNotAllowed } from "./route-utils.js";
import { requireV1Read, requireV1Write, v1Forbidden } from "./v1-auth.js";
import {
  deleteSpaceIndex,
  getSpaceIndex,
  insertSpaceIndex,
  listSpacesIndex,
  touchSpaceIndexUpdatedAt,
  updateSpaceIndexName,
} from "./spaces-index-store.js";
import { getSpaceTemplate, listSpaceTemplates } from "./spaces-templates.js";
import { spacesStub } from "./spaces-stub.js";
import type { SpaceSnapshot } from "./spaces-do.js";

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

async function spaceFetch(
  env: Env,
  orgId: string,
  spaceId: string,
  path: string,
  method: string,
  body?: unknown,
): Promise<Response> {
  return spacesStub(env, orgId, spaceId).fetch(
    new Request(`https://spaces/internal/${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  );
}

async function readSpaceSnapshot(env: Env, orgId: string, spaceId: string): Promise<SpaceSnapshot | null> {
  const response = await spaceFetch(env, orgId, spaceId, "snapshot", "GET");
  if (!response.ok) return null;
  const body = await response.json() as { space?: SpaceSnapshot };
  return body.space ?? null;
}

/** Keep the index available for retry if the Durable Object cannot be erased. */
async function destroySpace(env: Env, orgId: string, spaceId: string): Promise<boolean> {
  try {
    return (await spaceFetch(env, orgId, spaceId, "destroy", "POST")).ok;
  } catch {
    return false;
  }
}

async function applySpaceTemplate(
  env: Env,
  orgId: string,
  ownerId: string,
  spaceId: string,
  templateId: string,
): Promise<void> {
  const template = getSpaceTemplate(templateId);
  if (!template) return;
  for (const slug of template.skillSlugs) {
    const installed = await installLibrarySkill(env, orgId, ownerId, slug);
    const response = await spaceFetch(env, orgId, spaceId, "items", "POST", { kind: "skill", ref: installed.skillId });
    if (!response.ok) throw new Error("space_template_failed");
  }
  if (template.automationDraftRef) {
    const response = await spaceFetch(env, orgId, spaceId, "items", "POST", { kind: "automation", ref: template.automationDraftRef });
    if (!response.ok) throw new Error("space_template_failed");
  }
}

export async function handleSpaces(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/spaces")) return null;
  if (!env.AGENT_AUDIT || !env.Spaces) {
    return Response.json({ ok: false, error: "spaces_unavailable" }, { status: 503 });
  }

  const auth = await resolveOrgForApiRequest(request, env);
  if (auth instanceof Response) return auth;
  const ownerId = auth.principal?.principal ?? await resolveUserId(request, env);
  if (!ownerId) return Response.json({ ok: false, error: "authentication_required" }, { status: 401 });

  const isRead = request.method === "GET";
  if (auth.principal) {
    if (isRead ? !requireV1Read(auth.principal) : !requireV1Write(auth.principal)) return v1Forbidden();
  }

  if (url.pathname === "/api/spaces/templates" || url.pathname === "/api/spaces/templates/") {
    if (request.method !== "GET") return methodNotAllowed();
    return Response.json({ ok: true, templates: listSpaceTemplates() }, { headers: { "cache-control": "no-store" } });
  }

  if (url.pathname === "/api/spaces" || url.pathname === "/api/spaces/") {
    if (request.method === "GET") {
      const spaces = await listSpacesIndex(env, auth.orgId);
      return Response.json({ ok: true, spaces }, { headers: { "cache-control": "no-store" } });
    }
    if (request.method === "POST") {
      const body = await parseJson(request);
      const name = typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "Untitled space";
      const templateRaw = typeof body?.template === "string" ? body.template : "blank";
      const template = getSpaceTemplate(templateRaw);
      if (!template) return Response.json({ ok: false, error: "invalid_template" }, { status: 400 });
      const id = `space-${randomHex(12)}`;
      const now = Date.now();
      const displayName = name || "Untitled space";
      await insertSpaceIndex(env, {
        id,
        orgId: auth.orgId,
        name: displayName,
        template: template.id,
        createdBy: ownerId,
        createdAt: now,
        updatedAt: now,
      });
      const initResponse = await spaceFetch(env, auth.orgId, id, "init", "POST", {
        id,
        orgId: auth.orgId,
        name: displayName,
        template: template.id,
        createdBy: ownerId,
      });
      if (!initResponse.ok) {
        await deleteSpaceIndex(env, auth.orgId, id);
        return Response.json({ ok: false, error: "space_create_failed" }, { status: 502 });
      }
      try {
        await applySpaceTemplate(env, auth.orgId, ownerId, id, template.id);
        const space = await readSpaceSnapshot(env, auth.orgId, id);
        if (!space) throw new Error("space_template_failed");
        await touchSpaceIndexUpdatedAt(env, auth.orgId, id, space.updatedAt);
        return Response.json({ ok: true, space }, { status: 201, headers: { "cache-control": "no-store" } });
      } catch {
        if (!await destroySpace(env, auth.orgId, id)) {
          return Response.json({ ok: false, error: "space_create_cleanup_failed", id }, { status: 502 });
        }
        await deleteSpaceIndex(env, auth.orgId, id);
        return Response.json({ ok: false, error: "space_template_failed" }, { status: 502 });
      }
    }
    return methodNotAllowed();
  }

  const match = url.pathname.match(/^\/api\/spaces\/([^/]+)(?:\/(items))?\/?$/);
  if (!match) return Response.json({ ok: false, error: "not_found" }, { status: 404 });

  let spaceId: string;
  try {
    spaceId = decodeURIComponent(match[1]!);
  } catch {
    return Response.json({ ok: false, error: "invalid_space_id" }, { status: 400 });
  }
  if (!/^space-[a-f0-9]{24}$/.test(spaceId)) {
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const indexRow = await getSpaceIndex(env, auth.orgId, spaceId);
  if (!indexRow) return Response.json({ ok: false, error: "not_found" }, { status: 404 });

  const sub = match[2];
  if (sub === "items") {
    if (request.method === "POST") {
      const body = await parseJson(request);
      const kind = body?.kind;
      const ref = typeof body?.ref === "string" ? body.ref : "";
      if (kind !== "skill" && kind !== "repo" && kind !== "automation" && kind !== "run") {
        return Response.json({ ok: false, error: "invalid_item" }, { status: 400 });
      }
      const response = await spaceFetch(env, auth.orgId, spaceId, "items", "POST", { kind, ref });
      const payload: unknown = await response.json().catch(() => ({}));
      if (response.ok) {
        const item = typeof payload === "object" && payload !== null && "item" in payload ? payload.item : null;
        const addedAt = typeof item === "object" && item !== null && "addedAt" in item ? item.addedAt : undefined;
        await touchSpaceIndexUpdatedAt(
          env,
          auth.orgId,
          spaceId,
          typeof addedAt === "number" && Number.isFinite(addedAt) ? addedAt : Date.now(),
        );
      }
      return Response.json(payload, { status: response.status, headers: { "cache-control": "no-store" } });
    }
    if (request.method === "DELETE") {
      const body = await parseJson(request);
      const kind = body?.kind;
      const ref = typeof body?.ref === "string" ? body.ref : "";
      const response = await spaceFetch(env, auth.orgId, spaceId, "items", "DELETE", { kind, ref });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) await touchSpaceIndexUpdatedAt(env, auth.orgId, spaceId, Date.now());
      return Response.json(payload, { status: response.status, headers: { "cache-control": "no-store" } });
    }
    return methodNotAllowed();
  }

  if (request.method === "GET") {
    const space = await readSpaceSnapshot(env, auth.orgId, spaceId);
    return space
      ? Response.json({ ok: true, space }, { headers: { "cache-control": "no-store" } })
      : Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  if (request.method === "PATCH") {
    const body = await parseJson(request);
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";
    if (!name) return Response.json({ ok: false, error: "invalid_name" }, { status: 400 });
    const patchResponse = await spaceFetch(env, auth.orgId, spaceId, "patch", "POST", { name });
    if (!patchResponse.ok) {
      return Response.json({ ok: false, error: "update_failed" }, { status: 502 });
    }
    const updatedAt = Date.now();
    await updateSpaceIndexName(env, auth.orgId, spaceId, name, updatedAt);
    const space = await readSpaceSnapshot(env, auth.orgId, spaceId);
    return Response.json({ ok: true, space }, { headers: { "cache-control": "no-store" } });
  }

  if (request.method === "DELETE") {
    if (!await destroySpace(env, auth.orgId, spaceId)) {
      return Response.json({ ok: false, error: "space_destroy_failed" }, { status: 502 });
    }
    await deleteSpaceIndex(env, auth.orgId, spaceId);
    return Response.json({ ok: true, id: spaceId }, { headers: { "cache-control": "no-store" } });
  }

  return methodNotAllowed();
}
