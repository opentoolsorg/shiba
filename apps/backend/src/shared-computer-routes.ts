import { resolveBetterAuthSessionAccount } from "@shiba/auth/better-auth";
import { sharedComputerPrepareSchema, sharedComputerFundingSchema, sharedComputerStartSchema, sharedComputerLeaseSchema, sharedComputerInputSchema, sharedComputerVersionSchema, type SharedComputerState } from "@shiba/shared";
import { z } from "zod";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "./dashboard-mutation.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { resolveWorkspaceNativeMember, type WorkspaceNativeMember } from "./workspace-native-authority.js";
import { isWorkspaceNativeAccountCurrent } from "./workspace-native-authority.js";
import { redactSecrets } from "./security.js";
import { COLLAB_TENANT_ID, getCollaborationRoom } from "./collaboration-store.js";
import { membershipSql, WorkspaceIntegrationError } from "./workspace-integrations-store.js";
import { assertComputerCurrent, claimComputerLease, computerBinding, computerContract, computerDto, computerPolicy, ensureSharedComputerSchema, fundSharedComputer, prepareSharedComputer, readComputerRow, SharedComputerError, type ComputerRow, type SharedComputerEnv } from "./shared-computer-store.js";
import { computerDocumentAction, computerDocumentPreview, computerDocumentImportSchema, computerDocumentPreviewSchema } from "./shared-computer-documents.js";
import { frameSharedComputer, inputSharedComputer, startSharedComputer, stopSharedComputer } from "./shared-computer-runtime.js";

