import { z } from "zod";
import type { SlackInstallationEnv } from "./slack-installations-store.js";
import { getSlackInstallation, activeSlackInstallationForTeam } from "./slack-installations-store.js";
import { SlackInstallationError } from "./slack-installations-crypto.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { resolveWorkspaceNativeMember } from "./workspace-native-authority.js";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "./dashboard-mutation.js";
import { beginSlackCoworkerBinding, confirmSlackCoworkerBinding, readSlackCoworkerState, revokeSlackCoworkerBinding, grantSlackCoworkerIntake, readSlackCoworkerDrafts, adoptSlackCoworkerDraft, revokeSlackCoworkerIntake } from "./slack-coworker-store.js";
import { handleCollaboration } from "./collaboration-routes.js";
import { claimSlackCoworkerExecution, finishSlackCoworkerExecution } from "./slack-coworker-store.js";
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
    if(env.SLACK_INSTALLATIONS_ENABLED?.trim()!=="true")throw new SlackInstallationError("slack_coworker_unavailable",503);
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
    if(request.method==="GET"&&url.pathname===base){await verify();return json(await readSlackCoworkerState(env,member));}
    if(request.method==="GET"&&url.pathname===base+"/drafts"){await verify();return json({drafts:await readSlackCoworkerDrafts(env,member)});}
    if(request.method!=="POST")return json({error:"method_not_allowed"},405);
    const body=await readBody(request);
    if(url.pathname===base+"/intake/grant"){const value=z.object({bindingId:id,channelId:id,threadTs:z.string().regex(/^\d{1,16}\.\d{1,9}$/),reviewed:z.literal(true)}).strict().parse(body);await verify();return json(await grantSlackCoworkerIntake(env,member,value.bindingId,value.channelId,value.threadTs));}
    if(url.pathname===base+"/intake/revoke"){const value=z.object({id,reviewed:z.literal(true)}).strict().parse(body);await verify();await revokeSlackCoworkerIntake(env,member,value.id);return json({ok:true});}
    if(url.pathname===base+"/drafts/submit") {
      const value=z.object({id:z.string().regex(/^sd_[a-f0-9]{32}$/),roomId:z.string().regex(/^room_[a-f0-9]{24}$/),
        recipientActorId:z.string().regex(/^agent:[A-Za-z0-9_-]{1,100}$/),
        personalExecution:z.object({grantId:z.string().regex(/^plex_[a-f0-9]{32}$/),expectedVersion:z.number().int().positive()}).strict(),
        reviewed:z.literal(true)}).strict().parse(body);
      await verify();
      const claimed=await claimSlackCoworkerExecution(env,member,value);
      try {
        await verify();
        const target=new URL(`/api/collaboration/rooms/${value.roomId}/handoffs`,request.url);
        const response=await handleCollaboration(new Request(target,{method:"POST",headers:request.headers,signal:request.signal,
          body:JSON.stringify({handoffId:claimed.handoffId,taskId:claimed.handoffId,task:claimed.task,
            recipientActorId:value.recipientActorId,personalExecution:value.personalExecution,budget:0,grantedCapabilities:["room.read","message.send"]})}),env);
        const state=response?.status===201?"queued":!response||response.status>=500||response.status===202?"unknown":"blocked";
        await finishSlackCoworkerExecution(env,claimed.handoffId,state);
        // The queue's response can contain private task text; return only the receipt.
        return json({handoffId:claimed.handoffId,state,approvalRequired:true},response?.status??503);
      } catch {
        await finishSlackCoworkerExecution(env,claimed.handoffId,"unknown");
        return json({handoffId:claimed.handoffId,state:"unknown",approvalRequired:true},503);
      }
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
