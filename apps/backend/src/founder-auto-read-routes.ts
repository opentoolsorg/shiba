import { z } from "zod";
import { founderAutomaticReadInputSchema, founderAutomaticReadDecisionSchema, getFounderSkillLibraryEntry } from "@shiba/shared";
import { boundedBody } from "@shiba/openconnector-read-gateway";
import type { Env } from "./env.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { resolveWorkspaceNativeMember, type WorkspaceNativeMember } from "./workspace-native-authority.js";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "./dashboard-mutation.js";
import { WorkspaceIntegrationError } from "./workspace-integrations-store.js";
import { automaticReadOptions, configureAutomaticReads, readAutomaticReadState, transitionAutomaticReads } from "./founder-auto-read-store.js";
import { readAutomaticReadReport } from "./founder-auto-read-runtime.js";
const pattern=/^\/api\/founder-skills\/([^/]+)\/automatic-reads(?:\/(options|enable|pause|resume|revoke|occurrences\/([^/]+)\/report(?:\/(download))?))?\/?$/;
const headers={"cache-control":"no-store","referrer-policy":"no-referrer","x-content-type-options":"nosniff"};
const json=(body:unknown,status=200)=>Response.json(body,{status,headers});
function same(a:WorkspaceNativeMember,b:WorkspaceNativeMember|null){return b&&a.accountId===b.accountId&&a.userId===b.userId&&a.workspaceId===b.workspaceId&&a.version===b.version&&a.role===b.role;}
/** Human standing-grant UI only. Cron and models never create or approve this consent. */
export async function handleFounderAutomaticReads(request:Request,env:Env):Promise<Response|null>{
  const url=new URL(request.url),match=pattern.exec(url.pathname);if(!match)return null;
  if(!request.headers.has("X-Shiba-Workspace")||url.searchParams.has("workspaceId"))return json({error:"workspace_selector_required"},400);
  if(request.method!=="GET"){const denied=rejectCrossOriginMutation(request)??rejectNonJsonMutation(request);if(denied)return denied;}
  const auth=await resolveOrgForApiRequest(request,env);if(auth instanceof Response)return auth;
  if(auth.principal||!auth.workspace||auth.workspace.role==="member")return json({error:"automatic_read_native_manager_required"},403);
  const member=await resolveWorkspaceNativeMember(request,env,auth.workspace);if(!member)return json({error:"automatic_read_native_manager_required"},403);
  let libraryId:string,occurrenceId:string|undefined;try{libraryId=decodeURIComponent(match[1]!);occurrenceId=match[3]?decodeURIComponent(match[3]):undefined;}catch{return json({error:"automatic_read_request_invalid"},400);}
  if(!getFounderSkillLibraryEntry(libraryId))return json({error:"automatic_read_recipe_unavailable"},404);
  const verify=async()=>{request.signal.throwIfAborted();const current=await resolveOrgForApiRequest(request,env),native=!(current instanceof Response)&&current.workspace&&!current.principal?await resolveWorkspaceNativeMember(request,env,current.workspace):null;if(!same(member,native))throw new WorkspaceIntegrationError("workspace_authority_changed",403);request.signal.throwIfAborted();};
  try{const action=match[2];
    if(request.method==="GET"){
      if(!action)return json(await readAutomaticReadState(env,member,libraryId,verify));
      if(action==="options")return json(await automaticReadOptions(env,member,libraryId,verify));
      if(occurrenceId){const report=await readAutomaticReadReport(env,member,libraryId,occurrenceId,verify);
        if(match[4]==="download"){const format=url.searchParams.get("format");if(format!=="markdown"&&format!=="json")return json({error:"automatic_read_format_invalid"},400);return new Response(format==="markdown"?report.markdown:report.json,{headers:{...headers,"content-type":format==="markdown"?"text/markdown; charset=utf-8":"application/json; charset=utf-8","content-disposition":`attachment; filename="${report.id.replace(/[^A-Za-z0-9_-]/g,"_")}.${format==="markdown"?"md":"json"}"`}});}
        return json(report);
      }return json({error:"method_not_allowed"},405);
    }
    if(request.method!=="POST")return json({error:"method_not_allowed"},405);
    let body:unknown;try{body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await boundedBody(request.body,8192)));}catch{return json({error:"automatic_read_request_invalid"},400);}
    if(!action)await configureAutomaticReads(env,member,libraryId,founderAutomaticReadInputSchema.parse(body),verify);
    else if(["enable","pause","resume","revoke"].includes(action))await transitionAutomaticReads(env,member,libraryId,action as "enable"|"pause"|"resume"|"revoke",founderAutomaticReadDecisionSchema.parse(body),verify);
    else return json({error:"method_not_allowed"},405);
    return json(await readAutomaticReadState(env,member,libraryId,verify));
  }catch(error){if(error instanceof WorkspaceIntegrationError)return json({error:error.code},error.status);if(error instanceof z.ZodError)return json({error:"automatic_read_request_invalid"},400);return json({error:"automatic_read_unavailable"},503);}
}
