import { teamModelFundingInputSchema, teamModelTurnInputSchema } from "@shiba/shared";
import { z } from "zod";
import type { Env } from "./env.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "./dashboard-mutation.js";
import { resolveWorkspaceNativeMember, type WorkspaceNativeMember } from "./workspace-native-authority.js";
import { WorkspaceIntegrationError } from "./workspace-integrations-store.js";
import { executeTeamModelTurn } from "./team-model-runtime.js";
import {
  TeamModelError, activateTeamModelFunding, approveTeamModelTurn, cancelTeamModelTurn, prepareTeamModelFunding,
  prepareTeamModelTurn, readTeamModelFunding, readTeamModelState, readTeamModelTurn, revokeTeamModelFunding,
} from "./team-model-store.js";

const BASE = "/api/team-model-sessions";
const positive = z.number().int().positive(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const activate = z.object({ expectedVersion: positive, digest: hash, billingConsent: z.literal(true), reviewed: z.literal(true) }).strict();
const version = z.object({ expectedVersion: positive }).strict();
const approve = z.object({ expectedVersion: positive, inputHash: hash, reviewed: z.literal(true) }).strict();
const execute = z.object({ expectedVersion: positive, inputHash: hash }).strict();
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
async function parse<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const reader = request.body?.getReader();
  if (!reader) throw new TeamModelError("team_model_body_required", 400);
  const bytes = new Uint8Array(32_768); let offset = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; if (offset + part.value.byteLength > bytes.byteLength) throw new TeamModelError("team_model_body_too_large", 413); bytes.set(part.value, offset); offset += part.value.byteLength; }
    const result = schema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset))));
    if (!result.success) throw new TeamModelError("team_model_body_invalid", 400);
    return result.data;
  } catch (error) { if (error instanceof TeamModelError) throw error; throw new TeamModelError("team_model_body_invalid", 400); }
  finally { await reader.cancel().catch(() => {}); }
}
async function nativeMember(request: Request, env: Env): Promise<WorkspaceNativeMember> {
  if (!request.headers.has("X-Shiba-Workspace") || new URL(request.url).searchParams.has("workspaceId") || request.headers.has("authorization")) throw new TeamModelError("team_model_native_workspace_required", 403);
  const auth = await resolveOrgForApiRequest(request, env, { allowMemberWrite: true });
  if (auth instanceof Response || !auth.workspace || auth.principal || auth.orgId !== `team:${auth.workspace.workspaceId}`) throw new TeamModelError("team_model_native_workspace_required", 403);
  const member = await resolveWorkspaceNativeMember(request, env, auth.workspace);
  if (!member) throw new TeamModelError("team_model_verified_native_required", 403);
  return member;
}
export async function handleTeamModelSessions(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return null;
  try {
    if (request.method !== "GET") { const blocked = rejectCrossOriginMutation(request) ?? rejectNonJsonMutation(request); if (blocked) return blocked; }
    const member = await nativeMember(request, env);
    const currentSession = async () => {
      const current = await nativeMember(request, env);
      if (current.accountId !== member.accountId || current.userId !== member.userId || current.workspaceId !== member.workspaceId || current.version !== member.version || current.role !== member.role) throw new TeamModelError("team_model_session_changed", 403);
    };
    const suffix = url.pathname.slice(BASE.length);
    if (suffix === "/state" && request.method === "GET") {
      const roomId = url.searchParams.get("roomId");
      if (!roomId || !/^room_[a-f0-9]{24}$/.test(roomId)) throw new TeamModelError("team_model_room_required", 400);
      await currentSession();
      return json(await readTeamModelState(env, member, roomId));
    }
    if (request.method !== "POST") return json({ error: "team_model_method_unavailable" }, 405);
    let kind: "grant" | "turn", id: string, roomId: string, status = 200;
    if (suffix === "/funding/prepare") {
      const input = await parse(request, teamModelFundingInputSchema); kind = "grant"; roomId = input.roomId;
      id = await prepareTeamModelFunding(env, member, input); status = 201;
    } else if (suffix === "/turns/prepare") {
      const input = await parse(request, teamModelTurnInputSchema); kind = "turn";
      id = await prepareTeamModelTurn(env, member, input); roomId = (await readTeamModelTurn(env, member, id)).room_id; status = 201;
    } else {
      const funding = /^\/funding\/(tmf_[a-f0-9]{32})\/(activate|revoke)$/.exec(suffix);
      const turn = /^\/turns\/(tmt_[a-f0-9]{32})\/(approve|execute|cancel)$/.exec(suffix);
      if (funding) {
        id = funding[1]!; kind = "grant";
        if (funding[2] === "activate") await activateTeamModelFunding(env, member, id, await parse(request, activate));
        else await revokeTeamModelFunding(env, member, id, (await parse(request, version)).expectedVersion);
        roomId = (await readTeamModelFunding(env, member.workspaceId, id)).room_id;
      } else if (turn) {
        id = turn[1]!; kind = "turn";
        if (turn[2] === "approve") await approveTeamModelTurn(env, member, id, await parse(request, approve));
        else if (turn[2] === "cancel") await cancelTeamModelTurn(env, member, id, (await parse(request, version)).expectedVersion);
        else await executeTeamModelTurn(env, member, id, await parse(request, execute), { signal: request.signal, beforeDispatch: currentSession });
        roomId = (await readTeamModelTurn(env, member, id)).room_id;
      } else return json({ error: "team_model_route_unavailable" }, 404);
    }
    // Protected previews/results are hydrated only after the final session
    // recheck. The store then ends in one all-row source/native D1 snapshot.
    await currentSession();
    const state = await readTeamModelState(env, member, roomId);
    const receipt = kind === "grant" ? state.grants.find((item) => item.id === id) : state.turns.find((item) => item.id === id);
    if (!receipt) throw new TeamModelError("team_model_receipt_unavailable", 403);
    return json({ ok: true, workspaceId: member.workspaceId, roomId, [kind]: receipt }, status);
  } catch (error) {
    if (error instanceof TeamModelError) return json({ error: error.code }, error.status);
    if (error instanceof WorkspaceIntegrationError) return json({ error: "team_model_authority_changed" }, error.status);
    return json({ error: "team_model_unavailable" }, 503);
  }
}
