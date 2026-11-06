import { z } from "zod";
import { slackInstallationDecisionSchema, slackInstallationStartSchema } from "@shiba/shared";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { resolveWorkspaceNativeMember, type WorkspaceNativeMember } from "./workspace-native-authority.js";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "./dashboard-mutation.js";
import { SlackInstallationError } from "./slack-installations-crypto.js";
import { decideSlackInstallation, listSlackInstallations, slackOAuthConfiguration, type SlackInstallationEnv } from "./slack-installations-store.js";
import { completeSlackInstallation, findSlackOAuthState, refreshSlackInstallation, startSlackInstallation, type SlackOAuthDeps } from "./slack-installations-oauth.js";

const prefix = "/api/slack/installations";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
async function nativeOwner(request: Request, env: SlackInstallationEnv): Promise<WorkspaceNativeMember> {
  const auth = await resolveOrgForApiRequest(request, env);
  if (auth instanceof Response || auth.principal || auth.workspace?.role !== "owner") throw new SlackInstallationError("slack_installation_native_owner_required", 403);
  const member = await resolveWorkspaceNativeMember(request, env, auth.workspace);
  if (!member) throw new SlackInstallationError("slack_installation_native_owner_required", 403);
  return member;
}
async function input(request: Request): Promise<unknown> {
  const reader = request.body?.getReader(), bytes = new Uint8Array(8_192); let used = 0;
  try {
    if (!reader) throw new Error();
    for (;;) { const part = await reader.read(); if (part.done) break; if (used + part.value.length > bytes.length) throw new SlackInstallationError("slack_installation_request_too_large", 413); bytes.set(part.value, used); used += part.value.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, used)));
  } catch (error) { if (error instanceof SlackInstallationError) throw error; throw new SlackInstallationError("slack_installation_request_invalid", 400); }
  finally { await reader?.cancel().catch(() => {}); }
}
export async function handleSlackInstallations(request: Request, env: SlackInstallationEnv, deps: SlackOAuthDeps = {}): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== prefix && !url.pathname.startsWith(prefix + "/")) return null;
  try {
    if (url.pathname === prefix + "/callback") {
      const config = slackOAuthConfiguration(env);
      if (request.method !== "GET" || url.origin + url.pathname !== config.redirectUri || request.headers.has("authorization") ||
        url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("code").length !== 1 || [...url.searchParams.keys()].some((key) => !["state", "code"].includes(key))) throw new SlackInstallationError("slack_oauth_callback_invalid", 400);
      const pending = await findSlackOAuthState(env, url.searchParams.get("state") ?? "");
      if (!pending) throw new SlackInstallationError("slack_oauth_state_unavailable", 403);
      const headers = new Headers(request.headers); headers.set("X-Shiba-Workspace", pending.workspace_id);
      const scoped = new Request(request, { headers }), member = await nativeOwner(scoped, env);
      const verify = async () => { if (JSON.stringify(await nativeOwner(scoped, env)) !== JSON.stringify(member)) throw new SlackInstallationError("slack_oauth_original_owner_required", 403); };
      await completeSlackInstallation(env, member, pending, url.searchParams.get("code") ?? "", verify, deps);
      // Drop the protocol's query-only proof before the dashboard loads any assets.
      return new Response(null, { status: 303, headers: { Location: new URL("/app/?slackInstall=pending-review", config.redirectUri).href, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
    }
    if (!request.headers.has("X-Shiba-Workspace") || url.searchParams.has("workspaceId")) throw new SlackInstallationError("workspace_selector_required", 400);
    if (request.method !== "GET") { const denied = rejectCrossOriginMutation(request) ?? rejectNonJsonMutation(request); if (denied) return denied; }
    const member = await nativeOwner(request, env);
    const verify = async () => { request.signal.throwIfAborted(); if (JSON.stringify(await nativeOwner(request, env)) !== JSON.stringify(member)) throw new SlackInstallationError("slack_installation_authority_changed", 403); request.signal.throwIfAborted(); };
    if (request.method === "GET" && url.pathname === prefix) { await verify(); return json(await listSlackInstallations(env, member)); }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const body = await input(request);
    if (url.pathname === prefix + "/begin") return json({ ok: true, workspaceId: member.workspaceId, actorId: member.userId, ...await startSlackInstallation(env, member, slackInstallationStartSchema.parse(body), verify) });
    const match = /^\/api\/slack\/installations\/([A-Za-z0-9_-]{1,128})\/(activate|revoke|refresh)$/.exec(url.pathname);
    if (!match) return json({ error: "not_found" }, 404);
    const decision = slackInstallationDecisionSchema.parse(body); await verify();
    if (match[2] === "refresh") await refreshSlackInstallation(env, member, match[1]!, decision, verify, deps);
    else await decideSlackInstallation(env, member, match[1]!, decision, match[2] as "activate" | "revoke");
    await verify(); return json(await listSlackInstallations(env, member));
  } catch (error) {
    if (error instanceof SlackInstallationError) return json({ error: error.code }, error.status);
    if (error instanceof z.ZodError) return json({ error: "slack_installation_request_invalid" }, 400);
    return json({ error: "slack_installation_unavailable" }, 503);
  }
}
