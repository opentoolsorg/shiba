import { founderReviewDecisionSchema, getFounderSkillLibraryEntry } from "@shiba/shared";
import { resolveBetterAuthSessionAccount } from "@shiba/auth/better-auth";
import type { Env } from "./env.js";
import { resolveOrgForApiRequest, type ResolvedOrgAuth } from "./org-request-auth.js";
import { resolveUserId } from "./request-auth.js";
import { skillTeamGrant } from "./team-skill-authority.js";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "./dashboard-mutation.js";
import { listCustomAgents } from "./custom-agents-store.js";
import { getSkillInstall } from "./skill-library-store.js";
import { getSkill } from "./skills-store.js";
import {
  decideFounderReviewSchedule, dismissFounderReviewOccurrence, FounderReviewError,
  prepareFounderReviewSchedule, readFounderReviewSchedule, isFounderReviewActorCurrent,
} from "./founder-review-schedules.js";
import { redactSecrets } from "./security.js";

const path = /^\/api\/founder-skills\/([^/]+)\/review-schedule(?:\/(options|enable|pause|resume|revoke|dismiss))?\/?$/;
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
async function boundedBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new FounderReviewError("invalid_json", 400);
  const bytes = new Uint8Array(4096);
  let used = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (used + chunk.value.byteLength > bytes.length) throw new FounderReviewError("review_schedule_too_large", 413);
      bytes.set(chunk.value, used); used += chunk.value.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)));
  } catch (error) {
    if (error instanceof FounderReviewError) throw error;
    throw new FounderReviewError("invalid_json", 400);
  } finally { await reader.cancel().catch(() => undefined); }
}

export async function handleFounderReviewSchedule(request: Request, env: Env, auth: ResolvedOrgAuth): Promise<Response | null> {
  const match = new URL(request.url).pathname.match(path);
  if (!match) return null;
  // Automation/API identities cannot configure, enable or decide their own work.
  if (auth.principal) return response({ error: "human_dashboard_identity_required" }, 403);
  const ownerId = auth.workspace?.userId ?? await resolveUserId(request, env);
  if (!ownerId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerId) || /^(?:agent|automation|system|mcp|child|subagent):/i.test(ownerId))
    return response({ error: "human_dashboard_identity_required" }, 403);
  if (auth.workspace?.role === "member") return response({ error: "workspace_manager_required" }, 403);
  if (!env.AGENT_AUDIT) return response({ error: "skill_storage_unavailable" }, 503);
  const native = await resolveBetterAuthSessionAccount(request, env, redactSecrets);
  if (!native?.emailVerified || native.policy.email !== ownerId) return response({ error: "native_founder_schedule_required",
    detail: "Private review schedules require a verified native account. Access-only identities cannot configure this scope." }, 403);
  let libraryId: string;
  try { libraryId = decodeURIComponent(match[1]!); } catch { return response({ error: "invalid_skill_id" }, 400); }
  if (!getFounderSkillLibraryEntry(libraryId)) return response({ error: "not_found" }, 404);
  const actor = { orgId: auth.orgId, ownerId, ownerAccountId: native.policy.accountId, teamGrant: skillTeamGrant(auth) };
  if (!await isFounderReviewActorCurrent(env, actor)) return response({ error: "founder_authority_changed" }, 403);
  const finish = async (produce: () => Promise<Response>) => {
    // Resolve session and exact scope again before the final guarded source reads.
    const latest = await resolveOrgForApiRequest(request, env);
    if (latest instanceof Response) return latest;
    const fresh = await resolveBetterAuthSessionAccount(request, env, redactSecrets);
    const oldTeam = auth.workspace, team = latest.workspace;
    if (latest.principal || latest.orgId !== auth.orgId || !fresh?.emailVerified || fresh.policy.accountId !== actor.ownerAccountId || fresh.policy.email !== actor.ownerId ||
      Boolean(oldTeam) !== Boolean(team) || (oldTeam && (!team || team.workspaceId !== oldTeam.workspaceId || team.userId !== oldTeam.userId || team.role !== oldTeam.role || team.version !== oldTeam.version)))
      return response({ error: "founder_authority_changed" }, 403);
    // Each producer ends in a D1 query containing the current native and team fence.
    // There is no subsequent authentication await that could return cached data.
    return produce();
  };
  const stateResponse = (status = 200) => finish(async () => response({ ok: true, mode: "review-draft", executionAvailable: false,
    executionUnavailableReason: "automation_provider_billing_and_connected_app_contract_unavailable",
    ...await readFounderReviewSchedule(env, actor, libraryId) }, status));
  const action = match[2];
  try {
    if (!action && request.method === "GET") return await stateResponse();
    if (action === "options" && request.method === "GET") return await finish(async () => {
      const install = await getSkillInstall(env, auth.orgId, ownerId, libraryId);
      const skill = install ? await getSkill(env, auth.orgId, ownerId, install.skillId) : null;
      const employees = await listCustomAgents(env, auth.orgId);
      // Re-read the exact skill after all awaited catalog work; no source body is returned.
      const latest = skill ? await getSkill(env, auth.orgId, ownerId, skill.id) : null;
      if (!await isFounderReviewActorCurrent(env, actor)) return response({ error: "founder_authority_changed" }, 403);
      return response({ ok: true, mode: "review-draft", provider: null, allowedTools: [], destination: "private-dashboard",
        employees: employees.map((employee) => ({ id: employee.id, version: employee.version, name: employee.config.name })),
        skill: latest?.status === "active" && latest.version === latest.activeVersion && latest.version === latest.reviewedVersion
          ? { id: latest.id, version: latest.version, name: latest.content.name } : null });
    });
    if (request.method !== "POST" || action === "options") return response({ error: "method_not_allowed" }, 405);
    const blocked = rejectCrossOriginMutation(request) ?? rejectNonJsonMutation(request);
    if (blocked) return blocked;
    const body = await boundedBody(request);
    if (!action) {
      await prepareFounderReviewSchedule(env, actor, libraryId, body);
      return await stateResponse(201);
    }
    const object = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const parsed = founderReviewDecisionSchema.safeParse(action === "dismiss" ? { expectedVersion: object.expectedVersion, digest: object.digest, reviewed: object.reviewed } : body);
    if (!parsed.success) return response({ error: "exact_review_decision_required" }, 400);
    if (action === "dismiss") {
      if (Object.keys(object).some((key) => !["expectedVersion", "digest", "reviewed", "occurrenceId"].includes(key)) ||
          typeof object.occurrenceId !== "string" || object.occurrenceId.length > 200) return response({ error: "invalid_occurrence" }, 400);
      await dismissFounderReviewOccurrence(env, actor, libraryId, object.occurrenceId, parsed.data);
    } else {
      await decideFounderReviewSchedule(env, actor, libraryId, action as "enable" | "pause" | "resume" | "revoke", parsed.data);
    }
    return await stateResponse();
  } catch (error) {
    if (error instanceof FounderReviewError) return response({ error: error.code }, error.status);
    throw error;
  }
}
