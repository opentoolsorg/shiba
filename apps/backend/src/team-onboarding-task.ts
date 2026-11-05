import { resolveBetterAuthSessionAccount } from "@shiba/auth/better-auth";
import { draftTaskReferenceSchema, onboardingTaskText, teamOnboardingTaskSchema } from "@shiba/shared";
import { z } from "zod";
import { getCustomAgentById } from "./custom-agents-store.js";
import type { Env } from "./env.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { redactSecrets } from "./security.js";
import { teamMembershipWriteGuard } from "./team-skill-grant.js";

const PATH = "/api/onboarding/progress/team-task";
const SQL_NOW = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const SESSION_EXPIRY = "CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt ELSE CAST((julianday(s.expiresAt)-2440587.5)*86400000 AS INTEGER) END";
const querySchema = draftTaskReferenceSchema.extend({ expectedRevision: z.number().int().nonnegative().safe() });
const storedSchema = z.object({
  schemaVersion: z.literal(2), version: z.number().int().positive().safe(),
  goal: z.string().trim().min(1).max(4000), audience: z.string().trim().min(1).max(4000), acceptance: z.string().trim().min(1).max(4000),
  contextAnswer: z.string().max(4000), sourceIds: z.array(z.never()).length(0), sourceRefs: z.array(z.never()).length(0),
  preparedAt: z.null(), employeeId: z.string().min(1).max(128).nullable(), employeeVersion: z.number().int().positive().safe().nullable(),
}).refine((draft) => (draft.employeeId === null) === (draft.employeeVersion === null));
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: {
  "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", Vary: "Cookie, X-Shiba-Workspace",
} });
const unavailable = () => json({ error: "Saved team task is unavailable or changed. Save and review the current draft again." }, 409);

/** Native, owned, revision-bound read. It neither publishes a room message nor creates approval/run authority. */
export async function handleTeamOnboardingTask(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PATH) return null;
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
  if (!request.headers.has("cookie") || request.headers.has("authorization") || !request.headers.has("X-Shiba-Workspace")) return json({ error: "Use your native account in the selected team workspace." }, 403);
  const keys = ["draftTaskId", "draftTaskVersion", "expectedRevision"];
  if ([...url.searchParams.keys()].some((key) => !keys.includes(key)) || keys.some((key) => url.searchParams.getAll(key).length !== 1) ||
    !/^\d+$/.test(url.searchParams.get("draftTaskVersion") ?? "") || !/^\d+$/.test(url.searchParams.get("expectedRevision") ?? "")) return json({ error: "Invalid saved task reference." }, 400);
  const parsed = querySchema.safeParse({ draftTaskId: url.searchParams.get("draftTaskId"), draftTaskVersion: Number(url.searchParams.get("draftTaskVersion")), expectedRevision: Number(url.searchParams.get("expectedRevision")) });
  if (!parsed.success) return json({ error: "Invalid saved task reference." }, 400);
  try {
    request.signal.throwIfAborted();
    const auth = await resolveOrgForApiRequest(request, env, { allowMemberWrite: true });
    if (auth instanceof Response) return auth;
    const member = auth.workspace;
    if (!member || auth.principal || auth.orgId !== `team:${member.workspaceId}`) return json({ error: "Team workspace required." }, 403);
    const account = await resolveBetterAuthSessionAccount(request, env, redactSecrets);
    if (!account?.emailVerified || !account.sessionId || !account.sessionExpiresAt || account.sessionExpiresAt <= Date.now() || account.policy.email !== member.userId) return json({ error: "Current verified native session required." }, 403);
    const ownerKey = JSON.stringify([auth.orgId, account.policy.accountId]);
    const db = env.AGENT_AUDIT;
    if (!db) return json({ error: "Saved team task storage unavailable." }, 503);
    const row = await db.prepare(`SELECT draft_task_id,draft_task_json,revision,updated_at FROM user_onboarding_progress WHERE user_id=? AND draft_task_id=? AND revision=?`)
      .bind(ownerKey, parsed.data.draftTaskId, parsed.data.expectedRevision).first<{ draft_task_id: string; draft_task_json: string; revision: number; updated_at: number }>();
    if (!row) return unavailable();
    const draft = storedSchema.safeParse(JSON.parse(row.draft_task_json));
    if (!draft.success || draft.data.version !== parsed.data.draftTaskVersion) return unavailable();
    const text = onboardingTaskText(draft.data);
    if (text.length > 4000) return json({ error: "The complete task exceeds 4,000 characters. Shorten it in setup before transferring; it has not been truncated." }, 422);
    let employee: { id: string; version: number } | null = null;
    if (draft.data.employeeId && draft.data.employeeVersion) {
      const current = await getCustomAgentById(env, auth.orgId, draft.data.employeeId);
      if (!current || current.version !== draft.data.employeeVersion) return unavailable();
      employee = { id: current.id, version: current.version };
    }
    const latest = await resolveOrgForApiRequest(request, env, { allowMemberWrite: true });
    if (latest instanceof Response) return latest;
    if (!latest.workspace || latest.principal || latest.orgId !== auth.orgId || latest.workspace.userId !== member.userId || latest.workspace.version !== member.version || latest.workspace.role !== member.role) return unavailable();
    const membership = teamMembershipWriteGuard(auth.orgId, member.userId, member, true);
    // The final single statement binds actual saved bytes, membership, account,
    // native session and selected employee after every earlier awaited read.
    const proof = await db.prepare(`SELECT s.expiresAt AS session_expires_at FROM user_onboarding_progress p JOIN "session" s ON s.id=? AND s.userId=?
      WHERE p.user_id=? AND p.draft_task_id=? AND p.revision=? AND p.draft_task_json=?${membership.sql}
      AND EXISTS(SELECT 1 FROM shiba_auth_account_policy a JOIN "user" u ON u.id=a.account_id WHERE a.account_id=? AND a.email=? AND lower(u.email)=? AND u.emailVerified=1)
      AND ${SESSION_EXPIRY}>${SQL_NOW} AND ?>${SQL_NOW}${employee ? " AND EXISTS(SELECT 1 FROM org_custom_agents e WHERE e.id=? AND e.org_id=? AND e.version=? AND e.deleted_at IS NULL AND e.archived_at IS NULL)" : ""}`)
      .bind(account.sessionId, account.policy.accountId, ownerKey, row.draft_task_id, row.revision, row.draft_task_json, ...membership.values,
        account.policy.accountId, member.userId, member.userId, account.sessionExpiresAt, ...(employee ? [employee.id, auth.orgId, employee.version] : []))
      .first<{ session_expires_at: string | number }>();
    const lease = proof && (typeof proof.session_expires_at === "number" ? proof.session_expires_at : Date.parse(proof.session_expires_at));
    request.signal.throwIfAborted();
    if (!lease || !Number.isFinite(lease) || Math.min(lease, account.sessionExpiresAt) <= Date.now()) return unavailable();
    return json(teamOnboardingTaskSchema.parse({ workspaceId: member.workspaceId, actorId: member.userId, accountId: account.policy.accountId,
      draftTaskId: row.draft_task_id, draftTaskVersion: draft.data.version, progressRevision: row.revision, text, employee,
      savedAt: row.updated_at, expiresAt: Math.min(lease, account.sessionExpiresAt, Date.now() + 15 * 60_000) }));
  } catch { return json({ error: "Saved team task is temporarily unavailable." }, 503); }
}
