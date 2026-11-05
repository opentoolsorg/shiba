import { z } from "zod";
import { founderConnectorActionDecisionSchema, founderConnectorActionExecuteSchema, founderConnectorDecisionSchema,
  founderConnectorOccurrenceInputSchema, getFounderSkillLibraryEntry } from "@shiba/shared";
import type { Env } from "./env.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { resolveWorkspaceNativeMember, type WorkspaceNativeMember } from "./workspace-native-authority.js";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "./dashboard-mutation.js";
import { WorkspaceIntegrationError, assertWorkspaceIntegrationGrant } from "./workspace-integrations-store.js";
import { discoverWorkspaceActions } from "./workspace-integration-actions.js";
import { configureFounderConnector, decideFounderConnectorOccurrence, executeFounderConnectorOccurrence,
  founderConnectionAllowed, founderConnectorOptions, prepareFounderConnectorOccurrence, readFounderConnectorState, transitionFounderConnector } from "./founder-connector-jobs.js";

const pattern = /^\/api\/founder-skills\/([^/]+)\/connector-job(?:\/(options|actions|enable|pause|resume|revoke|occurrences\/([^/]+)\/(prepare|decision|execute)))?\/?$/;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
async function body(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new WorkspaceIntegrationError("founder_connector_request_invalid", 400);
  const bytes = new Uint8Array(32_768); let used = 0;
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break;
      if (used + chunk.value.length > bytes.length) throw new WorkspaceIntegrationError("founder_connector_request_too_large", 413);
      bytes.set(chunk.value, used); used += chunk.value.length;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)));
  } catch (error) { if (error instanceof WorkspaceIntegrationError) throw error; throw new WorkspaceIntegrationError("founder_connector_request_invalid", 400); }
  finally { await reader.cancel().catch(() => {}); }
}
function sameActor(a: WorkspaceNativeMember, b: WorkspaceNativeMember | null) {
  return b && a.accountId === b.accountId && a.userId === b.userId && a.workspaceId === b.workspaceId && a.role === b.role && a.version === b.version;
}

/** Native-human entrypoint. No model or scheduler tool can invoke these approvals. */
export async function handleFounderConnectorJobs(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url), match = pattern.exec(url.pathname);
  if (!match) return null;
  if (!request.headers.has("X-Shiba-Workspace") || url.searchParams.has("workspaceId")) return json({ error: "workspace_selector_required" }, 400);
  if (request.method !== "GET") { const denied = rejectCrossOriginMutation(request) ?? rejectNonJsonMutation(request); if (denied) return denied; }
  const auth = await resolveOrgForApiRequest(request, env);
  if (auth instanceof Response) return auth;
  if (auth.principal || !auth.workspace || auth.workspace.role === "member") return json({ error: "founder_native_manager_required" }, 403);
  const member = await resolveWorkspaceNativeMember(request, env, auth.workspace);
  if (!member) return json({ error: "founder_native_manager_required" }, 403);
  let libraryId: string, occurrenceId: string | undefined;
  try { libraryId = decodeURIComponent(match[1]!); occurrenceId = match[3] ? decodeURIComponent(match[3]) : undefined; }
  catch { return json({ error: "founder_connector_request_invalid" }, 400); }
  if (!getFounderSkillLibraryEntry(libraryId)) return json({ error: "founder_recipe_unavailable" }, 404);
  const verifySession = async () => {
    const latest = await resolveOrgForApiRequest(request, env);
    if (latest instanceof Response) throw new WorkspaceIntegrationError("workspace_authority_changed", 403);
    const current = latest.workspace && !latest.principal ? await resolveWorkspaceNativeMember(request, env, latest.workspace) : null;
    if (!sameActor(member, current)) throw new WorkspaceIntegrationError("workspace_authority_changed", 403);
  };
  const state = async () => { await verifySession(); return json(await readFounderConnectorState(env, member, libraryId)); };
  try {
    const action = match[2];
    if (request.method === "GET") {
      if (!action) return await state();
      if (action === "options") { await verifySession(); return json(await founderConnectorOptions(env, member, libraryId)); }
      if (action === "actions") {
        const connectionId = url.searchParams.get("connectionId") ?? "", employeeId = url.searchParams.get("employeeId") ?? "", employeeVersion = Number(url.searchParams.get("employeeVersion"));
        if (!connectionId || !employeeId || !Number.isSafeInteger(employeeVersion) || employeeVersion < 1) return json({ error: "founder_connector_selection_required" }, 400);
        const current = await assertWorkspaceIntegrationGrant(env, { workspaceId: member.workspaceId, actorId: member.userId, connectionId, employeeId, employeeVersion, permission: "discover" });
        if (!founderConnectionAllowed(libraryId, current.connection.provider_key)) return json({ error: "founder_connector_connection_changed" }, 409);
        const result = await discoverWorkspaceActions(env, member, connectionId, employeeId, employeeVersion, (url.searchParams.get("q") ?? "").slice(0, 200), verifySession);
        return json({ ...result, libraryId, actorId: member.userId, employeeId, employeeVersion });
      }
      return json({ error: "method_not_allowed" }, 405);
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const input = await body(request);
    if (!action) await configureFounderConnector(env, member, libraryId, input);
    else if (["enable", "pause", "resume", "revoke"].includes(action)) await transitionFounderConnector(env, member, libraryId, action as "enable" | "pause" | "resume" | "revoke", founderConnectorDecisionSchema.parse(input));
    else if (occurrenceId && match[4] === "prepare") await prepareFounderConnectorOccurrence(env, member, libraryId, occurrenceId, founderConnectorOccurrenceInputSchema.parse(input));
    else if (occurrenceId && match[4] === "decision") await decideFounderConnectorOccurrence(env, member, libraryId, occurrenceId, founderConnectorActionDecisionSchema.parse(input));
    else if (occurrenceId && match[4] === "execute") await executeFounderConnectorOccurrence(env, member, libraryId, occurrenceId, founderConnectorActionExecuteSchema.parse(input), request.signal);
    else return json({ error: "method_not_allowed" }, 405);
    return await state();
  } catch (error) {
    if (error instanceof WorkspaceIntegrationError) return json({ error: error.code }, error.status);
    if (error instanceof z.ZodError) return json({ error: "founder_connector_request_invalid" }, 400);
    return json({ error: "founder_connector_unavailable" }, 503);
  }
}
