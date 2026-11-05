import type { WorkspaceNativeMember } from "./workspace-native-authority.js";
import { slackInstallationGuard, type SlackInstallationEnv } from "./slack-installations-store.js";
import type { SlackInstallationSnapshot } from "@shiba/shared";
import { SlackInstallationError } from "./slack-installations-crypto.js";
import { personalExecutionEnabled } from "./personal-execution-store.js";

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const secretPattern = /^[a-f0-9]{64}$/;
const nowSql = "(CAST(strftime('%s','now') AS INTEGER)*1000)";
async function hash(value: string) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2,"0")).join(""); }
function memberGuard(m: WorkspaceNativeMember) {
  return { sql: `EXISTS(SELECT 1 FROM team_workspace_memberships m JOIN shiba_auth_account_policy p ON p.account_id=? JOIN "user" u ON u.id=p.account_id
    WHERE m.tenant_id='self-hosted' AND m.workspace_id=? AND m.user_id=? AND m.status='active' AND m.version=? AND m.role=? AND p.email=m.user_id AND lower(u.email)=m.user_id AND u.emailVerified=1)`,
    values: [m.accountId,m.workspaceId,m.userId,m.version,m.role] };
}
function fail(): never { throw new SlackInstallationError("slack_coworker_authority_changed", 403); }
/** Creates a one-use secret for a verified dashboard user, scoped to one active managed installation. */
export async function beginSlackCoworkerBinding(env: SlackInstallationEnv, member: WorkspaceNativeMember, installation: SlackInstallationSnapshot) {
  if (member.workspaceId !== installation.workspaceId || !installation.scopes.includes("commands")) fail();
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), b=>b.toString(16).padStart(2,"0")).join("");
  const id = `sc_${crypto.randomUUID().replaceAll("-","")}`, time=Date.now(), m=memberGuard(member), i=slackInstallationGuard(installation);
  const result=await env.AGENT_AUDIT.prepare(`INSERT INTO slack_coworker_challenges
    (id,secret_hash,workspace_id,account_id,actor_id,member_version,member_role,installation_id,app_id,team_id,generation,state,created_at,expires_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,'pending',?,? WHERE ${m.sql} AND ${i.sql}
    AND (SELECT count(*) FROM slack_coworker_challenges WHERE account_id=? AND state IN ('pending','observed','slack_confirmed') AND expires_at>${nowSql})<3
    AND (SELECT count(*) FROM slack_coworker_challenges WHERE account_id=?)<1000`)
    .bind(id,await hash(secret),member.workspaceId,member.accountId,member.userId,member.version,member.role,installation.id,installation.appId,installation.teamId,installation.generation,time,time+600_000,...m.values,...i.values,member.accountId,member.accountId).run();
  if(result.meta.changes!==1) fail();
  return { id, secret, expiresAt:time+600_000, teamId:installation.teamId };
}
/** Called only after raw Slack signature validation and managed installation resolution. */
export async function observeSlackCoworkerChallenge(env: SlackInstallationEnv, installation: SlackInstallationSnapshot, secret: string, slackUserId: string) {
  if(!installation.scopes.includes("commands")||!secretPattern.test(secret)||!idPattern.test(slackUserId)||slackUserId===installation.botUserId) return null;
  const i=slackInstallationGuard(installation);
  const result=await env.AGENT_AUDIT.prepare(`UPDATE slack_coworker_challenges SET state='observed',slack_user_id=?
    WHERE secret_hash=? AND state='pending' AND expires_at>${nowSql} AND workspace_id=? AND installation_id=? AND app_id=? AND team_id=? AND generation=? AND ${i.sql}`)
    .bind(slackUserId,await hash(secret),installation.workspaceId,installation.id,installation.appId,installation.teamId,installation.generation,...i.values).run();
  if(result.meta.changes!==1)return null;
  return env.AGENT_AUDIT.prepare(`SELECT id,workspace_id AS workspaceId,actor_id AS actorId,account_id AS accountId FROM slack_coworker_challenges WHERE secret_hash=? AND slack_user_id=? AND state='observed'`).bind(await hash(secret),slackUserId).first<{id:string;workspaceId:string;actorId:string;accountId:string}>();
}
export async function confirmSlackCoworkerOnSlack(env: SlackInstallationEnv, installation: SlackInstallationSnapshot, challengeId:string, slackUserId:string, accept:boolean) {
  if(!/^sc_[a-f0-9]{32}$/.test(challengeId)||!idPattern.test(slackUserId))return false;
  const i=slackInstallationGuard(installation);
  const r=await env.AGENT_AUDIT.prepare(`UPDATE slack_coworker_challenges SET state=? WHERE id=? AND slack_user_id=? AND state='observed' AND expires_at>${nowSql} AND installation_id=? AND app_id=? AND team_id=? AND generation=? AND ${i.sql} AND EXISTS(SELECT 1 FROM team_workspace_memberships m JOIN shiba_auth_account_policy p ON p.account_id=slack_coworker_challenges.account_id JOIN "user" u ON u.id=p.account_id WHERE m.tenant_id='self-hosted' AND m.workspace_id=slack_coworker_challenges.workspace_id AND m.user_id=slack_coworker_challenges.actor_id AND m.status='active' AND m.version=slack_coworker_challenges.member_version AND m.role=slack_coworker_challenges.member_role AND p.email=m.user_id AND lower(u.email)=m.user_id AND u.emailVerified=1)`).bind(accept?'slack_confirmed':'revoked',challengeId,slackUserId,installation.id,installation.appId,installation.teamId,installation.generation,...i.values).run();
  return r.meta.changes===1;
}
/** Confirmation is made by the same native session and names the Slack ID it reviewed. */
export async function confirmSlackCoworkerBinding(env: SlackInstallationEnv, member: WorkspaceNativeMember, installation: SlackInstallationSnapshot, id: string, slackUserId: string) {
  if(!/^sc_[a-f0-9]{32}$/.test(id)||!idPattern.test(slackUserId)||member.workspaceId!==installation.workspaceId) fail();
  const m=memberGuard(member),i=slackInstallationGuard(installation), bindingId=`sb_${crypto.randomUUID().replaceAll("-","")}`, time=Date.now();
  // Both statements execute in one D1 transaction; changes() ensures only the exact consumed challenge can create a binding.
  const result=await env.AGENT_AUDIT.batch([
    env.AGENT_AUDIT.prepare(`UPDATE slack_coworker_challenges SET state='consumed' WHERE id=? AND workspace_id=? AND account_id=? AND actor_id=? AND member_version=? AND member_role=? AND installation_id=? AND app_id=? AND team_id=? AND generation=? AND slack_user_id=? AND state='slack_confirmed' AND expires_at>${nowSql} AND ${m.sql} AND ${i.sql}`)
      .bind(id,member.workspaceId,member.accountId,member.userId,member.version,member.role,installation.id,installation.appId,installation.teamId,installation.generation,slackUserId,...m.values,...i.values),
    env.AGENT_AUDIT.prepare(`INSERT INTO slack_coworker_bindings(id,workspace_id,account_id,actor_id,member_version,member_role,installation_id,app_id,team_id,generation,slack_user_id,status,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,'active',? WHERE changes()=1`).bind(bindingId,member.workspaceId,member.accountId,member.userId,member.version,member.role,installation.id,installation.appId,installation.teamId,installation.generation,slackUserId,time),
  ]);
  if(result[1]?.meta.changes!==1) fail();
  return {id:bindingId,slackUserId,teamId:installation.teamId};
}
export async function revokeSlackCoworkerBinding(env: SlackInstallationEnv, member: WorkspaceNativeMember, id: string) {
  const m=memberGuard(member);
  const result=await env.AGENT_AUDIT.prepare(`UPDATE slack_coworker_bindings SET status='revoked',revoked_at=? WHERE id=? AND workspace_id=? AND account_id=? AND status='active' AND ${m.sql}`).bind(Date.now(),id,member.workspaceId,member.accountId,...m.values).run();
  if(result.meta.changes!==1) fail();
}
export async function readSlackCoworkerState(env: SlackInstallationEnv, member: WorkspaceNativeMember) {
  const m=memberGuard(member);
  const args=[member.workspaceId,member.accountId,member.version,member.role,...m.values];
  const row=await env.AGENT_AUDIT.prepare(`SELECT
   (SELECT json_group_array(json_object('id',id,'installationId',installation_id,'teamId',team_id,'slackUserId',slack_user_id,'state',state,'expiresAt',expires_at)) FROM
    (SELECT * FROM slack_coworker_challenges c WHERE workspace_id=? AND account_id=? AND member_version=? AND member_role=? AND state='slack_confirmed' AND expires_at>${nowSql} AND ${m.sql}
     AND EXISTS(SELECT 1 FROM slack_installations i WHERE i.id=c.installation_id AND i.workspace_id=c.workspace_id AND i.app_id=c.app_id AND i.team_id=c.team_id AND i.generation=c.generation AND i.state='active' AND i.token_cipher IS NOT NULL AND (i.token_expires_at IS NULL OR i.token_expires_at>${nowSql})) LIMIT 3)) AS challenges,
   (SELECT json_group_array(json_object('id',id,'installationId',installation_id,'teamId',team_id,'slackUserId',slack_user_id)) FROM
    (SELECT * FROM slack_coworker_bindings b WHERE workspace_id=? AND account_id=? AND member_version=? AND member_role=? AND status='active' AND ${m.sql}
     AND EXISTS(SELECT 1 FROM slack_installations i WHERE i.id=b.installation_id AND i.workspace_id=b.workspace_id AND i.app_id=b.app_id AND i.team_id=b.team_id AND i.generation=b.generation AND i.state='active' AND i.token_cipher IS NOT NULL AND (i.token_expires_at IS NULL OR i.token_expires_at>${nowSql})) LIMIT 16)) AS bindings,
   (SELECT json_group_array(json_object('id',id,'channelId',channel_id,'threadTs',thread_ts,'teamId',team_id,'expiresAt',expires_at)) FROM
    (SELECT g.id,g.channel_id,g.thread_ts,g.team_id,g.expires_at FROM slack_coworker_intake_grants g JOIN slack_coworker_bindings b ON b.id=g.binding_id AND b.status='active'
     JOIN slack_installations i ON i.id=g.installation_id AND i.workspace_id=g.workspace_id AND i.app_id=g.app_id AND i.team_id=g.team_id AND i.generation=g.generation AND i.state='active' AND i.token_cipher IS NOT NULL AND (i.token_expires_at IS NULL OR i.token_expires_at>${nowSql})
     WHERE g.workspace_id=? AND g.account_id=? AND b.member_version=? AND b.member_role=? AND g.status='active' AND g.expires_at>${nowSql} AND ${m.sql} LIMIT 16)) AS grants`).bind(...args,...args,...args).first<{challenges:string;bindings:string;grants:string}>();
  if(!row)fail();
  const executionAvailable=personalExecutionEnabled(env);
  return {challenges:JSON.parse(row.challenges),bindings:JSON.parse(row.bindings),grants:JSON.parse(row.grants),executionAvailable,...(!executionAvailable?{executionUnavailableReason:"personal_local_runtime_not_configured"}:{})};
}
const tsPattern=/^\d{1,16}\.\d{1,9}$/;
/** Explicitly authorizes only future self-authored app mentions at one exact Slack thread. */
export async function grantSlackCoworkerIntake(env:SlackInstallationEnv,member:WorkspaceNativeMember,bindingId:string,channelId:string,threadTs:string) {
  if(!idPattern.test(bindingId)||!idPattern.test(channelId)||!tsPattern.test(threadTs))fail();
  const m=memberGuard(member),now=Date.now(),id=`si_${crypto.randomUUID().replaceAll('-','')}`;
  const result=await env.AGENT_AUDIT.prepare(`INSERT INTO slack_coworker_intake_grants(id,binding_id,workspace_id,account_id,installation_id,app_id,team_id,generation,channel_id,thread_ts,expires_at,status,created_at)
    SELECT ?,b.id,b.workspace_id,b.account_id,b.installation_id,b.app_id,b.team_id,b.generation,?,?,?,'active',? FROM slack_coworker_bindings b
    JOIN slack_installations i ON i.id=b.installation_id AND i.workspace_id=b.workspace_id AND i.app_id=b.app_id AND i.team_id=b.team_id AND i.generation=b.generation AND i.state='active' AND i.token_cipher IS NOT NULL AND (i.token_expires_at IS NULL OR i.token_expires_at>${nowSql}) AND EXISTS(SELECT 1 FROM json_each(i.scopes_json) WHERE value='app_mentions:read')
    WHERE b.id=? AND b.workspace_id=? AND b.account_id=? AND b.actor_id=? AND b.member_version=? AND b.member_role=? AND b.status='active' AND ${m.sql}
    AND (SELECT count(*) FROM slack_coworker_intake_grants WHERE account_id=? AND status='active' AND expires_at>${nowSql})<16
    AND (SELECT count(*) FROM slack_coworker_intake_grants WHERE account_id=?)<1000`)
    .bind(id,channelId,threadTs,now+86_400_000,now,bindingId,member.workspaceId,member.accountId,member.userId,member.version,member.role,...m.values,member.accountId,member.accountId).run();
  if(result.meta.changes!==1)fail();return {id,channelId,threadTs,expiresAt:now+86_400_000};
}
/** Only a signed self-authored message matching a reviewed grant becomes a private draft. */
export async function intakeSlackCoworkerEvent(env:SlackInstallationEnv,installation:SlackInstallationSnapshot,eventId:string,event:{user?:unknown;channel?:unknown;ts?:unknown;thread_ts?:unknown;text?:unknown;subtype?:unknown;bot_id?:unknown}) {
  if(!idPattern.test(eventId)||typeof event.user!=='string'||!idPattern.test(event.user)||typeof event.channel!=='string'||!idPattern.test(event.channel)||typeof event.ts!=='string'||!tsPattern.test(event.ts)||typeof event.thread_ts!=='string'||!tsPattern.test(event.thread_ts)||typeof event.text!=='string'||!event.text.trim()||new TextEncoder().encode(event.text).length>4000||event.subtype!=null||event.bot_id!=null||event.user===installation.botUserId)return false;
  const i=slackInstallationGuard(installation), id=`sd_${crypto.randomUUID().replaceAll('-','')}`;
  const result=await env.AGENT_AUDIT.prepare(`INSERT OR IGNORE INTO slack_coworker_drafts(id,grant_id,workspace_id,account_id,app_id,team_id,channel_id,thread_ts,message_ts,event_id,slack_user_id,text,status,created_at)
    SELECT ?,g.id,g.workspace_id,g.account_id,g.app_id,g.team_id,g.channel_id,g.thread_ts,?,?,b.slack_user_id,?,'pending',? FROM slack_coworker_intake_grants g
    JOIN slack_coworker_bindings b ON b.id=g.binding_id AND b.status='active' AND b.installation_id=g.installation_id AND b.generation=g.generation
    JOIN team_workspace_memberships m ON m.tenant_id='self-hosted' AND m.workspace_id=b.workspace_id AND m.user_id=b.actor_id AND m.status='active' AND m.version=b.member_version AND m.role=b.member_role
    JOIN shiba_auth_account_policy p ON p.account_id=b.account_id AND p.email=b.actor_id JOIN "user" u ON u.id=p.account_id AND lower(u.email)=b.actor_id AND u.emailVerified=1
    WHERE g.installation_id=? AND g.app_id=? AND g.team_id=? AND g.generation=? AND g.channel_id=? AND g.thread_ts=? AND b.slack_user_id=? AND g.status='active' AND g.expires_at>${nowSql} AND CAST(? AS REAL)*1000>=g.created_at AND ${i.sql}
    AND NOT EXISTS(SELECT 1 FROM slack_coworker_invalidated_messages x WHERE x.app_id=g.app_id AND x.team_id=g.team_id AND x.channel_id=g.channel_id AND x.message_ts=?)
    AND (SELECT count(*) FROM slack_coworker_drafts d WHERE d.account_id=g.account_id AND d.status='pending')<100
    AND (SELECT count(*) FROM slack_coworker_drafts d WHERE d.account_id=g.account_id)<1000 LIMIT 1`)
    .bind(id,event.ts,eventId,event.text,Date.now(),installation.id,installation.appId,installation.teamId,installation.generation,event.channel,event.thread_ts,event.user,event.ts,...i.values,event.ts).run();
  return result.meta.changes===1;
}
/** A signed edit/delete destroys the original draft; the replacement is never imported. */
export async function invalidateSlackCoworkerMessage(env:SlackInstallationEnv,installation:SlackInstallationSnapshot,channel:string,messageTs:string) {
  if(!idPattern.test(channel)||!tsPattern.test(messageTs))return;
  await env.AGENT_AUDIT.batch([
    env.AGENT_AUDIT.prepare(`INSERT OR IGNORE INTO slack_coworker_invalidated_messages(app_id,team_id,channel_id,message_ts,created_at)
      SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM slack_coworker_invalidated_messages WHERE app_id=? AND team_id=?)<10000
      AND EXISTS(SELECT 1 FROM slack_coworker_intake_grants WHERE app_id=? AND team_id=? AND channel_id=? AND status='active' AND CAST(? AS REAL)*1000>=created_at)`)
      .bind(installation.appId,installation.teamId,channel,messageTs,Date.now(),installation.appId,installation.teamId,installation.appId,installation.teamId,channel,messageTs),
    env.AGENT_AUDIT.prepare(`UPDATE slack_coworker_intake_grants SET status='revoked' WHERE app_id=? AND team_id=? AND status='active' AND (SELECT count(*) FROM slack_coworker_invalidated_messages WHERE app_id=? AND team_id=?)>=10000`)
      .bind(installation.appId,installation.teamId,installation.appId,installation.teamId),
    env.AGENT_AUDIT.prepare(`UPDATE slack_coworker_drafts SET status='invalidated',text='' WHERE app_id=? AND team_id=? AND channel_id=? AND message_ts=? AND status='pending'`).bind(installation.appId,installation.teamId,channel,messageTs),
  ]);
}
export function slackCoworkerDraftGuard(member:WorkspaceNativeMember) {
 const m=memberGuard(member);
 return {sql:`d.workspace_id=? AND d.account_id=? AND d.status='pending' AND ${m.sql}
  AND EXISTS(SELECT 1 FROM slack_coworker_intake_grants g JOIN slack_coworker_bindings b ON b.id=g.binding_id
    JOIN slack_installations i ON i.id=g.installation_id AND i.workspace_id=g.workspace_id AND i.app_id=g.app_id AND i.team_id=g.team_id AND i.generation=g.generation
    WHERE g.id=d.grant_id AND g.status='active' AND g.expires_at>${nowSql} AND b.status='active' AND b.account_id=? AND b.actor_id=? AND b.member_version=? AND b.member_role=?
    AND i.state='active' AND i.token_cipher IS NOT NULL AND (i.token_expires_at IS NULL OR i.token_expires_at>${nowSql}))`,
  values:[member.workspaceId,member.accountId,...m.values,member.accountId,member.userId,member.version,member.role]};
}
export async function readSlackCoworkerDrafts(env:SlackInstallationEnv,member:WorkspaceNativeMember) {
 const g=slackCoworkerDraftGuard(member);
 return (await env.AGENT_AUDIT.prepare(`SELECT d.id,d.text,d.channel_id AS channelId,d.thread_ts AS threadTs,d.message_ts AS messageTs,d.team_id AS teamId,d.slack_user_id AS slackUserId,d.event_id AS eventId FROM slack_coworker_drafts d WHERE ${g.sql} ORDER BY d.created_at DESC LIMIT 100`).bind(...g.values).all()).results;
}
/** Adoption copies the statement into a native composer; it never queues, approves or executes work. */
export async function adoptSlackCoworkerDraft(env:SlackInstallationEnv,member:WorkspaceNativeMember,id:string) {
 if(!/^sd_[a-f0-9]{32}$/.test(id))fail();
 const g=slackCoworkerDraftGuard(member);
 const row=await env.AGENT_AUDIT.prepare(`SELECT d.id,d.text,d.channel_id AS channelId,d.thread_ts AS threadTs,d.message_ts AS messageTs,d.team_id AS teamId,d.slack_user_id AS slackUserId,d.event_id AS eventId FROM slack_coworker_drafts d WHERE d.id=? AND ${g.sql}`).bind(id,...g.values).first<{id:string;text:string}>();
 if(!row)fail();
 const update=await env.AGENT_AUDIT.prepare(`UPDATE slack_coworker_drafts AS d SET status='adopted',text='' WHERE d.id=? AND d.text=? AND ${g.sql}`).bind(id,row.text,...g.values).run();
 if(update.meta.changes!==1)fail();return row;
}
export async function revokeSlackCoworkerIntake(env:SlackInstallationEnv,member:WorkspaceNativeMember,id:string) {
 const m=memberGuard(member),r=await env.AGENT_AUDIT.prepare(`UPDATE slack_coworker_intake_grants SET status='revoked' WHERE id=? AND workspace_id=? AND account_id=? AND status='active' AND ${m.sql}`).bind(id,member.workspaceId,member.accountId,...m.values).run();if(r.meta.changes!==1)fail();
}

