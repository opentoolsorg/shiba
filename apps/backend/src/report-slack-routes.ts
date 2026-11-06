import { z } from "zod";
import { founderSkillIdSchema, reportSlackDecisionSchema, reportSlackDisclosureSchema, reportSlackPrepareSchema } from "@shiba/shared";
import type { Env } from "./env.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { resolveWorkspaceNativeMember, type WorkspaceNativeMember } from "./workspace-native-authority.js";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "./dashboard-mutation.js";
import { WorkspaceIntegrationError } from "./workspace-integrations-store.js";
import { approveAndSendReportSlack, cancelReportSlack, discloseReportSlack, prepareReportSlack, readReportSlack, type ReportSlackDeps } from "./report-slack-store.js";

const pattern = /^\/api\/founder-skills\/([^/]+)\/reports\/([^/]+)\/slack(?:\/(preview|intents\/([^/]+)\/(disclose|approve|cancel)))?\/?$/;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
async function body(request: Request): Promise<unknown> {
  const reader = request.body?.getReader(); if (!reader) throw new WorkspaceIntegrationError("report_slack_request_invalid", 400);
  const bytes = new Uint8Array(8_192); let used = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break;
      if (used + part.value.length > bytes.length) throw new WorkspaceIntegrationError("report_slack_request_too_large", 413);
      bytes.set(part.value, used); used += part.value.length;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, used)));
  } catch (error) { if (error instanceof WorkspaceIntegrationError) throw error; throw new WorkspaceIntegrationError("report_slack_request_invalid", 400); }
  finally { await reader.cancel().catch(() => {}); }
}
function same(a: WorkspaceNativeMember, b: WorkspaceNativeMember | null): boolean {
  return Boolean(b && a.accountId === b.accountId && a.userId === b.userId && a.workspaceId === b.workspaceId && a.version === b.version && a.role === b.role);
}
/** Cookie-authenticated human path. Never mounted as an agent tool or cron callback. */
export async function handleReportSlack(request: Request, env: Env, deps: ReportSlackDeps = {}): Promise<Response | null> {
  const url = new URL(request.url), match = pattern.exec(url.pathname); if (!match) return null;
  if (!request.headers.has("X-Shiba-Workspace") || url.searchParams.has("workspaceId")) return json({ error: "workspace_selector_required" }, 400);
  if (request.method !== "GET") { const denied = rejectCrossOriginMutation(request) ?? rejectNonJsonMutation(request); if (denied) return denied; }
  const auth = await resolveOrgForApiRequest(request, env);
  if (auth instanceof Response) return auth;
  if (auth.principal || !auth.workspace || auth.workspace.role === "member") return json({ error: "report_slack_native_manager_required" }, 403);
  const member = await resolveWorkspaceNativeMember(request, env, auth.workspace);
  if (!member) return json({ error: "report_slack_native_manager_required" }, 403);
  let libraryId: string, reportId: string, intentId: string | undefined;
  try { libraryId = founderSkillIdSchema.parse(decodeURIComponent(match[1]!)); reportId = decodeURIComponent(match[2]!); intentId = match[4] ? decodeURIComponent(match[4]) : undefined; }
  catch { return json({ error: "report_slack_request_invalid" }, 400); }
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(reportId) || intentId && !/^[A-Za-z0-9_-]{1,200}$/.test(intentId)) return json({ error: "report_slack_request_invalid" }, 400);
  const verifySession = async () => {
    request.signal.throwIfAborted();
    const latest = await resolveOrgForApiRequest(request, env);
    const current = !(latest instanceof Response) && latest.workspace && !latest.principal ? await resolveWorkspaceNativeMember(request, env, latest.workspace) : null;
    if (!same(member, current)) throw new WorkspaceIntegrationError("report_slack_authority_changed", 403);
    request.signal.throwIfAborted();
  };
  try {
    if (request.method === "GET" && !match[3]) return json(await readReportSlack(env, member, libraryId, reportId, verifySession));
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const input = await body(request);
    if (match[3] === "preview") await prepareReportSlack(env, member, libraryId, reportId, reportSlackPrepareSchema.parse(input), verifySession);
    else if (intentId && match[5] === "disclose") await discloseReportSlack(env, member, libraryId, reportId, intentId, reportSlackDisclosureSchema.parse(input), verifySession);
    else if (intentId && match[5] === "cancel") await cancelReportSlack(env, member, libraryId, reportId, intentId, reportSlackDecisionSchema.parse(input), verifySession);
    else if (intentId && match[5] === "approve") await approveAndSendReportSlack(env, member, libraryId, reportId, intentId, reportSlackDecisionSchema.parse(input), verifySession, deps);
    else return json({ error: "method_not_allowed" }, 405);
    return json(await readReportSlack(env, member, libraryId, reportId, verifySession));
  } catch (error) {
    if (error instanceof WorkspaceIntegrationError) return json({ error: error.code }, error.status);
    if (error instanceof z.ZodError) return json({ error: "report_slack_request_invalid" }, 400);
    return json({ error: "report_slack_unavailable" }, 503);
  }
}
