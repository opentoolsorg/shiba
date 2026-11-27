import { z } from "zod";
import { boundedBody } from "@shiba/openconnector-read-gateway";
import { deadlinePassed, nativeSessionProof, resolveNativeSession } from "../native-session.js";
import { resolveOrgForApiRequest } from "../../org-request-auth.js";
import { resolveWorkspaceNativeMember, type WorkspaceNativeMember } from "../../workspace-native-authority.js";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "../../dashboard-mutation.js";
import { WorkspaceIntegrationError } from "../../workspace-integrations-store.js";
import { FOUNDER_SQL_NOW } from "../founder-connector-context.js";
import type { Grant, ReadAdapter, ReadsEnv, SqlFence } from "./adapter.js";
import { assertAvailable, digestJson, ownerOf, publicGrant, validContract } from "./contract.js";
import { boundReport, pinFrom } from "./evidence.js";
import { exactRow, managerFence, TAG } from "./ledger.js";
import { createDraft, enableGrant, getGrant, revokeGrant, verifyGrant } from "./lifecycle.js";

const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
interface StoredReport { report_json: string; result_digest: string; expires_at: number }

/** A completed, unexpired receipt of the exact grant row, owned by the caller, under the current and the original membership. */
function servable(adapter: ReadAdapter, member: WorkspaceNativeMember, grant: Grant): SqlFence {
  const row = exactRow(adapter, grant, "g"), current = managerFence(member), original = managerFence(ownerOf(grant));
  return {
    sql: `g.workspace_id=? AND g.owner_account_id=? AND g.owner_id=? AND g.revision=r.grant_revision AND g.state IN ('enabled','exhausted') AND g.expires_at>${FOUNDER_SQL_NOW} AND r.expires_at>${FOUNDER_SQL_NOW} AND r.state='completed' AND ${row.sql} AND ${current.sql} AND ${original.sql}`,
    values: [member.workspaceId, member.accountId, member.userId, ...row.values, ...current.values, ...original.values],
  };
}

/**
 * The three routes of one provider. Every route needs a native manager and that manager's cookie session, and every
 * response, whatever it carries, leaves only after one last statement re-proves the session and membership;
 * report bytes additionally re-prove the exact grant row, the exact stored bytes and the lease in that same statement.
 */