export interface SlackCoworkerExecutionSelection {
  id: string;
  roomId: string;
  recipientActorId: string;
  personalExecution: { grantId: string; expectedVersion: number };
  reviewed: true;
}
interface SlackExecutionReceipt {
  handoff_id: string; draft_id: string; workspace_id: string; account_id: string;
  member_json: string; selection_json: string; state: string;
}
async function executionSchema(env: SlackInstallationEnv) {
  await env.AGENT_AUDIT.prepare(`CREATE TABLE IF NOT EXISTS slack_coworker_execution_receipts (
    handoff_id TEXT PRIMARY KEY,draft_id TEXT NOT NULL UNIQUE,workspace_id TEXT NOT NULL,account_id TEXT NOT NULL,
    member_json TEXT NOT NULL,selection_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('dispatching','queued','blocked','unknown')),
    created_at INTEGER NOT NULL
  )`).run();
}
/** One draft has one submission attempt; an uncertain queue result is never automatically replayed. */
export async function claimSlackCoworkerExecution(env: SlackInstallationEnv, member: WorkspaceNativeMember, selection: SlackCoworkerExecutionSelection) {
  await executionSchema(env);
  const guard = slackCoworkerDraftGuard(member);
  const draft = await env.AGENT_AUDIT.prepare(`SELECT d.text FROM slack_coworker_drafts d WHERE d.id=? AND ${guard.sql}`)
    .bind(selection.id, ...guard.values).first<{ text: string }>();
  if (!draft) fail();
  const handoffId = `scx_${selection.id.slice(3)}`;
  const result = await env.AGENT_AUDIT.prepare(`INSERT OR IGNORE INTO slack_coworker_execution_receipts
    (handoff_id,draft_id,workspace_id,account_id,member_json,selection_json,state,created_at)
    SELECT ?,?,?,?,?,?,'dispatching',? WHERE EXISTS(SELECT 1 FROM slack_coworker_drafts d WHERE d.id=? AND d.text=? AND ${guard.sql})`)
    .bind(handoffId, selection.id, member.workspaceId, member.accountId, JSON.stringify(member), JSON.stringify(selection), Date.now(), selection.id, draft.text, ...guard.values).run();
  if (result.meta.changes !== 1) throw new SlackInstallationError("slack_coworker_execution_already_submitted", 409);
  return { handoffId, task: draft.text };
}
export async function finishSlackCoworkerExecution(env: SlackInstallationEnv, handoffId: string, state: "queued" | "blocked" | "unknown") {
  await env.AGENT_AUDIT.prepare("UPDATE slack_coworker_execution_receipts SET state=? WHERE handoff_id=? AND state='dispatching'").bind(state, handoffId).run();
}
/** Reserved IDs fail closed even when a receipt/table is missing. Legacy handoffs are unaffected. */
export async function isSlackCoworkerExecutionCurrent(env: SlackInstallationEnv, handoffId: string, scope: { workspaceId: string; userId: string }, roomId: string, task?: string, approvalId?: string, personalExecution?: unknown) {
  if (!handoffId.startsWith("scx_")) return true;
  try { return await (await import("./slack-coworker-execution.js")).isSlackCoworkerV2Current(env, handoffId, scope, roomId, task, approvalId, personalExecution); }
  catch { return false; }
}

/** Final D1-only source check for an already-verified personal mailbox claim. */
export async function isSlackCoworkerClaimSourceCurrent(env: SlackInstallationEnv, proof: { handoffId: string; approvalId: string; snapshot: { workspaceId: string; actorId: string } }, task: string): Promise<boolean> {
  if (!proof.handoffId.startsWith("scx_")) return true;
  try {
    const row = await env.AGENT_AUDIT.prepare("SELECT room_id FROM collaboration_handoffs WHERE tenant_id='self-hosted' AND workspace_id=? AND handoff_id=?")
      .bind(proof.snapshot.workspaceId, proof.handoffId).first<{ room_id: string }>();
    return Boolean(row && await isSlackCoworkerExecutionCurrent(env, proof.handoffId, { workspaceId: proof.snapshot.workspaceId, userId: proof.snapshot.actorId }, row.room_id, task, proof.approvalId, proof.snapshot));
  } catch { return false; }
}
