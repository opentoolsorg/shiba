import { z } from "zod";
import { boundedBody } from "@shiba/openconnector-read-gateway";
import { founderReconciliationDecisionSchema } from "@shiba/shared";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { resolveWorkspaceNativeMember } from "./workspace-native-authority.js";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "./dashboard-mutation.js";
import { membershipSql, WorkspaceIntegrationError } from "./workspace-integrations-store.js";
import { reconciliationSession, reconciliationSessionGuard, reconciliationSessionExpiry } from "./founder-reconciliation-session.js";
import { stripeAvailable, type StripeEnv } from "./founder-stripe-store.js";
import { hubspotAvailable } from "./founder-hubspot-store.js";
import { FOUNDER_HUBSPOT_EXECUTOR_DIGEST } from "./founder-hubspot-generated.js";
import { createFounderReconciliation,listFounderReconciliations,composeFounderReconciliation,readFounderReconciliation,revokeFounderReconciliation } from "./founder-reconciliation-store.js";
const pattern=/^\/api\/founder-reconciliations(?:\/(frc_[a-f0-9]{32})(?:\/(compose|revoke|download))?)?\/?$/;
const headers={"cache-control":"no-store","referrer-policy":"no-referrer","x-content-type-options":"nosniff"};
const json=(v:unknown,status=200)=>Response.json(v,{status,headers});
const revoke=z.strictObject({digest:z.string().regex(/^[a-f0-9]{64}$/)});
/** Native manager privately composes reviewed, already-captured evidence. No provider or model calls. */
export async function handleFounderReconciliations(request:Request,env:StripeEnv):Promise<Response|null>{const url=new URL(request.url),match=pattern.exec(url.pathname);if(!match)return null;if(!request.headers.has("X-Shiba-Workspace")||url.search)return json({error:"reconciliation_workspace_required"},400);if(request.method!=="GET"){const denied=rejectCrossOriginMutation(request)??rejectNonJsonMutation(request);if(denied)return denied;}
 const auth=await resolveOrgForApiRequest(request,env);if(auth instanceof Response)return auth;if(auth.principal||!auth.workspace||auth.workspace.role==="member")return json({error:"reconciliation_native_manager_required"},403);const member=await resolveWorkspaceNativeMember(request,env,auth.workspace);if(!member)return json({error:"reconciliation_native_manager_required"},403);const scoped=(v:Record<string,unknown>,status=200)=>json({...v,workspaceId:member.workspaceId,actorId:member.userId},status);const session=await reconciliationSession(request,env,member);if(!session)return scoped({error:"reconciliation_native_session_required"},403);
 try{const id=match[1],action=match[2],actor=membershipSql(member,true),sessionGuard=reconciliationSessionGuard(session,member);let proofSql=`SELECT s.expiresAt AS session_expires FROM "session" s WHERE s.id=? AND s.userId=? AND ${actor.sql} AND ${sessionGuard.sql}`,proofValues:unknown[]=[session.id,member.accountId,...actor.values,...sessionGuard.values],leaseExpiresAt=session.expiresAt,payload:Record<string,unknown>={},status=200,download:string|null=null,requiresSources=false,expectedRuntime:{versionId:string;manifestDigest:string}|null=null;
  if(request.method==="GET"){
   if(!id){if(action)return scoped({error:"method_not_allowed"},405);const listed=await listFounderReconciliations(env,member,session);payload={drafts:listed.drafts};leaseExpiresAt=Math.min(leaseExpiresAt,listed.leaseExpiresAt);}
   else{if(action&&action!=="download")return scoped({error:"method_not_allowed"},405);const result=await readFounderReconciliation(env,member,id,session);({proofSql,proofValues}=result);leaseExpiresAt=Math.min(leaseExpiresAt,result.leaseExpiresAt);requiresSources=true;expectedRuntime={versionId:result.draft.sources.hubspot.runtimeVersionId,manifestDigest:result.draft.sources.hubspot.manifestDigest};if(action==="download"){if(!result.report)return scoped({error:"reconciliation_report_unavailable"},404);download=JSON.stringify(result.report);}else payload={draft:result.draft,report:result.report};}
  }else if(request.method==="POST"){
   let body:unknown;try{body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await boundedBody(request.body,8192)));}catch{return scoped({error:"reconciliation_request_invalid"},400);}
   if(!id){const result=await createFounderReconciliation(env,member,body,session);({proofSql,proofValues}=result);leaseExpiresAt=Math.min(leaseExpiresAt,result.leaseExpiresAt);requiresSources=true;expectedRuntime={versionId:result.draft.sources.hubspot.runtimeVersionId,manifestDigest:result.draft.sources.hubspot.manifestDigest};payload={draft:result.draft};status=201;}
   else if(action==="compose"){const input=founderReconciliationDecisionSchema.parse(body),result=await composeFounderReconciliation(env,member,id,input.digest,session);({proofSql,proofValues}=result);leaseExpiresAt=Math.min(leaseExpiresAt,result.leaseExpiresAt);requiresSources=true;expectedRuntime={versionId:result.draft.sources.hubspot.runtimeVersionId,manifestDigest:result.draft.sources.hubspot.manifestDigest};payload={draft:result.draft,report:result.report};}
   else if(action==="revoke")payload={draft:await revokeFounderReconciliation(env,member,id,revoke.parse(body).digest,session)};
   else return scoped({error:"method_not_allowed"},405);
  }else return scoped({error:"method_not_allowed"},405);
  // Final proof combines the exact requesting session and source/receipt snapshots in one query.
  const current=await env.AGENT_AUDIT.prepare(proofSql).bind(...proofValues).first<{session_expires:string|number}>();const currentExpiry=current?reconciliationSessionExpiry(current.session_expires):NaN;
  if(!current||!Number.isFinite(currentExpiry)||Date.now()>=Math.min(leaseExpiresAt,currentExpiry))return scoped({error:"reconciliation_authority_changed"},403);
  if(requiresSources){stripeAvailable(env);hubspotAvailable(env);if(!expectedRuntime||expectedRuntime.versionId!=="native-hubspot.v1"||expectedRuntime.manifestDigest!==FOUNDER_HUBSPOT_EXECUTOR_DIGEST)return scoped({error:"reconciliation_unavailable"},503);}
  if(download!==null)return new Response(download,{headers:{...headers,"content-type":"application/json; charset=utf-8","content-disposition":`attachment; filename="${id}.json"`}});
  return scoped(payload,status);
 }catch(error){if(error instanceof z.ZodError)return scoped({error:"reconciliation_request_invalid"},400);if(error instanceof WorkspaceIntegrationError)return scoped({error:error.code},error.status);return scoped({error:"reconciliation_unavailable"},503);}}
