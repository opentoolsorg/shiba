import type { Env } from "./env.js";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "./dashboard-mutation.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { requireV1Read, requireV1Write, v1Forbidden } from "./v1-auth.js";
import {
  createCustomAgent,
  deleteCustomAgent,
  getCustomAgentById,
  listCustomAgents,
  setCustomAgentArchived,
  updateCustomAgent,
} from "./custom-agents-store.js";
import { decodeCreateCustomAgent, decodeUpdateCustomAgent } from "./custom-agents-schema.js";
import { resolveHarness } from "./harness/index.js";

function publicAgent(record: Awaited<ReturnType<typeof listCustomAgents>>[number]) {
  return {
    id: record.id,
    orgId: record.orgId,
    slug: record.slug,
    version: record.version,
    config: record.config,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.archivedAt !== undefined ? { archivedAt: record.archivedAt } : {}),
  };
}

export async function handleCustomAgents(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/custom-agents")) return null;
  // Only explicit lifecycle suffixes are supported. An unknown suffix must
  // never turn DELETE /:id/unknown into deletion of the real agent.
  const route = url.pathname.match(/^\/api\/custom-agents(?:\/([^/]+)(?:\/(archive|restore))?)?\/?$/);
  if (!route) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  if (!env.AGENT_AUDIT) {
    return Response.json({ ok: false, error: "AGENT_AUDIT D1 binding is not configured." }, { status: 503 });
  }
  const auth = await resolveOrgForApiRequest(request, env);
  if (auth instanceof Response) return auth;
  if (auth.principal) {
    if (request.method === "GET" && !requireV1Read(auth.principal)) return v1Forbidden();
    if (request.method !== "GET" && !requireV1Write(auth.principal)) return v1Forbidden();
  }
  if (request.method !== "GET") {
    const originBlock = auth.principal ? null : rejectCrossOriginMutation(request);
    if (originBlock) return originBlock;
    if (request.method !== "DELETE") {
      const jsonBlock = rejectNonJsonMutation(request);
      if (jsonBlock) return jsonBlock;
    }
  }

  let agentId: string | null = null;
  if (route[1]) {
    try {
      agentId = decodeURIComponent(route[1]);
    } catch {
      return Response.json({ ok: false, error: "invalid_agent_id" }, { status: 400 });
    }
    if (/[/\\]/.test(agentId)) {
      return Response.json({ ok: false, error: "invalid_agent_id" }, { status: 400 });
    }
  }

  if (route[2]) {
    if (request.method !== "POST") return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
    if (!agentId) return Response.json({ ok: false, error: "invalid_agent_id" }, { status: 400 });
    try {
      const agent = await setCustomAgentArchived(env, auth.orgId, agentId, route[2] === "archive");
      return Response.json({ ok: true, agent: publicAgent(agent) }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof Error && error.message === "Agent not found.") {
        return Response.json({ ok: false, error: "not_found" }, { status: 404 });
      }
      throw error;
    }
  }

  if (!agentId && request.method === "GET") {
    const archived = url.searchParams.get("archived");
    if (archived !== null && archived !== "true" && archived !== "false") {
      return Response.json({ ok: false, error: "invalid_archived_filter" }, { status: 400 });
    }
    const agents = archived === "true"
      ? await listCustomAgents(env, auth.orgId, { archived: true })
      : await listCustomAgents(env, auth.orgId);
    return Response.json({ ok: true, agents: agents.map(publicAgent) }, { headers: { "cache-control": "no-store" } });
  }

  if (!agentId && request.method === "POST") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
    }
    const parsed = decodeCreateCustomAgent(body);
    if (!parsed) return Response.json({ ok: false, error: "invalid_body" }, { status: 400 });
    if (parsed.config.toolScopes?.length) {
      return Response.json({ ok: false, error: "unsupported_tool_scopes", detail: "Custom tool scopes are not enforced yet. Use the deployment tool policy." }, { status: 400 });
    }
    try {
      resolveHarness(parsed.config.harness, env);
    } catch (error) {
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : "Unknown harness." },
        { status: 400 },
      );
    }
    try {
      const created = await createCustomAgent(env, auth.orgId, parsed.slug, parsed.config);
      return Response.json({ ok: true, agent: publicAgent(created) }, { status: 201 });
    } catch (error) {
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : "create_failed" },
        { status: 400 },
      );
    }
  }

  if (agentId && request.method === "GET") {
    const agent = await getCustomAgentById(env, auth.orgId, agentId, { includeArchived: true });
    if (!agent) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    return Response.json({ ok: true, agent: publicAgent(agent) });
  }

  if (agentId && request.method === "PATCH") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
    }
    const parsed = decodeUpdateCustomAgent(body);
    if (!parsed) return Response.json({ ok: false, error: "invalid_body" }, { status: 400 });
    if (parsed.config.toolScopes?.length) {
      return Response.json({ ok: false, error: "unsupported_tool_scopes", detail: "Custom tool scopes are not enforced yet. Clear legacy scopes explicitly before saving; existing stored configuration was not changed." }, { status: 400 });
    }
    try {
      resolveHarness(parsed.config.harness, env);
    } catch (error) {
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : "Unknown harness." },
        { status: 400 },
      );
    }
    try {
      const updated = await updateCustomAgent(
        env,
        auth.orgId,
        agentId,
        parsed.config,
        parsed.expectedVersion,
      );
      return Response.json({ ok: true, agent: publicAgent(updated) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "update_failed";
      const status = message.includes("Version conflict")
        ? 409
        : message.toLowerCase().includes("not found")
          ? 404
          : 400;
      return Response.json({ ok: false, error: message }, { status });
    }
  }

  if (agentId && request.method === "DELETE") {
    try {
      await deleteCustomAgent(env, auth.orgId, agentId);
      return Response.json({ ok: true });
    } catch {
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    }
  }

  return Response.json({ error: "Method not allowed." }, { status: 405 });
}