export async function handleReads(request: Request, env: ReadsEnv, adapter: ReadAdapter): Promise<Response | null> {
  const url = new URL(request.url);
  const { grants, receipts } = adapter.tables;
  const match = new RegExp(`^${adapter.wire.route}(?:/(${adapter.wire.grantPrefix}[a-f0-9]{32})(?:/(verify|enable|revoke|reports/(${adapter.wire.receiptPrefix}[a-f0-9]{32})))?)?/?$`).exec(url.pathname);
  if (!match) return null;
  const code = (suffix: string) => `${adapter.id}_${suffix}`;
  if (!request.headers.has("X-Shiba-Workspace") || url.search) return json({ error: code("workspace_required") }, 400);
  if (request.method !== "GET") {
    const denied = rejectCrossOriginMutation(request) ?? rejectNonJsonMutation(request);
    if (denied) return denied;
  }
  const auth = await resolveOrgForApiRequest(request, env);
  if (auth instanceof Response) return auth;
  if (auth.principal || !auth.workspace || auth.workspace.role === "member") return json({ error: code("native_manager_required") }, 403);
  const member = await resolveWorkspaceNativeMember(request, env, auth.workspace);
  if (!member) return json({ error: code("native_manager_required") }, 403);
  const scoped = (body: Record<string, unknown>, status = 200) => json({ ...body, workspaceId: member.workspaceId, actorId: member.userId }, status);
  const resolved = await resolveNativeSession(request, env, member);
  if (!resolved) return scoped({ error: code("native_session_required") }, 403);
  const session = { id: resolved.id, expiresAt: resolved.expiresAt };
  const [, id, action, reportId] = match;
  let served: { grant: Grant; row: StoredReport } | undefined;
  const run = async () => {
    try {
      if (action !== "revoke" && request.method !== "GET") assertAvailable(adapter, env);
      if (request.method === "GET" && !id) {
        const guard = managerFence(member);
        const rows = await env.AGENT_AUDIT.prepare(`${TAG.list} SELECT * FROM ${grants} WHERE workspace_id=? AND owner_id=? AND owner_account_id=? AND ${guard.sql} ORDER BY created_at DESC LIMIT 50`).bind(member.workspaceId, member.userId, member.accountId, ...guard.values).all<Grant>();
        let available = true; try { assertAvailable(adapter, env); } catch { available = false; }
        return scoped({ available, grants: rows.results.map((row) => publicGrant(adapter, row)) });
      }
      if (request.method === "GET" && id) {
        const grant = await getGrant(adapter, env, member, id, true);
        if (!grant) return scoped({ error: code("grant_unavailable") }, 404);
        if (reportId) {
          const unavailable = () => scoped({ error: code("report_unavailable") }, 404);
          assertAvailable(adapter, env);
          if (!await validContract(adapter, grant)) return unavailable();
          const proof = servable(adapter, member, grant);
          const row = await env.AGENT_AUDIT.prepare(`${TAG.report} SELECT r.report_json,r.result_digest,r.expires_at FROM ${receipts} r JOIN ${grants} g ON g.id=r.grant_id WHERE r.id=? AND ${proof.sql}`).bind(reportId, ...proof.values).first<StoredReport>();
          if (!row || await digestJson(row.report_json) !== row.result_digest) return unavailable();
          const final = await env.AGENT_AUDIT.prepare(`${TAG.finalProof} SELECT 1 AS current FROM ${receipts} r JOIN ${grants} g ON g.id=r.grant_id WHERE r.id=? AND r.report_json=? AND r.result_digest=? AND r.expires_at=? AND ${proof.sql}`).bind(reportId, row.report_json, row.result_digest, row.expires_at, ...proof.values).first();
          if (!final) return unavailable();
          assertAvailable(adapter, env);
          if (deadlinePassed(grant.expires_at, row.expires_at)) return unavailable();
          let report: unknown;
          try { report = boundReport(adapter, JSON.parse(row.report_json), pinFrom(adapter, grant)); } catch { return unavailable(); }
          served = { grant, row };
          return scoped({ report, digest: row.result_digest });
        }
        if (action) return scoped({ error: "method_not_allowed" }, 405);
        const guard = managerFence(member);
        const listed = await env.AGENT_AUDIT.prepare(`SELECT r.id,r.state,r.created_at,r.expires_at FROM ${receipts} r JOIN ${grants} g ON g.id=r.grant_id WHERE g.id=? AND g.owner_account_id=? AND g.workspace_id=? AND ${guard.sql} ORDER BY r.created_at DESC LIMIT 50`).bind(id, member.accountId, member.workspaceId, ...guard.values).all<{ id: string; state: string; created_at: number; expires_at: number }>();
        return scoped({ grant: publicGrant(adapter, grant), receipts: listed.results.map((receipt) => ({ id: receipt.id, state: receipt.state, createdAt: receipt.created_at, expiresAt: receipt.expires_at })) });
      }
      if (request.method !== "POST") return scoped({ error: "method_not_allowed" }, 405);
      let body: unknown;
      try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBody(request.body, 8192))); } catch { return scoped({ error: code("request_invalid") }, 400); }
      if (!id) return scoped({ grant: await createDraft(adapter, env, member, body, session) }, 201);
      const input = adapter.schemas.decision.parse(body);
      const grant = await getGrant(adapter, env, member, id, action === "revoke");
      if (!grant || grant.contract_digest !== input.digest) return scoped({ error: code("grant_changed") }, 409);
      if (action === "verify") await verifyGrant(adapter, env, member, id, input.digest, session);
      else if (action === "enable") await enableGrant(adapter, env, member, id, input.digest, session);
      else if (action === "revoke") await revokeGrant(adapter, env, member, id, input.digest, session);
      else return scoped({ error: "method_not_allowed" }, 405);
      const next = await getGrant(adapter, env, member, id, action === "revoke");
      return scoped({ grant: next ? publicGrant(adapter, next) : null });
    } catch (error) {
      if (error instanceof z.ZodError) return scoped({ error: code("request_invalid") }, 400);
      if (error instanceof WorkspaceIntegrationError) return scoped({ error: error.code }, error.status);
      return scoped({ error: code("read_unavailable") }, 503);
    }
  };
  const response = await run();
  const refused = () => scoped({ error: code("native_session_required") }, 403);
  try {
    if (reportId && response.ok && !served) return scoped({ error: code("report_unavailable") }, 403);
    const guard = managerFence(member), human = nativeSessionProof({ ...session, userId: member.accountId });
    const bytes = served ? servable(adapter, member, served.grant) : undefined;
    const lease = bytes ? `,(SELECT min(r.expires_at,g.expires_at) FROM ${receipts} r JOIN ${grants} g ON g.id=r.grant_id WHERE r.id=?) AS lease_expires` : "";
    const exact = bytes ? ` AND EXISTS(SELECT 1 FROM ${receipts} r JOIN ${grants} g ON g.id=r.grant_id WHERE r.id=? AND r.report_json=? AND r.result_digest=? AND r.expires_at=? AND ${bytes.sql})` : "";
    const proof = await env.AGENT_AUDIT.prepare(`${TAG.sessionProof} SELECT ${human.select}${lease} WHERE ${human.where} AND ${guard.sql}${exact}`)
      .bind(...human.selectValues, ...(bytes ? [reportId] : []), ...human.whereValues, ...guard.values, ...(bytes ? [reportId, served!.row.report_json, served!.row.result_digest, served!.row.expires_at, ...bytes.values] : []))
      .first<{ session_expires: number | string | null; lease_expires?: number | null }>();
    if (!proof || deadlinePassed(human.deadline(proof.session_expires)) || bytes && deadlinePassed(proof.lease_expires)) return refused();
    if (bytes) assertAvailable(adapter, env);
    return response;
  } catch { return refused(); }
}
