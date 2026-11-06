import { z } from "zod";
import { founderEvidenceInputSchema, founderEvidenceCreateInputSchema, founderEvidenceRevokeInputSchema, getFounderSkillLibraryEntry } from "@shiba/shared";
import type { Env } from "./env.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { resolveWorkspaceNativeMember, type WorkspaceNativeMember } from "./workspace-native-authority.js";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "./dashboard-mutation.js";
import { WorkspaceIntegrationError } from "./workspace-integrations-store.js";
import { createFounderEvidenceReport, founderEvidenceOptions, listFounderEvidenceReports, loadFounderEvidenceReport, previewFounderEvidenceReport, revokeFounderEvidenceReport } from "./founder-evidence-reports.js";

const pattern = /^\/api\/founder-skills\/([^/]+)\/reports(?:\/(options|preview|([^/]+)(?:\/(download|revoke))?))?\/?$/;
const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
async function body(request: Request): Promise<unknown> {
  const reader = request.body?.getReader(); if (!reader) throw new WorkspaceIntegrationError("report_request_invalid", 400);
  const output = new Uint8Array(8192); let used = 0;
  try { for (;;) { const item = await reader.read(); if (item.done) break; if (used + item.value.length > output.length) throw new WorkspaceIntegrationError("report_request_too_large", 413); output.set(item.value, used); used += item.value.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal:true }).decode(output.subarray(0,used)));
  } catch (error) { if (error instanceof WorkspaceIntegrationError) throw error; throw new WorkspaceIntegrationError("report_request_invalid",400); }
  finally { await reader.cancel().catch(() => {}); }
}
function same(a: WorkspaceNativeMember,b: WorkspaceNativeMember | null) { return b && a.userId===b.userId && a.accountId===b.accountId && a.workspaceId===b.workspaceId && a.version===b.version && a.role===b.role; }
export async function handleFounderEvidenceReports(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url), match = pattern.exec(url.pathname); if (!match) return null;
  if (!request.headers.has("X-Shiba-Workspace") || url.searchParams.has("workspaceId")) return json({error:"workspace_selector_required"},400);
  if (request.method!=="GET") { const denied=rejectCrossOriginMutation(request)??rejectNonJsonMutation(request); if(denied)return denied; }
  const auth=await resolveOrgForApiRequest(request,env); if(auth instanceof Response)return auth;
  if(auth.principal||!auth.workspace||auth.workspace.role==="member")return json({error:"founder_native_manager_required"},403);
  const member=await resolveWorkspaceNativeMember(request,env,auth.workspace); if(!member)return json({error:"founder_native_manager_required"},403);
  let libraryId:string,reportId:string|undefined;
  try {libraryId=decodeURIComponent(match[1]!);reportId=match[3]?decodeURIComponent(match[3]):undefined;} catch{return json({error:"report_request_invalid"},400);}
  if(!getFounderSkillLibraryEntry(libraryId))return json({error:"report_recipe_unavailable"},404);
  const verify=async()=>{const current=await resolveOrgForApiRequest(request,env);if(current instanceof Response||!current.workspace||current.principal||!same(member,await resolveWorkspaceNativeMember(request,env,current.workspace)))throw new WorkspaceIntegrationError("workspace_authority_changed",403);};
  try {
    const action=match[2];
    if(request.method==="GET") {
      await verify();
      if(!action)return json(await listFounderEvidenceReports(env,member,libraryId,{beforeFinalRead:verify}));
      if(action==="options") {const employeeId=url.searchParams.get("employeeId")??undefined,version=url.searchParams.has("employeeVersion")?Number(url.searchParams.get("employeeVersion")):undefined;
        if((employeeId===undefined)!==(version===undefined)||(version!==undefined&&(!Number.isSafeInteger(version)||version<1)))return json({error:"report_profile_invalid"},400);
        return json(await founderEvidenceOptions(env,member,libraryId,employeeId,version,{beforeFinalRead:verify}));}
      if(reportId) {const loaded=await loadFounderEvidenceReport(env,member,libraryId,reportId,{beforeFinalRead:verify});
        if(match[4]==="download") {const format=url.searchParams.get("format");if(format!=="markdown"&&format!=="json")return json({error:"report_format_invalid"},400);
          return new Response(format==="markdown"?loaded.report.markdown:loaded.report.json,{headers:{...headers,"content-type":format==="markdown"?"text/markdown; charset=utf-8":"application/json; charset=utf-8","content-disposition":`attachment; filename="${reportId}.${format==="markdown"?"md":"json"}"`}});}
        if(!match[4])return json(loaded.report);
      }
      return json({error:"method_not_allowed"},405);
    }
    if(request.method!=="POST")return json({error:"method_not_allowed"},405);
    const input=await body(request);await verify();
    if(action==="preview")return json(await previewFounderEvidenceReport(env,member,libraryId,founderEvidenceInputSchema.parse(input),{beforeFinalRead:verify}));
    if(!action)return json((await createFounderEvidenceReport(env,member,libraryId,founderEvidenceCreateInputSchema.parse(input),{beforeFinalRead:verify})).report,201);
    if(reportId&&match[4]==="revoke")return json(await revokeFounderEvidenceReport(env,member,libraryId,reportId,founderEvidenceRevokeInputSchema.parse(input).expectedReportHash,{beforeFinalRead:verify}));
    return json({error:"method_not_allowed"},405);
  }catch(error){if(error instanceof WorkspaceIntegrationError)return json({error:error.code},error.status);if(error instanceof z.ZodError)return json({error:"report_request_invalid"},400);return json({error:"report_unavailable"},503);}
}
