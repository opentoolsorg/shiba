import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { beginSlackCoworkerBinding, confirmSlackCoworkerBinding, observeSlackCoworkerChallenge, confirmSlackCoworkerOnSlack, grantSlackCoworkerIntake, intakeSlackCoworkerEvent, invalidateSlackCoworkerMessage, readSlackCoworkerDrafts, adoptSlackCoworkerDraft, readSlackCoworkerState, revokeSlackCoworkerBinding } from "../src/slack-coworker-store.js";
import { installationSnapshot, type SlackInstallationEnv, type SlackInstallationRow } from "../src/slack-installations-store.js";
import { handleMultiInstallationSlackCallback } from "../src/slack-installations-routing.js";

function fixture() {
  const db=customAgentD1();
  db.sqlite.exec('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT,emailVerified INTEGER); CREATE TABLE shiba_auth_account_policy(account_id TEXT PRIMARY KEY,email TEXT)');
  db.sqlite.exec(readFileSync(new URL("../migrations/0018_slack_installations.sql",import.meta.url),"utf8"));
  db.sqlite.exec(readFileSync(new URL("../migrations/0024_slack_coworker.sql",import.meta.url),"utf8"));
  const member={workspaceId:"ws_"+"1".repeat(24),userId:"owner@example.test",accountId:"native1",version:1,role:"owner" as const,joinedAt:1};
  db.sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run(member.accountId,member.userId);
  db.sqlite.prepare('INSERT INTO shiba_auth_account_policy VALUES(?,?)').run(member.accountId,member.userId);
  db.sqlite.prepare('INSERT INTO team_workspaces VALUES(?,?,?,?,?)').run('self-hosted',member.workspaceId,'Test',1,1);
  db.sqlite.prepare("INSERT INTO team_workspace_memberships(tenant_id,workspace_id,user_id,role,status,version,joined_at) VALUES('self-hosted',?,?,?,'active',1,1)").run(member.workspaceId,member.userId,member.role);
  db.sqlite.prepare(`INSERT INTO slack_installations(id,workspace_id,owner_id,owner_account_id,owner_member_json,app_id,team_id,bot_user_id,bot_id,installer_slack_user_id,scopes_json,generation,version,token_revision,state,digest,token_cipher,activation_expires_at,created_at)
    VALUES('i1',?,?,?,?, 'A1','T1','UBOT','B1','UINSTALL','["chat:write","commands","app_mentions:read"]',1,1,1,'active','digest','cipher',?,1)`).run(member.workspaceId,member.userId,member.accountId,JSON.stringify(member),Date.now()+100000);
  const row=db.sqlite.prepare('SELECT * FROM slack_installations').get() as unknown as SlackInstallationRow;
  return {...db,env:{AGENT_AUDIT:db.database} as SlackInstallationEnv,member,installation:installationSnapshot(row)};
}
describe('managed Slack identity challenge',()=>{
  it('requires a one-use signed-side observation and exact native confirmation',async()=>{
    const f=fixture(),c=await beginSlackCoworkerBinding(f.env,f.member,f.installation);
    expect(JSON.stringify(f.sqlite.prepare('SELECT * FROM slack_coworker_challenges').get())).not.toContain(c.secret);
    expect(await observeSlackCoworkerChallenge(f.env,{...f.installation,teamId:'OTHER'},c.secret,'U1')).toBeNull();
    expect(await observeSlackCoworkerChallenge(f.env,f.installation,c.secret,'UBOT')).toBeNull();
    expect(await observeSlackCoworkerChallenge(f.env,f.installation,c.secret,'U1')).toMatchObject({id:c.id});
    expect(await observeSlackCoworkerChallenge(f.env,f.installation,c.secret,'U2')).toBeNull();
    await expect(confirmSlackCoworkerBinding(f.env,f.member,f.installation,c.id,'U2')).rejects.toThrow();
    expect(await confirmSlackCoworkerOnSlack(f.env,f.installation,c.id,'U2',true)).toBe(false);
    expect(await confirmSlackCoworkerOnSlack(f.env,f.installation,c.id,'U1',true)).toBe(true);
    expect(await confirmSlackCoworkerOnSlack(f.env,f.installation,c.id,'U1',true)).toBe(false);
    expect((await readSlackCoworkerState(f.env,f.member)).challenges).toMatchObject([{slackUserId:'U1'}]);
    const b=await confirmSlackCoworkerBinding(f.env,f.member,f.installation,c.id,'U1');
    await expect(confirmSlackCoworkerBinding(f.env,f.member,f.installation,c.id,'U1')).rejects.toThrow();
    await revokeSlackCoworkerBinding(f.env,f.member,b.id);
    expect((await readSlackCoworkerState(f.env,f.member)).bindings).toHaveLength(0);
  });
  it('invalidates pending and active identity on membership and installation changes without revival',async()=>{
    const f=fixture(),c=await beginSlackCoworkerBinding(f.env,f.member,f.installation);
    await observeSlackCoworkerChallenge(f.env,f.installation,c.secret,'U1');
    f.sqlite.prepare("UPDATE team_workspace_memberships SET version=2,status='removed' WHERE user_id=?").run(f.member.userId);
    f.sqlite.prepare("UPDATE team_workspace_memberships SET version=3,status='active' WHERE user_id=?").run(f.member.userId);
    await expect(confirmSlackCoworkerBinding(f.env,f.member,f.installation,c.id,'U1')).rejects.toThrow();
    expect(f.sqlite.prepare('SELECT state FROM slack_coworker_challenges').get()).toMatchObject({state:'revoked'});
  });
  it('rejects a replay after installation generation changes',async()=>{
    const f=fixture(),c=await beginSlackCoworkerBinding(f.env,f.member,f.installation);
    f.sqlite.prepare("UPDATE slack_installations SET generation=2 WHERE id='i1'").run();
    expect(await observeSlackCoworkerChallenge(f.env,f.installation,c.secret,'U1')).toBeNull();
    expect(f.sqlite.prepare('SELECT state FROM slack_coworker_challenges').get()).toMatchObject({state:'revoked'});
  });
  it('accepts a challenge only from a verified managed Slack command',async()=>{
    const f=fixture(), c=await beginSlackCoworkerBinding(f.env,f.member,f.installation);
    f.env.SLACK_INSTALLATIONS_ENABLED='true';f.env.SLACK_OAUTH_APP_ID='A1';f.env.SLACK_SIGNING_SECRET='fixture-secret';
    const raw=new URLSearchParams({api_app_id:'A1',team_id:'T1',command:'/shiba-link',user_id:'U1',text:c.secret}).toString();
    const timestamp=String(Math.floor(Date.now()/1000));
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(f.env.SLACK_SIGNING_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`v0:${timestamp}:${raw}`))),b=>b.toString(16).padStart(2,'0')).join('');
    const request=(sig:string)=>new Request('https://shiba.test/api/slack/command',{method:'POST',headers:{'x-slack-request-timestamp':timestamp,'x-slack-signature':sig,'content-type':'application/x-www-form-urlencoded'},body:raw});
    expect((await handleMultiInstallationSlackCallback(request('v0=bad'),f.env))?.status).toBe(401);
    expect(f.sqlite.prepare('SELECT state FROM slack_coworker_challenges').get()).toMatchObject({state:'pending'});
    expect((await handleMultiInstallationSlackCallback(request(`v0=${signature}`),f.env))?.status).toBe(200);
    expect(f.sqlite.prepare('SELECT state,slack_user_id FROM slack_coworker_challenges').get()).toMatchObject({state:'observed',slack_user_id:'U1'});
    const interact=async(user:string)=>{
      const payload={type:'block_actions',api_app_id:'A1',team:{id:'T1'},user:{id:user},actions:[{action_id:'shiba_link_accept',value:c.id}]};
      const body=new URLSearchParams({payload:JSON.stringify(payload)}).toString();
      const mac=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`v0:${timestamp}:${body}`))),b=>b.toString(16).padStart(2,'0')).join('');
      return handleMultiInstallationSlackCallback(new Request('https://shiba.test/api/slack/interact',{method:'POST',headers:{'x-slack-request-timestamp':timestamp,'x-slack-signature':'v0='+mac,'content-type':'application/x-www-form-urlencoded'},body}),f.env);
    };
    await interact('U2');expect(f.sqlite.prepare('SELECT state FROM slack_coworker_challenges').get()).toMatchObject({state:'observed'});
    await interact('U1');expect(f.sqlite.prepare('SELECT state FROM slack_coworker_challenges').get()).toMatchObject({state:'slack_confirmed'});
  });
  it('keeps signed self-authored drafts scoped, deduplicated and invalidated on edit even when the edit arrives first',async()=>{
    const f=fixture(),c=await beginSlackCoworkerBinding(f.env,f.member,f.installation);
    await observeSlackCoworkerChallenge(f.env,f.installation,c.secret,'U1');await confirmSlackCoworkerOnSlack(f.env,f.installation,c.id,'U1',true);
    const b=await confirmSlackCoworkerBinding(f.env,f.member,f.installation,c.id,'U1');
    await grantSlackCoworkerIntake(f.env,f.member,b.id,'C1','123.000001');
    const seconds=Math.floor(Date.now()/1000)+1;
    const event={user:'U1',channel:'C1',thread_ts:'123.000001',ts:`${seconds}.000002`,text:'Please review this task'};
    expect(await intakeSlackCoworkerEvent(f.env,f.installation,'E1',{...event,user:'U2'})).toBe(false);
    expect(await intakeSlackCoworkerEvent(f.env,f.installation,'E1',{...event,channel:'C2'})).toBe(false);
    expect(await intakeSlackCoworkerEvent(f.env,f.installation,'E1',event)).toBe(true);
    expect(await intakeSlackCoworkerEvent(f.env,f.installation,'E1',event)).toBe(false);
    const drafts=await readSlackCoworkerDrafts(f.env,f.member);expect(drafts).toHaveLength(1);
    await invalidateSlackCoworkerMessage(f.env,f.installation,'C1',event.ts);
    await expect(adoptSlackCoworkerDraft(f.env,f.member,(drafts[0] as {id:string}).id)).rejects.toThrow();
    await invalidateSlackCoworkerMessage(f.env,f.installation,'C1',`${seconds}.000003`);
    expect(await intakeSlackCoworkerEvent(f.env,f.installation,'E2',{...event,ts:`${seconds}.000003`})).toBe(false);
    expect(await intakeSlackCoworkerEvent(f.env,f.installation,'E3',{...event,ts:`${seconds}.000004`})).toBe(true);
    const d=(await readSlackCoworkerDrafts(f.env,f.member))[0] as {id:string};
    expect(await adoptSlackCoworkerDraft(f.env,f.member,d.id)).toMatchObject({text:event.text});
    await expect(adoptSlackCoworkerDraft(f.env,f.member,d.id)).rejects.toThrow();
  });

});
