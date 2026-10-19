import type { Env } from "./env.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { requireV1Read, requireV1Write, v1Forbidden } from "./v1-auth.js";
import {
  createCustomAgent,
  deleteCustomAgent,
  getCustomAgentById,
  listCustomAgents,
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
  };
}

export async function handleCustomAgents(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/custom-agents")) return null;
  if (!env.AGENT_AUDIT) {
    return Response.json({ ok: false, error: "AGENT_AUDIT D1 binding is not configured." }, { status: 503 });
  }
  const auth = await resolveOrgForApiRequest(request, env);
  if (auth instanceof Response) return auth;
  if (auth.principal) {
    if (request.method === "GET" && !requireV1Read(auth.principal)) return v1Forbidden();
    if (request.method !== "GET" && !requireV1Write(auth.principal)) return v1Forbidden();
  }

  const segments = url.pathname.slice("/api/custom-agents".length).split("/").filter(Boolean);
  const agentId = segments[0] ? decodeURIComponent(segments[0]) : null;

  if (!agentId && request.method === "GET") {
    const agents = await listCustomAgents(env, auth.orgId);
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
    const agent = await getCustomAgentById(env, auth.orgId, agentId);
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
