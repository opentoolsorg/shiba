import { resolveBetterAuthSessionAccount } from "@shiba/auth/better-auth";
import type { Env } from "./env.js";
import { requireSameOriginBrowserMutation } from "./request-auth.js";
import { redactSecrets } from "./security.js";
import { runRoomName } from "./run-room-events.js";
import { archiveNativeSql, archiveReservationDigest, validateArchiveReservation, type ArchiveReservation } from "./run-output-archive-reservations.js";

const BASE = "/api/run-output-archives";
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: {
  "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
} });
export async function handleRunOutputArchives(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return null;
  try {
    if (request.headers.has("authorization") || request.headers.has("X-Shiba-Workspace")) return json({ error: "Private native owner session required." }, 403);
    const actor = await resolveBetterAuthSessionAccount(request, env, redactSecrets);
    if (!actor?.emailVerified || actor.policy.kind !== "bootstrap" || !actor.sessionId || !actor.sessionExpiresAt || actor.sessionExpiresAt <= Date.now()) return json({ error: "Private native owner session required." }, 403);
    const ownerId = actor.policy.email, accountId = actor.policy.accountId;
    const sessionId = actor.sessionId;
    const currentSession = async () => {
      const now = await resolveBetterAuthSessionAccount(request, env, redactSecrets);
      if (!now?.emailVerified || now.policy.kind !== "bootstrap" || now.policy.accountId !== accountId || now.policy.email !== ownerId ||
        now.sessionId !== sessionId || !now.sessionExpiresAt || now.sessionExpiresAt <= Date.now()) throw new Error("Native archive session changed.");
    };
    const finalNativeProof = async (reservation?: ArchiveReservation) => {
      const row = await env.AGENT_AUDIT.prepare(`SELECT s.expiresAt,
        (SELECT json_group_array(r.id) FROM run_output_archive_reservations r WHERE r.owner_id=? AND r.owner_account_id=? AND r.state='reserved' AND r.expires_at>?) AS archive_ids
        FROM "user" u JOIN "session" s ON s.userId=u.id JOIN shiba_auth_account_policy p ON p.account_id=u.id
        WHERE u.id=? AND s.id=? AND p.kind='bootstrap' AND p.email=? AND lower(u.email)=? AND u.emailVerified=1
        ${reservation ? "AND EXISTS(SELECT 1 FROM run_output_archive_reservations a WHERE a.id=? AND a.owner_account_id=u.id AND a.owner_id=p.email AND a.digest=? AND a.state='reserved' AND a.expires_at>?)" : ""}`)
        .bind(ownerId, accountId, Date.now(), accountId, sessionId, ownerId, ownerId,
          ...(reservation ? [reservation.id, archiveReservationDigest(reservation), Date.now()] : [])).first<{ expiresAt: string | number; archive_ids: string }>();
      const expiry = row && (typeof row.expiresAt === "number" ? row.expiresAt : Date.parse(row.expiresAt));
      if (!expiry || !Number.isFinite(expiry) || expiry <= Date.now()) throw new Error("Native archive session expired or was revoked.");
      return new Set(JSON.parse(row!.archive_ids) as string[]);
    };
    if (url.pathname === BASE && request.method === "GET") {
      const rows = await env.AGENT_AUDIT.prepare(`SELECT r.id,r.session_id,r.run_id,r.job_id,r.expires_at,r.state FROM run_output_archive_reservations r
        WHERE r.owner_id=? AND r.owner_account_id=? AND r.state='reserved' AND r.expires_at>? AND ${archiveNativeSql} ORDER BY r.created_at DESC LIMIT 4`)
        .bind(ownerId, accountId, Date.now()).all<{ id: string; session_id: string; run_id: string; job_id: string; expires_at: number; state: string }>();
      await currentSession(); const currentIds = await finalNativeProof();
      return json({ ok: true, actorId: ownerId, ownerAccountId: accountId, archives: rows.results.filter((row) => currentIds.has(row.id) && row.expires_at > Date.now()).map((row) => ({ id: row.id, sessionId: row.session_id, runId: row.run_id, jobId: row.job_id, expiresAt: row.expires_at })) });
    }
    const match = /^\/([a-f0-9]{64})(\/revoke)?$/.exec(url.pathname.slice(BASE.length));
    if (!match) return json({ error: "Output archive not found." }, 404);
    const stored = await env.AGENT_AUDIT.prepare(`SELECT r.contract_json FROM run_output_archive_reservations r WHERE r.id=? AND r.owner_id=?
      AND r.owner_account_id=? AND r.state='reserved' AND r.expires_at>? AND ${archiveNativeSql}`)
      .bind(match[1], ownerId, accountId, Date.now()).first<{ contract_json: string }>();
    if (!stored) return json({ error: "Output archive not found." }, 404);
    const reservation = JSON.parse(stored.contract_json) as ArchiveReservation; validateArchiveReservation(reservation);
    if (reservation.id !== match[1] || reservation.ownerId !== ownerId || reservation.ownerAccountId !== accountId) throw new Error("Archive identity changed.");
    if (match[2] && request.method === "POST") {
      const blocked = requireSameOriginBrowserMutation(request); if (blocked) return blocked;
      await currentSession();
      const result = await env.AGENT_AUDIT.prepare(`UPDATE run_output_archive_reservations AS r SET state='revoked' WHERE r.id=?
        AND r.owner_id=? AND r.owner_account_id=? AND r.state='reserved' AND r.expires_at>? AND ${archiveNativeSql} RETURNING id`)
        .bind(reservation.id, ownerId, accountId, Date.now()).first<{ id: string }>();
      if (!result) throw new Error("Archive authority changed.");
      await finalNativeProof();
      return json({ ok: true, actorId: ownerId, ownerAccountId: accountId, archiveId: result.id, state: "revoked" });
    }
    if (match[2] || request.method !== "GET") return json({ error: "Method not allowed." }, 405);
    const afterValues = url.searchParams.getAll("after"), after = Number(afterValues[0] ?? "0");
    if (afterValues.length > 1 || !/^(0|[1-9][0-9]{0,4})$/.test(afterValues[0] ?? "0") || !Number.isSafeInteger(after) || after > reservation.policy.maxEvents)
      return json({ error: "Invalid archive cursor." }, 400);
    const identity = { ownerId, sessionId: reservation.sessionId, runId: reservation.runId };
    const data = await env.ConversationRoom.getByName(runRoomName(ownerId, reservation.sessionId))
      .readRunOutputArchive(identity, reservation.id, accountId, after);
    await currentSession();
    // The final native/reservation D1 fence follows all DO/session awaits.
    await finalNativeProof(reservation);
    // A D1 proof may have waited past the absolute lease after taking its snapshot.
    validateArchiveReservation(reservation, Date.now());
    return json({ ok: true, actorId: ownerId, ownerAccountId: accountId, sessionId: reservation.sessionId, runId: reservation.runId, ...data });
  } catch { return json({ error: "Current native archive authority or storage is unavailable." }, 404); }
}
