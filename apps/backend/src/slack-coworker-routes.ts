import { z } from "zod";
import { slackCoworkerSubmissionSelectionSchema, slackCoworkerSubmissionDecisionSchema } from "@shiba/shared";
import { resolveBetterAuthSessionAccount } from "@shiba/auth/better-auth";
import type { SlackInstallationEnv } from "./slack-installations-store.js";
import { getSlackInstallation, activeSlackInstallationForTeam } from "./slack-installations-store.js";
import { SlackInstallationError } from "./slack-installations-crypto.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { resolveWorkspaceNativeMember } from "./workspace-native-authority.js";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "./dashboard-mutation.js";
import { beginSlackCoworkerBinding, confirmSlackCoworkerBinding, readSlackCoworkerState, revokeSlackCoworkerBinding, grantSlackCoworkerIntake, readSlackCoworkerDrafts, adoptSlackCoworkerDraft, revokeSlackCoworkerIntake } from "./slack-coworker-store.js";
import { handleCollaboration } from "./collaboration-routes.js";
import { prepareSlackCoworkerSubmission, claimSlackCoworkerSubmission, finishSlackCoworkerSubmission, readSlackCoworkerSubmission, listSlackCoworkerSubmissions } from "./slack-coworker-execution.js";
import { redactSecrets } from "./security.js";
const base="/api/slack/coworker";
const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store","referrer-policy":"no-referrer"}});
async function readBody(request:Request) {
  const reader=request.body?.getReader(); if(!reader)throw new SlackInstallationError("slack_coworker_invalid",400);
  const bytes=new Uint8Array(4096);let used=0;
  try { for (;;) { const part=await reader.read();if(part.done)break;if(used+part.value.length>bytes.length)throw new SlackInstallationError("slack_coworker_invalid",400);bytes.set(part.value,used);used+=part.value.length; }
    return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,used)));
  } finally {await reader.cancel().catch(()=>{});}
}
export async function handleSlackCoworker(request:Request,env:SlackInstallationEnv):Promise<Response|null> {
  const url=new URL(request.url); if(url.pathname!==base&&!url.pathname.startsWith(base+"/"))return null;
  try {
    const managedEnabled=env.SLACK_INSTALLATIONS_ENABLED?.trim()==="true";
    const ownerReceiptAccess=(request.method==='GET'&&(url.pathname===base+'/drafts/submissions'||url.pathname===base+'/drafts/submission'))||
      (request.method==='POST'&&url.pathname===base+'/drafts/status/revoke');
    if(!managedEnabled&&!ownerReceiptAccess)throw new SlackInstallationError("slack_coworker_unavailable",503);
    if(!request.headers.has("X-Shiba-Workspace")||request.headers.has("authorization")||url.searchParams.has("workspaceId"))throw new SlackInstallationError("slack_coworker_native_required",403);
    if(request.method!=="GET") { const blocked=rejectCrossOriginMutation(request)??rejectNonJsonMutation(request); if(blocked)return blocked; }
    const auth=await resolveOrgForApiRequest(request,env,{allowMemberWrite:true});
    if(auth instanceof Response||!auth.workspace||auth.principal||auth.orgId!==`team:${auth.workspace.workspaceId}`)throw new SlackInstallationError("slack_coworker_native_required",403);
    const member=await resolveWorkspaceNativeMember(request,env,auth.workspace);if(!member)throw new SlackInstallationError("slack_coworker_native_required",403);
    const verify=async()=>{request.signal.throwIfAborted();const current=await resolveOrgForApiRequest(request,env,{allowMemberWrite:true});
      if(current instanceof Response||!current.workspace||current.principal||current.orgId!==`team:${member.workspaceId}`)throw new SlackInstallationError("slack_coworker_native_required",403);
      const native=await resolveWorkspaceNativeMember(request,env,current.workspace);
      if(!native||native.accountId!==member.accountId||native.userId!==member.userId||native.workspaceId!==member.workspaceId||native.version!==member.version||native.role!==member.role)throw new SlackInstallationError("slack_coworker_native_required",403);
      request.signal.throwIfAborted();};
    const executionSession=async()=>{
      if(!request.headers.has('cookie'))throw new SlackInstallationError('slack_coworker_native_session_required',403);
      const account=await resolveBetterAuthSessionAccount(request,env,redactSecrets);
      if(!account?.emailVerified||!account.sessionId||!account.sessionExpiresAt||account.sessionExpiresAt<=Date.now()||account.policy.accountId!==member.accountId||account.policy.email!==member.userId)throw new SlackInstallationError('slack_coworker_native_session_required',403);
      return{id:account.sessionId,expiresAt:account.sessionExpiresAt};
    };
    if(request.method==="GET"&&url.pathname===base){await verify();return json(await readSlackCoworkerState(env,member));}
    if(request.method==="GET"&&url.pathname===base+"/drafts"){await verify();return json({drafts:await readSlackCoworkerDrafts(env,member)});}
    if(request.method==='GET'&&url.pathname===base+'/drafts/submissions'){
      if(url.search)throw new SlackInstallationError('slack_coworker_invalid',400);
      const session=await executionSession();await verify();
      return json({ok:true,workspaceId:member.workspaceId,actorId:member.userId,submissions:await listSlackCoworkerSubmissions(env,member,session)});
    }
    if(request.method==='GET'&&url.pathname===base+'/drafts/submission'){
      if(url.searchParams.getAll('id').length!==1||[...url.searchParams.keys()].some(key=>key!=='id')||!/^sd_[a-f0-9]{32}$/.test(url.searchParams.get('id')??''))throw new SlackInstallationError('slack_coworker_invalid',400);
      const session=await executionSession();await verify();
      return json({ok:true,workspaceId:member.workspaceId,actorId:member.userId,...await readSlackCoworkerSubmission(env,member,session,url.searchParams.get('id')!),...(!managedEnabled?{preview:null,sourceAvailable:false}:{})});
    }
    if(request.method!=="POST")return json({error:"method_not_allowed"},405);
    const body=await readBody(request);
    if(url.pathname===base+'/drafts/prepare-submission'){
      if(url.search)throw new SlackInstallationError('slack_coworker_invalid',400);
      const value=slackCoworkerSubmissionSelectionSchema.parse(body),session=await executionSession();await verify();
      const prepared=await prepareSlackCoworkerSubmission(env,request,member,session,value);await verify();
      const current=await readSlackCoworkerSubmission(env,member,session,value.id);
      if(!current.preview||current.preview.previewId!==prepared.previewId)throw new SlackInstallationError('slack_coworker_submission_changed',409);
      return json({ok:true,workspaceId:member.workspaceId,actorId:member.userId,preview:current.preview});
    }
    if(url.pathname===base+'/drafts/status/revoke'){
      if(url.search)throw new SlackInstallationError('slack_coworker_invalid',400);
      const value=z.strictObject({previewId:z.string().regex(/^scp_[a-f0-9]{32}$/),reviewed:z.literal(true)}).parse(body);
      const session=await executionSession();await verify();
      const row=await env.AGENT_AUDIT.prepare('SELECT draft_id FROM slack_coworker_execution_v2 WHERE id=? AND workspace_id=? AND account_id=?').bind(value.previewId,member.workspaceId,member.accountId).first<{draft_id:string}>();
      if(!row)throw new SlackInstallationError('slack_coworker_submission_unavailable',404);
      const state=await readSlackCoworkerSubmission(env,member,session,row.draft_id);
      if(state.receipt?.previewId!==value.previewId)throw new SlackInstallationError('slack_coworker_submission_unavailable',404);
      await (await import('./slack-coworker-private-status.js')).revokeSlackCoworkerPrivateStatus(env,member,value.previewId);
      await verify();return json({ok:true,workspaceId:member.workspaceId,actorId:member.userId});
    }
    if(url.pathname===base+"/intake/grant"){const value=z.object({bindingId:id,channelId:id,threadTs:z.string().regex(/^\d{1,16}\.\d{1,9}$/),reviewed:z.literal(true)}).strict().parse(body);await verify();return json(await grantSlackCoworkerIntake(env,member,value.bindingId,value.channelId,value.threadTs));}
    if(url.pathname===base+"/intake/revoke"){const value=z.object({id,reviewed:z.literal(true)}).strict().parse(body);await verify();await revokeSlackCoworkerIntake(env,member,value.id);return json({ok:true});}
    if(url.pathname===base+"/drafts/submit") {
      if(url.search)throw new SlackInstallationError('slack_coworker_invalid',400);
      const value=slackCoworkerSubmissionDecisionSchema.parse(body),session=await executionSession();await verify();
      const claimed=await claimSlackCoworkerSubmission(env,request,member,session,value);
      let outcome:'queued'|'blocked'|'unknown'='unknown';
      try {
        await verify();
        const response=await handleCollaboration(claimed.request,env);
        outcome=response?.status===201?'queued':!response||response.status>=500||response.status===202?'unknown':'blocked';
      } catch {
        outcome='unknown';
      }
      await finishSlackCoworkerSubmission(env,claimed.handoffId,outcome);await verify();
      const state=await readSlackCoworkerSubmission(env,member,session,`sd_${claimed.handoffId.slice(4)}`);
      if(!state.receipt)throw new SlackInstallationError('slack_coworker_submission_changed',409);
      return json({ok:true,workspaceId:member.workspaceId,actorId:member.userId,receipt:state.receipt},outcome==='queued'?201:outcome==='blocked'?409:503);
    }
    if(url.pathname===base+"/drafts/adopt"){const value=z.object({id,reviewed:z.literal(true)}).strict().parse(body);await verify();return json(await adoptSlackCoworkerDraft(env,member,value.id));}
    if(url.pathname===base+"/revoke") {const value=z.object({id,reviewed:z.literal(true)}).strict().parse(body);await verify();await revokeSlackCoworkerBinding(env,member,value.id);return json({ok:true});}
    const value=z.object({installationId:id,challengeId:id.optional(),slackUserId:id.optional(),reviewed:z.literal(true)}).strict().parse(body);
    const row=await getSlackInstallation(env,value.installationId);
    if(!row||row.workspace_id!==member.workspaceId)throw new SlackInstallationError("slack_coworker_unavailable",403);
    const installation=await activeSlackInstallationForTeam(env,row.app_id,row.team_id);if(!installation||installation.id!==row.id)throw new SlackInstallationError("slack_coworker_unavailable",403);
    await verify();
    if(url.pathname===base+"/begin"&&!value.challengeId&&!value.slackUserId)return json(await beginSlackCoworkerBinding(env,member,installation));
    if(url.pathname===base+"/confirm"&&value.challengeId&&value.slackUserId)return json(await confirmSlackCoworkerBinding(env,member,installation,value.challengeId,value.slackUserId));
    return json({error:"not_found"},404);
  }catch(error){if(error instanceof SlackInstallationError)return json({error:error.code},error.status);if(error instanceof z.ZodError||error instanceof SyntaxError)return json({error:"slack_coworker_invalid"},400);return json({error:"slack_coworker_unavailable"},503);}
}