const BASE = "/api/shared-computers", headers = { "cache-control": "no-store, private", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers });
async function parse<T>(request: Request, schema: z.ZodType<T>) {
  const reader = request.body?.getReader(); if (!reader) throw new SharedComputerError("shared_computer_body_required", 400);
  const bytes = new Uint8Array(8192); let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; if (size + part.value.byteLength > bytes.length) throw new SharedComputerError("shared_computer_body_too_large", 413); bytes.set(part.value, size); size += part.value.byteLength; }
    const parsed = schema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))));
    if (!parsed.success) throw new SharedComputerError("shared_computer_body_invalid", 400); return parsed.data;
  } catch (error) { if (error instanceof SharedComputerError) throw error; throw new SharedComputerError("shared_computer_body_invalid", 400); }
  finally { await reader.cancel().catch(() => {}); }
}
async function member(request: Request, env: SharedComputerEnv): Promise<WorkspaceNativeMember> {
  if (!request.headers.get("X-Shiba-Workspace") || request.headers.has("authorization") || new URL(request.url).searchParams.has("workspaceId")) throw new SharedComputerError("shared_computer_native_required", 403);
  const auth = await resolveOrgForApiRequest(request, env, { allowMemberWrite: true });
  if (auth instanceof Response || !auth.workspace || auth.principal || auth.orgId !== `team:${auth.workspace.workspaceId}`) throw new SharedComputerError("shared_computer_native_required", 403);
  const native = await resolveWorkspaceNativeMember(request, env, auth.workspace);
  if (!native) throw new SharedComputerError("shared_computer_verified_native_required", 403); return native;
}
export async function handleSharedComputers(request: Request, env: SharedComputerEnv): Promise<Response | null> {
  const url = new URL(request.url); if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return null;
  try {
    if (request.method !== "GET") { const denied = rejectCrossOriginMutation(request) ?? rejectNonJsonMutation(request); if (denied) return denied; }
    const operation = /^\/sessions\/(scs_[a-f0-9]{32})\/(fund|start|lease|input|frame|stop)$/.exec(url.pathname.slice(BASE.length));
    // Narrow stop retains immutable native owner authority after membership is
    // removed. It grants no read, control, renewal, funding or new allocation.
    if (operation?.[2] === "stop" && request.method === "POST") {
      if (request.headers.has("authorization") || !request.headers.has("X-Shiba-Workspace")) throw new SharedComputerError("shared_computer_native_required", 403);
      await parse(request, sharedComputerVersionSchema);
      const native = await resolveBetterAuthSessionAccount(request, env, redactSecrets);
      if (!native?.emailVerified) throw new SharedComputerError("shared_computer_verified_native_required", 403);
      const row = await readComputerRow(env, request.headers.get("X-Shiba-Workspace")!, operation[1]!);
      const binding = computerBinding(row), owner = [binding.owner, binding.funder].find((x) => x.accountId === native.policy.accountId && x.userId === native.policy.email);
      if (!owner || !await isWorkspaceNativeAccountCurrent(env, owner)) throw new SharedComputerError("shared_computer_stop_owner_required", 403);
      await stopSharedComputer(env, owner.accountId, row); return json({ ok: true, stopped: true });
    }
    const actor = await member(request, env);
    const currentSession = async () => { const current = await member(request, env); if (current.accountId !== actor.accountId || current.userId !== actor.userId || current.workspaceId !== actor.workspaceId || current.version !== actor.version || current.role !== actor.role) throw new SharedComputerError("shared_computer_session_changed", 403); };
    if (url.pathname === `${BASE}/state` && request.method === "GET") {
      const roomId = url.searchParams.get("roomId"); if (!roomId || !/^room_[a-f0-9]{24}$/.test(roomId)) throw new SharedComputerError("shared_computer_room_required", 400);
      const room = await getCollaborationRoom(env, { tenantId: COLLAB_TENANT_ID, workspaceId: actor.workspaceId, userId: actor.userId }, roomId);
      if (!room) throw new SharedComputerError("shared_computer_room_unavailable", 404);
      await ensureSharedComputerSchema(env);
      const rows = await env.AGENT_AUDIT.prepare("SELECT * FROM shared_computer_sessions WHERE workspace_id=? AND room_id=? ORDER BY created_at DESC LIMIT 20").bind(actor.workspaceId, roomId).all<ComputerRow>();
      const sessions = [];
      for (const raw of rows.results) {
        const binding = computerBinding(raw); if (!binding.participants.some((p) => p.member.accountId === actor.accountId)) continue;
        await currentSession(); const row = await readComputerRow(env, actor.workspaceId, raw.id);
        sessions.push(await computerDto(env, actor, row));
      }
      await currentSession();
      const finalRoom = await getCollaborationRoom(env, { tenantId: COLLAB_TENANT_ID, workspaceId: actor.workspaceId, userId: actor.userId }, roomId);
      if (!finalRoom || finalRoom.createdAt !== room.createdAt) throw new SharedComputerError("shared_computer_room_unavailable", 404);
      const policy = computerPolicy(env);
      const authority = membershipSql(actor);
      const options = await env.AGENT_AUDIT.prepare(`SELECT m.user_id,m.version,CASE WHEN p.kind='bootstrap' AND m.role IN ('owner','admin') THEN 1 ELSE 0 END AS can_fund
        FROM collaboration_memberships c JOIN team_workspace_memberships m ON m.tenant_id=c.tenant_id AND m.workspace_id=c.workspace_id AND m.user_id=c.user_id AND m.status='active'
        JOIN shiba_auth_account_policy p ON p.email=m.user_id JOIN "user" u ON u.id=p.account_id AND lower(u.email)=p.email AND u.emailVerified=1
        WHERE c.tenant_id=? AND c.workspace_id=? AND c.room_id=? AND c.actor_kind='human' AND c.status='active' AND ${authority.sql}
          AND EXISTS(SELECT 1 FROM json_each(c.capabilities_json) WHERE value='room.read')
          AND EXISTS(SELECT 1 FROM collaboration_memberships mine WHERE mine.tenant_id=c.tenant_id AND mine.workspace_id=c.workspace_id AND mine.room_id=c.room_id AND mine.user_id=? AND mine.actor_kind='human' AND mine.status='active' AND EXISTS(SELECT 1 FROM json_each(mine.capabilities_json) WHERE value='room.read'))
        ORDER BY m.user_id LIMIT 100`).bind(COLLAB_TENANT_ID, actor.workspaceId, roomId, ...authority.values, actor.userId).all<{ user_id: string; version: number; can_fund: number }>();
      const state: SharedComputerState = { ok: true, enabled: policy.enabled, available: policy.available, unavailableReason: policy.reason, workspaceId: actor.workspaceId, roomId, actorId: actor.userId, sessions,
        members: options.results.map((m) => ({ userId: m.user_id, version: m.version, canFund: m.can_fund === 1 })) };
      return json(state);
    }
    const documentOperation = /^\/sessions\/(scs_[a-f0-9]{32})\/documents\/(preview|import)$/.exec(url.pathname.slice(BASE.length));
    if (documentOperation && request.method === "POST") {
      const row = await readComputerRow(env, actor.workspaceId, documentOperation[1]!);
      if (documentOperation[2] === "preview") {
        const input = await parse(request, computerDocumentPreviewSchema);
        if (input.expectedVersion !== row.version) throw new SharedComputerError("shared_computer_version_changed");
        if (!computerContract(row).viewers.includes(actor.userId)) throw new SharedComputerError("shared_computer_viewer_required", 403);
        const document = await computerDocumentPreview(row);
        await currentSession(); await assertComputerCurrent(env, row, actor, true);
        return json({ ok: true, document });
      }
      const input = await parse(request, computerDocumentImportSchema);
      const action = await computerDocumentAction(row, input);
      await inputSharedComputer(env, actor, row, { ...input, action }, { signal: request.signal, beforeDispatch: currentSession });
      await currentSession();
      return json({ ok: true, session: await computerDto(env, actor, await readComputerRow(env, actor.workspaceId, row.id)) });
    }
    if (request.method !== "POST" || (operation?.[2] === "frame")) return json({ error: "shared_computer_method_unavailable" }, 405);
    let id: string;
    if (url.pathname === `${BASE}/sessions/prepare`) { const input = await parse(request, sharedComputerPrepareSchema); await currentSession(); id = await prepareSharedComputer(env, actor, input); }
    else if (operation) {
      id = operation[1]!; const row = await readComputerRow(env, actor.workspaceId, id);
      if (operation[2] === "fund") { const input = await parse(request, sharedComputerFundingSchema); if (row.version !== input.expectedVersion) throw new SharedComputerError("shared_computer_version_changed"); await currentSession(); await fundSharedComputer(env, actor, row, input.digest); }
      else if (operation[2] === "start") { const input = await parse(request, sharedComputerStartSchema); if (row.version !== input.expectedVersion) throw new SharedComputerError("shared_computer_version_changed"); await startSharedComputer(env, actor, row, input.digest, { signal: request.signal, beforeDispatch: currentSession }); }
      else if (operation[2] === "lease") { const input = await parse(request, sharedComputerLeaseSchema); if (row.version !== input.expectedVersion) throw new SharedComputerError("shared_computer_version_changed"); await currentSession(); await claimComputerLease(env, actor, row, input.digest, input.leaseMs); }
      else if (operation[2] === "input") { const input = await parse(request, sharedComputerInputSchema); await inputSharedComputer(env, actor, row, input, { signal: request.signal, beforeDispatch: currentSession }); }
      else return json({ error: "shared_computer_route_unavailable" }, 404);
    } else if (/^\/sessions\/scs_[a-f0-9]{32}\/capture$/.test(url.pathname.slice(BASE.length))) {
      const input = await parse(request, sharedComputerVersionSchema), sessionId = url.pathname.split("/").at(-2)!;
      const row = await readComputerRow(env, actor.workspaceId, sessionId); if (row.version !== input.expectedVersion) throw new SharedComputerError("shared_computer_version_changed");
      const frame = await frameSharedComputer(env, actor, row, { signal: request.signal, beforeDispatch: currentSession });
      return new Response(new Uint8Array(frame).buffer, { headers: { ...headers, "content-type": "image/jpeg" } });
    } else return json({ error: "shared_computer_route_unavailable" }, 404);
    await currentSession(); const row = await readComputerRow(env, actor.workspaceId, id);
    return json({ ok: true, session: await computerDto(env, actor, row) }, url.pathname.endsWith("/prepare") ? 201 : 200);
  } catch (error) {
    if (error instanceof SharedComputerError) return json({ error: error.code }, error.status);
    if (error instanceof WorkspaceIntegrationError) return json({ error: "shared_computer_authority_changed" }, error.status);
    return json({ error: "shared_computer_unavailable" }, 503);
  }
}
