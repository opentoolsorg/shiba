import { z } from "zod";
import { boundedBody } from "@shiba/openconnector-read-gateway";
import { founderReconciliationScheduleDecisionSchema,founderReconciliationScheduleReductionSchema } from "@shiba/shared";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { resolveWorkspaceNativeMember } from "./workspace-native-authority.js";
import { rejectCrossOriginMutation,rejectNonJsonMutation } from "./dashboard-mutation.js";
import { membershipSql,WorkspaceIntegrationError } from "./workspace-integrations-store.js";
import { reconciliationSession,reconciliationSessionGuard,reconciliationSessionExpiry } from "./founder-reconciliation-session.js";
import { createReconciliationSchedule,enableReconciliationSchedule,reduceReconciliationSchedule,listReconciliationSchedules,readReconciliationSchedule,scheduleAvailable,type ReconciliationScheduleEnv } from "./founder-reconciliation-schedule-store.js";
import { readReconciliationScheduledResult } from "./founder-reconciliation-schedule-runtime.js";
const pattern=/^\/api\/founder-reconciliation-schedules(?:\/(frs_[a-f0-9]{32})(?:\/(enable|pause|revoke|results\/(frr_[a-f0-9]{32})))?)?\/?$/;
const headers={"cache-control":"no-store","referrer-policy":"no-referrer","x-content-type-options":"nosniff"},json=(v:unknown,status=200)=>Response.json(v,{status,headers});
/** Human-only standing consent and private reads; cron has no human session. */
export async function handleFounderReconciliationSchedules(request:Request,env:ReconciliationScheduleEnv):Promise<Response|null>{const url=new URL(request.url),match=pattern.exec(url.pathname);if(!match)return null;if(!request.headers.has("X-Shiba-Workspace")||url.search)return json({error:"reconciliation_schedule_workspace_required"},400);if(request.method!=="GET"){const denied=rejectCrossOriginMutation(request)??rejectNonJsonMutation(request);if(denied)return denied;}
 const auth=await resolveOrgForApiRequest(request,env);if(auth instanceof Response)return auth;if(auth.principal||!auth.workspace||auth.workspace.role==="member")return json({error:"reconciliation_schedule_native_manager_required"},403);const member=await resolveWorkspaceNativeMember(request,env,auth.workspace);if(!member)return json({error:"reconciliation_schedule_native_manager_required"},403);const scoped=(v:Record<string,unknown>,status=200)=>json({...v,workspaceId:member.workspaceId,actorId:member.userId},status),session=await reconciliationSession(request,env,member);if(!session)return scoped({error:"reconciliation_schedule_native_session_required"},403);
 try{const id=match[1],action=match[2],resultId=match[3],actor=membershipSql(member,true),native=reconciliationSessionGuard(session,member);let proofSql=`SELECT s.expiresAt AS session_expires FROM "session" s WHERE s.id=? AND s.userId=? AND ${actor.sql} AND ${native.sql}`,proofValues:unknown[]=[session.id,member.accountId,...actor.values,...native.values],leaseExpiresAt=session.expiresAt,payload:Record<string,unknown>={},status=200,requiresSources=false;
 if(request.method==="GET"){
  if(!id){let available=true;try{scheduleAvailable(env);}catch{available=false;}payload={available,schedules:await listReconciliationSchedules(env,member)};}
  else if(resultId){const result=await readReconciliationScheduledResult(env,member,id,resultId,session);({proofSql,proofValues}=result);leaseExpiresAt=Math.min(leaseExpiresAt,result.leaseExpiresAt);requiresSources=true;payload={report:result.report,digest:result.digest};}
  else if(!action){const result=await readReconciliationSchedule(env,member,id,session);({proofSql,proofValues}=result);leaseExpiresAt=Math.min(leaseExpiresAt,result.leaseExpiresAt);requiresSources=true;payload={schedule:result.schedule,results:result.results};}
  else return scoped({error:"method_not_allowed"},405);
 }else if(request.method==="POST"){
  let body:unknown;try{body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await boundedBody(request.body,8192)));}catch{return scoped({error:"reconciliation_schedule_request_invalid"},400);}
  if(!id){const result=await createReconciliationSchedule(env,member,body,session);({proofSql,proofValues}=result);leaseExpiresAt=Math.min(leaseExpiresAt,result.leaseExpiresAt);requiresSources=true;payload={schedule:result.schedule};status=201;}
  else if(action==="enable"){const input=founderReconciliationScheduleDecisionSchema.parse(body),result=await enableReconciliationSchedule(env,member,id,input.digest,session);({proofSql,proofValues}=result);leaseExpiresAt=Math.min(leaseExpiresAt,result.leaseExpiresAt);requiresSources=true;payload={schedule:result.schedule};}
  else if(action==="pause"||action==="revoke"){const input=founderReconciliationScheduleReductionSchema.parse(body);payload={schedule:await reduceReconciliationSchedule(env,member,id,input.digest,action,session)};}
  else return scoped({error:"method_not_allowed"},405);
 }else return scoped({error:"method_not_allowed"},405);
 const current=await env.AGENT_AUDIT.prepare(proofSql).bind(...proofValues).first<{session_expires:string|number}>(),expiry=current?reconciliationSessionExpiry(current.session_expires):NaN;if(!current||!Number.isFinite(expiry)||Date.now()>=Math.min(leaseExpiresAt,expiry))return scoped({error:"reconciliation_schedule_authority_changed"},403);if(requiresSources)scheduleAvailable(env);return scoped(payload,status);
 }catch(error){if(error instanceof z.ZodError)return scoped({error:"reconciliation_schedule_request_invalid"},400);if(error instanceof WorkspaceIntegrationError)return scoped({error:error.code},error.status);return scoped({error:"reconciliation_schedules_unavailable"},503);}}
