/**
 * `GET /api/usage` — daily token/cost aggregates over the same orchestrator
 * DO run store `/api/runs` serves (or a session DO when `?session=` names
 * one). Mirrors handleRuns' auth and session scoping; the DO stays the only
 * run-writing surface, so aggregation reads its records Worker-side.
 * `USAGE_BUDGET_USD` supplies the optional daily budget line.
 */
import { getAgentByName } from "agents/routing";
import { AGENT_PRINCIPAL_HEADER, LOCAL_INTAKE_HEADER, usageBudgetPolicySchema } from "@shiba/shared";
import type { DelegatedRun, UsageBudgetPolicy } from "@shiba/shared";
import type { Env } from "./env.js";
import { getUserId, isAuthorizedRequest } from "./request-auth.js";
import { resolveBetterAuthUserId } from "./better-auth.js";
import { signInternalRequest } from "./edge-identity.js";
import { resolveRunStoreTarget } from "./runs-routes.js";
import { buildUsageReport, parseUsageDays } from "./usage.js";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "./dashboard-mutation.js";

export async function handleUsage(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const budgetRoute = url.pathname === "/api/usage/budget";
  if (url.pathname !== "/api/usage" && !budgetRoute) {
    return null;
  }
  if (!(await isAuthorizedRequest(request, env))) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  if (request.method !== "GET" && !(budgetRoute && request.method === "PUT")) {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  let policyInput: UsageBudgetPolicy | undefined;
  if (request.method === "PUT") {
    const rejected = rejectCrossOriginMutation(request) ?? rejectNonJsonMutation(request);
    if (rejected) return rejected;
    const parsed = usageBudgetPolicySchema.safeParse(await request.clone().json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Invalid budget policy." }, { status: 400 });
    policyInput = { ...parsed.data, updatedAt: Date.now(), updatedBy: await resolveBetterAuthUserId(request, env) ?? getUserId(request) ?? "local-dashboard" };
  }
  const resolved = await resolveRunStoreTarget(request, env, url);
  if ("error" in resolved) {
    return resolved.error;
  }
  const stub = await getAgentByName(env.CodingOrchestrator, resolved.agentName);
  const policyRequest = new Request(new URL("/api/usage/budget", request.url), {
    method: policyInput ? "PUT" : "GET", headers: request.headers,
    ...(policyInput ? { body: JSON.stringify(policyInput) } : {}),
  });
  policyRequest.headers.delete(AGENT_PRINCIPAL_HEADER);
  policyRequest.headers.delete(LOCAL_INTAKE_HEADER);
  policyRequest.headers.delete("content-length");
  await signInternalRequest(policyRequest, env);
  const policyResponse = await stub.fetch(policyRequest);
  if (!policyResponse.ok) return policyResponse;
  if (budgetRoute) return policyResponse;
  const { policy } = await policyResponse.json() as { policy?: UsageBudgetPolicy };
  // The DO answers /api/runs with the same scoping the dashboard list gets;
  // usage aggregates those records — the DO's write surface is untouched.
  const runsRequest = new Request(new URL("/api/runs", request.url), request);
  // Same strip as handleRuns: the clone carries the caller's headers into
  // the DO, where X-Agent-Principal (queuedBy + the /api/spine filter) and
  // X-Shiba-Intake (the local-runtime voucher) read as worker-vouched. This
  // lane forwards a read, never credentials — an inbound copy is a forgery.
  runsRequest.headers.delete(AGENT_PRINCIPAL_HEADER);
  runsRequest.headers.delete(LOCAL_INTAKE_HEADER);
  await signInternalRequest(runsRequest, env);
  const runsResponse = await stub.fetch(runsRequest);
  if (!runsResponse.ok) {
    return runsResponse;
  }
  const body = (await runsResponse.json()) as { runs?: DelegatedRun[] };
  const report = buildUsageReport(Array.isArray(body.runs) ? body.runs : [], env, {
    days: parseUsageDays(url.searchParams.get("days")),
    policy,
  });
  return Response.json(report);
}
