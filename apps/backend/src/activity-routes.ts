/**
 * `GET /api/activity` — workspace activity report over the same orchestrator
 * DO run store `/api/runs` serves (or a session DO when `?session=` names
 * one). Mirrors handleUsage's auth and session scoping; the DO stays the
 * only run-writing surface, so aggregation reads its records Worker-side.
 */
import { getAgentByName } from "agents/routing";
import { AGENT_PRINCIPAL_HEADER, LOCAL_INTAKE_HEADER } from "@shiba/shared";
import type { DelegatedRun } from "@shiba/shared";
import type { Env } from "./env.js";
import { isAuthorizedRequest } from "./request-auth.js";
import { resolveRunStoreTarget } from "./runs-routes.js";
import {
  buildActivityReport,
  parseActivityPeriod,
  parseActivityRuntime,
} from "./activity.js";

export async function handleActivity(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/activity") {
    return null;
  }
  if (!(await isAuthorizedRequest(request, env))) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  const now = Date.now();
  const period = parseActivityPeriod(url.searchParams, now);
  if ("error" in period) {
    return Response.json({ error: period.error }, { status: 400 });
  }
  const resolved = await resolveRunStoreTarget(request, env, url);
  if ("error" in resolved) {
    return resolved.error;
  }
  const stub = await getAgentByName(env.CodingOrchestrator, resolved.agentName);
  // Same strip as handleUsage: the forwarded read carries the caller's
  // headers into the DO, where X-Agent-Principal and X-Shiba-Intake read as
  // worker-vouched — an inbound copy is a forgery.
  const runsRequest = new Request(new URL("/api/runs", request.url), request);
  runsRequest.headers.delete(AGENT_PRINCIPAL_HEADER);
  runsRequest.headers.delete(LOCAL_INTAKE_HEADER);
  const runsResponse = await stub.fetch(runsRequest);
  if (!runsResponse.ok) {
    return runsResponse;
  }
  const body = (await runsResponse.json()) as { runs?: DelegatedRun[] };
  const report = buildActivityReport(Array.isArray(body.runs) ? body.runs : [], {
    period,
    now,
    runtime: parseActivityRuntime(url.searchParams.get("runtime")),
    project: url.searchParams.get("project"),
    member: url.searchParams.get("member"),
  });
  return Response.json(report);
}

