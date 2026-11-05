import { z } from "zod";
import {
  automaticSlackPrepareSchema,
  automaticSlackDecisionSchema,
  automaticSlackDisclosureSchema,
  founderSkillIdSchema,
} from "@shiba/shared";
import type { Env } from "./env.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import {
  resolveWorkspaceNativeMember,
  type WorkspaceNativeMember,
} from "./workspace-native-authority.js";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "./dashboard-mutation.js";
import { WorkspaceIntegrationError } from "./workspace-integrations-store.js";
import {
  prepareAutomaticSlack,
  readAutomaticSlack,
  transitionAutomaticSlack,
} from "./founder-automatic-slack-store.js";
const pattern =
  /^\/api\/founder-skills\/([^/]+)\/automatic-slack(?:\/(preview|grants\/([^/]+)\/(disclose|approve|pause|revoke)))?\/?$/;
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
function same(a: WorkspaceNativeMember, b: WorkspaceNativeMember | null) {
  return Boolean(
    b &&
      a.accountId === b.accountId &&
      a.userId === b.userId &&
      a.workspaceId === b.workspaceId &&
      a.version === b.version &&
      a.role === b.role,
  );
}
async function body(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new WorkspaceIntegrationError("automatic_slack_request_invalid", 400);
  const bytes = new Uint8Array(8192);
  let used = 0;
  try {
    for (;;) {
      const p = await reader.read();
      if (p.done) break;
      if (used + p.value.length > bytes.length)
        throw new WorkspaceIntegrationError("automatic_slack_request_too_large", 413);
      bytes.set(p.value, used);
      used += p.value.length;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)));
  } catch (e) {
    if (e instanceof WorkspaceIntegrationError) throw e;
    throw new WorkspaceIntegrationError("automatic_slack_request_invalid", 400);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
/** Explicit native human setup only; no webhook/model/scheduler may approve its own grant. */
export async function handleFounderAutomaticSlack(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url),
    match = pattern.exec(url.pathname);
  if (!match) return null;
  if (!request.headers.has("X-Shiba-Workspace") || url.searchParams.has("workspaceId"))
    return json({ error: "workspace_selector_required" }, 400);
  if (request.method !== "GET") {
    const denied = rejectCrossOriginMutation(request) ?? rejectNonJsonMutation(request);
    if (denied) return denied;
  }
  const auth = await resolveOrgForApiRequest(request, env);
  if (auth instanceof Response) return auth;
  if (auth.principal || !auth.workspace || auth.workspace.role === "member")
    return json({ error: "automatic_slack_native_manager_required" }, 403);
  const member = await resolveWorkspaceNativeMember(request, env, auth.workspace);
  if (!member) return json({ error: "automatic_slack_native_manager_required" }, 403);
  const verifySession = async () => {
    request.signal.throwIfAborted();
    const latest = await resolveOrgForApiRequest(request, env),
      current =
        !(latest instanceof Response) && latest.workspace && !latest.principal
          ? await resolveWorkspaceNativeMember(request, env, latest.workspace)
          : null;
    if (!same(member, current))
      throw new WorkspaceIntegrationError("automatic_slack_authority_changed", 403);
    request.signal.throwIfAborted();
  };
  try {
    const libraryId = founderSkillIdSchema.parse(decodeURIComponent(match[1] ?? ""));
    if (request.method === "GET" && !match[2])
      return json(await readAutomaticSlack(env, member, libraryId, verifySession));
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const input = await body(request);
    if (match[2] === "preview")
      await prepareAutomaticSlack(
        env,
        member,
        libraryId,
        automaticSlackPrepareSchema.parse(input),
        verifySession,
      );
    else if (match[3] && match[4]) {
      const id = decodeURIComponent(match[3]);
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(id))
        return json({ error: "automatic_slack_request_invalid" }, 400);
      const action = match[4] as "disclose" | "approve" | "pause" | "revoke";
      await transitionAutomaticSlack(
        env,
        member,
        libraryId,
        id,
        action,
        (action === "disclose"
          ? automaticSlackDisclosureSchema
          : automaticSlackDecisionSchema
        ).parse(input),
        verifySession,
      );
    } else return json({ error: "method_not_allowed" }, 405);
    return json(await readAutomaticSlack(env, member, libraryId, verifySession));
  } catch (error) {
    if (error instanceof WorkspaceIntegrationError)
      return json({ error: error.code }, error.status);
    if (error instanceof z.ZodError || error instanceof URIError)
      return json({ error: "automatic_slack_request_invalid" }, 400);
    return json({ error: "automatic_slack_unavailable" }, 503);
  }
}
