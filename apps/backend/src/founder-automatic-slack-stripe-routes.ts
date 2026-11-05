import { z } from 'zod';
import { stripeSlackPrepareSchema, stripeSlackDecisionSchema, stripeSlackDisclosureSchema } from '@shiba/shared';
import { resolveOrgForApiRequest } from './org-request-auth.js';
import { resolveWorkspaceNativeMember } from './workspace-native-authority.js';
import { rejectCrossOriginMutation, rejectNonJsonMutation } from './dashboard-mutation.js';
import { membershipSql, WorkspaceIntegrationError } from './workspace-integrations-store.js';
import { listReportSlackDestinations, reportSlackDestinationGuard } from './report-slack-store.js';
import { automaticSlackApprover, ensureAutomaticSlackSchema, packAutomaticSlackGuard } from './founder-automatic-slack-store.js';
import { resolveStripeHumanSession, stripeSessionGuard, stripeSessionExpiry } from './founder-stripe-session.js';
import { prepareStripeSlack, readStripeSlackGrant, stripeSlackAvailable, stripeSlackView, transitionStripeSlack, stripeSlackGrantGuard, stripeSlackRowGuard, stripeSlackPin, stripeSlackLink, assertStripeSlackDigest, type StripeSlackGrantRow } from './founder-automatic-slack-stripe-store.js';
import type { StripeEnv } from './founder-stripe-store.js';
const base='/api/founder-stripe-slack';
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'}});
async function body(request:Request){const reader=request.body?.getReader(),bytes=new Uint8Array(8192);let used=0;try{if(!reader)throw new Error();for(;;){const p=await reader.read();if(p.done)break;if(used+p.value.length>bytes.length)throw new Error();bytes.set(p.value,used);used+=p.value.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,used)));}finally{await reader?.cancel().catch(()=>{});}}
/** Native-cookie decision path. It never performs a Stripe read or sends a Slack message. */
export async function handleFounderStripeAutomaticSlack(request:Request,env:StripeEnv):Promise<Response|null>{
 const url=new URL(request.url);if(url.pathname!==base&&!url.pathname.startsWith(base+'/'))return null;
 try{
  if(url.search||!request.headers.has('X-Shiba-Workspace')||request.headers.has('authorization'))return json({error:'workspace_selector_required'},403);
  if(request.method!=='GET'){const blocked=rejectCrossOriginMutation(request)??rejectNonJsonMutation(request);if(blocked)return blocked;}
  const auth=await resolveOrgForApiRequest(request,env);if(auth instanceof Response)return auth;if(auth.principal||!auth.workspace||auth.workspace.role==='member')return json({error:'automatic_slack_native_manager_required'},403);
  const member=await resolveWorkspaceNativeMember(request,env,auth.workspace);if(!member)return json({error:'automatic_slack_native_manager_required'},403);
  const session=await resolveStripeHumanSession(request,env,member);if(!session)return json({error:'stripe_native_session_required'},403);
  const verify=async()=>{request.signal.throwIfAborted();const latest=await resolveOrgForApiRequest(request,env);if(latest instanceof Response||!latest.workspace||latest.principal)throw new WorkspaceIntegrationError('automatic_slack_authority_changed',403);const m=await resolveWorkspaceNativeMember(request,env,latest.workspace),s=m?await resolveStripeHumanSession(request,env,m):null;if(!m||!s||m.accountId!==member.accountId||m.userId!==member.userId||m.workspaceId!==member.workspaceId||m.version!==member.version||m.role!==member.role||s.id!==session.id||s.expiresAt!==session.expiresAt)throw new WorkspaceIntegrationError('automatic_slack_authority_changed',403);request.signal.throwIfAborted();};
  await ensureAutomaticSlackSchema(env);
  const match=/^\/api\/founder-stripe-slack(?:\/(assg_[a-f0-9]{32})(?:\/(disclose|approve|pause|revoke))?)?\/?$/.exec(url.pathname);if(!match)return json({error:'not_found'},404);
  const id=match[1],action=match[2] as 'disclose'|'approve'|'pause'|'revoke'|undefined;
  if(request.method==='GET'&&!id){
   const links=stripeSlackAvailable(env)?(await listReportSlackDestinations(env,member)).filter(l=>l.destination.installation?.ownerAccountId===member.accountId).slice(0,10):[];
   const rows=await env.AGENT_AUDIT.prepare("SELECT * FROM founder_stripe_slack_grants WHERE workspace_id=? AND (owner_account_id=? OR state IN ('disclosed','enabled','paused','exhausted')) ORDER BY created_at DESC LIMIT 20").bind(member.workspaceId,member.accountId).all<StripeSlackGrantRow>();
   const candidates:StripeSlackGrantRow[]=[];for(const row of rows.results){if(row.owner_account_id!==member.accountId&&!automaticSlackApprover(env,member))continue;try{await assertStripeSlackDigest(row);candidates.push(row);}catch{/* Changed grants cannot be reviewed. */}}
   await verify();const actor=membershipSql(member,true),sessionProof=stripeSessionGuard(session,member),queries=[`SELECT 'actor' AS kind,'' AS id,(SELECT expiresAt FROM "session" WHERE id=? AND userId=?) AS session_expires WHERE ${actor.sql} AND ${sessionProof.sql}`],values:unknown[]=[session.id,member.accountId,...actor.values,...sessionProof.values];
   for(const link of links){const guard=packAutomaticSlackGuard(reportSlackDestinationGuard(env,member,link,member));queries.push(`SELECT 'link' AS kind,? AS id,NULL AS session_expires WHERE ${guard.sql}`);values.push(link.destination.linkId,...guard.values);}
   for(const row of candidates){const scope=stripeSlackGrantGuard(env,row,member,row.approver_json!==null),snapshot=stripeSlackRowGuard(row),guard=packAutomaticSlackGuard({sql:`${scope.sql} AND ${snapshot.sql} AND EXISTS(SELECT 1 FROM founder_stripe_slack_grants WHERE id=? AND state=? AND used_sends=? AND approver_json IS ?)`,values:[...scope.values,...snapshot.values,row.id,row.state,row.used_sends,row.approver_json]});queries.push(`SELECT 'grant' AS kind,? AS id,NULL AS session_expires WHERE ${guard.sql}`);values.push(row.id,...guard.values);}
   const final=await env.AGENT_AUDIT.prepare(queries.join(' UNION ALL ')).bind(...values).all<{kind:string;id:string;session_expires:string|number|null}>();const current=final.results.find(x=>x.kind==='actor'),dbExpiry=current?.session_expires==null?NaN:stripeSessionExpiry(current.session_expires),now=Date.now();if(!current||!Number.isFinite(dbExpiry)||now>=Math.min(session.expiresAt,dbExpiry))return json({error:'automatic_slack_authority_changed'},403);
   const available=stripeSlackAvailable(env),allowed=new Set(final.results.filter(x=>x.kind==='link').map(x=>x.id)),ids=new Set(final.results.filter(x=>x.kind==='grant').map(x=>x.id));
   const destinations=available?links.filter(l=>allowed.has(l.destination.linkId)&&(l.destination.installation?.expiresAt==null||now<l.destination.installation.expiresAt)).map(l=>l.destination):[];
   const grants=available?candidates.filter(row=>ids.has(row.id)&&now<Math.min(row.expires_at,stripeSlackPin(row).expires_at,stripeSlackLink(row).destination.installation?.expiresAt??Number.MAX_SAFE_INTEGER)&&(row.owner_account_id===member.accountId||automaticSlackApprover(env,member))&&(!row.approver_json||automaticSlackApprover(env,JSON.parse(row.approver_json)))).map(row=>row.id):[];
   return json({workspaceId:member.workspaceId,actorId:member.userId,available,destinations,grants});
  }
  if(request.method==='GET'&&id&&!action){const row=await readStripeSlackGrant(env,member,id);return json({workspaceId:member.workspaceId,actorId:member.userId,grant:await stripeSlackView(env,member,row,verify,session)});}
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);const input=await body(request);
  if(!id){const newId=await prepareStripeSlack(env,member,stripeSlackPrepareSchema.parse(input),verify,session),row=await readStripeSlackGrant(env,member,newId);return json({workspaceId:member.workspaceId,actorId:member.userId,grant:await stripeSlackView(env,member,row,verify,session)});}
  if(!action)return json({error:'not_found'},404);
  const decision=(action==='disclose'?stripeSlackDisclosureSchema:stripeSlackDecisionSchema).parse(input);await transitionStripeSlack(env,member,id,action,decision,verify,session);
  const row=await readStripeSlackGrant(env,member,id);return json({workspaceId:member.workspaceId,actorId:member.userId,grant:await stripeSlackView(env,member,row,verify,session)});
 }catch(e){if(e instanceof WorkspaceIntegrationError)return json({error:e.code},e.status);if(e instanceof z.ZodError||e instanceof SyntaxError)return json({error:'automatic_slack_request_invalid'},400);return json({error:'automatic_slack_unavailable'},503);}
}
