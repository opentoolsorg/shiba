import { afterEach,describe,expect,it,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { customAgentD1 } from './fixtures/custom-agent-d1.js';
import { createTeamWorkspace,getTeamWorkspaceMembership } from '../src/team-workspaces-store.js';
import { createCollaborationRoom,addCollaborationMember } from '../src/collaboration-store.js';
import { createStripeDraft,getStripeGrant,stripeDigest,type StripeEnv } from '../src/founder-stripe-store.js';
import { FOUNDER_STRIPE_EXECUTOR_DIGEST } from '../src/founder-stripe-generated.js';
import { ensureSlackInstallations,installationDigest,installationPurpose,installationSnapshot,type SlackInstallationRow } from '../src/slack-installations-store.js';
import { sealSlackSecret } from '../src/slack-installations-crypto.js';
import { ensureAutomaticSlackSchema } from '../src/founder-automatic-slack-store.js';
import { prepareStripeSlack,readStripeSlackGrant,stripeSlackView,transitionStripeSlack } from '../src/founder-automatic-slack-stripe-store.js';
import { tickFounderStripeAutomaticSlack } from '../src/founder-automatic-slack-stripe-tick.js';
import { postReportSlackMessage } from '../src/report-slack-sender.js';
import { handleFounderStripeAutomaticSlack } from '../src/founder-automatic-slack-stripe-routes.js';

const identity=vi.hoisted(()=>({email:'owner@example.test',accountId:'native-owner'}));
vi.mock('../src/request-auth.js',async original=>({...await original<typeof import('../src/request-auth.js')>(),isAuthorizedRequest:async()=>true,resolveUserId:async()=>identity.email}));
vi.mock('@shiba/auth/better-auth',async original=>({...await original<typeof import('@shiba/auth/better-auth')>(),resolveBetterAuthSessionAccount:async()=>({policy:{accountId:identity.accountId,email:identity.email,kind:'invited'},emailVerified:true,sessionId:`session-${identity.accountId}`,sessionExpiresAt:Date.now()+86400000})}));

const OWNER='owner@example.test',ADMIN='admin@example.test';
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
async function fixture(){
 identity.email=OWNER;identity.accountId='native-owner';
 vi.useFakeTimers({toFake:['Date']});const db=customAgentD1();db.sqlite.function('julianday',(_v:unknown)=>2440587.5+Date.now()/86400000);
 db.sqlite.exec('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT UNIQUE,emailVerified INTEGER);CREATE TABLE shiba_auth_account_policy(account_id TEXT PRIMARY KEY,email TEXT);CREATE TABLE "session"(id TEXT PRIMARY KEY,userId TEXT,expiresAt INTEGER)');
 for(const [id,email] of [['native-owner',OWNER],['native-admin',ADMIN]] as const){db.sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run(id,email);db.sqlite.prepare('INSERT INTO shiba_auth_account_policy VALUES(?,?)').run(id,email);db.sqlite.prepare('INSERT INTO "session" VALUES(?,?,?)').run(`session-${id}`,id,Date.now()+86400000);}
 db.sqlite.exec(readFileSync(new URL('../migrations/0027_founder_stripe_reads.sql',import.meta.url),'utf8'));
 const env={AGENT_AUDIT:db.database,FOUNDER_STRIPE_READS_ENABLED:'true',FOUNDER_STRIPE_CREDENTIAL_KEY:'ab'.repeat(32),SLACK_INSTALLATIONS_ENABLED:'true',SLACK_ROOM_OUTBOX_ENABLED:'true',SLACK_OAUTH_APP_ID:'A123',SLACK_OAUTH_CLIENT_ID:'123.456',SLACK_OAUTH_REDIRECT_URI:'https://shiba.test/api/slack/installations/callback',SLACK_OAUTH_PKCE_ENABLED:'true',SLACK_OAUTH_QUERY_REDACTION_VERIFIED:'true',SLACK_SIGNING_SECRET:'fixture-only',SLACK_INSTALLATION_KEYRING:JSON.stringify({activeKeyId:'v1',keys:{v1:'11'.repeat(32)}}),DASHBOARD_APPROVERS:ADMIN,SLACK_CANVAS_OWNERS:JSON.stringify([{teamId:'T123',channelId:'C123',ownerId:OWNER,viewerIds:[ADMIN]}])} as unknown as StripeEnv;
 const workspace=await createTeamWorkspace(env,OWNER,{name:'Stripe workspace'}),owner={...(await getTeamWorkspaceMembership(env,workspace.workspaceId,OWNER))!,accountId:'native-owner'};
 db.sqlite.prepare("INSERT INTO team_workspace_memberships(tenant_id,workspace_id,user_id,role,status,version,joined_at) VALUES('self-hosted',?,?,'admin','active',1,?)").run(workspace.workspaceId,ADMIN,Date.now());
 const admin={...(await getTeamWorkspaceMembership(env,workspace.workspaceId,ADMIN))!,accountId:'native-admin'},scope={tenantId:'self-hosted',workspaceId:workspace.workspaceId,userId:OWNER},roomId='stripe-slack-room';
 await createCollaborationRoom(env,scope,{roomId,title:'Reviewed Slack audience',visibility:'shared',createdAt:Date.now()});await addCollaborationMember(env,scope,roomId,{actorId:`human:${ADMIN}`,userId:ADMIN,displayName:ADMIN,kind:'human',createdAt:Date.now()});
 db.sqlite.prepare("INSERT INTO collaboration_slack_room_links VALUES(?,?,?,?,?,?,?,?,'active',?,NULL)").run('link-one','self-hosted',workspace.workspaceId,roomId,OWNER,'T123','C123','1710000000.000100',Date.now());
 await ensureSlackInstallations(env);const install:SlackInstallationRow={id:'managed-one',workspace_id:workspace.workspaceId,owner_id:OWNER,owner_account_id:owner.accountId,owner_member_json:JSON.stringify(owner),app_id:'A123',team_id:'T123',bot_user_id:'UB123',bot_id:'B123',installer_slack_user_id:'UINSTALLER',scopes_json:'["chat:write"]',generation:1,version:1,token_revision:1,state:'active',digest:'',token_key_id:null,token_cipher:null,token_expires_at:null,activation_expires_at:Date.now()+600000,created_at:Date.now(),refresh_claim_id:null};
 install.digest=await installationDigest(install);const sealed=await sealSlackSecret(env,{workspaceId:workspace.workspaceId,subject:install.id,purpose:installationPurpose(installationSnapshot(install))},JSON.stringify({accessToken:'fixture-bot-token',expiresAt:null}));install.token_key_id=sealed.keyId;install.token_cipher=sealed.cipher;db.sqlite.prepare(`INSERT INTO slack_installations(${Object.keys(install).join(',')}) VALUES(${Object.keys(install).map(()=>'?').join(',')})`).run(...Object.values(install) as never[]);
 await ensureAutomaticSlackSchema(env);db.sqlite.exec(readFileSync(new URL('../migrations/0031_founder_slack_sources.sql',import.meta.url),'utf8'));
 const ownerSession={id:'session-native-owner',expiresAt:Date.now()+86400000},adminSession={id:'session-native-admin',expiresAt:ownerSession.expiresAt},selection={kind:'balance_transactions',createdGte:100,createdLt:200,limit:2};
 const grant=await createStripeDraft(env,owner,{accountId:'acct_Fixture',mode:'test',restrictedKey:`rk_test_${'F'.repeat(24)}`,expiresAt:Date.now()+86400000,maxCalls:5,selection,readOnlyAttestation:'restricted-key-read-only-for-selected-resources'},ownerSession);db.sqlite.prepare("UPDATE founder_stripe_read_grants SET state='enabled' WHERE id=?").run(grant.id);
 const makeReceipt=async(id:string)=>{const at=Date.now(),report=JSON.stringify({format:'shiba.stripe-read-report.v1',principal:{kind:'schedule',id:`schedule:${grant.id}`},accountId:'acct_Fixture',mode:'test',grantId:grant.id,revision:1,contractDigest:grant.digest,executorDigest:FOUNDER_STRIPE_EXECUTOR_DIGEST,apiVersion:'2025-10-29.clover',capturedAt:at,capturedBytes:100,notice:'fixture',capture:{kind:'balance_transactions',interval:{createdGte:100,createdLt:200},hasMore:true,rows:[{id:'txn_abc',created:150,currency:'usd',amount:100,fee:3,net:97,type:'charge',source:'ch_abc'}],captureCompleteness:'bounded-response',datasetCompleteness:'unknown',businessSuccess:'unverified'},summary:[]}),digest=await stripeDigest(report);db.sqlite.prepare("INSERT INTO founder_stripe_read_receipts(id,grant_id,grant_revision,state,selection_json,report_json,result_digest,created_at,expires_at) VALUES(?,?,1,'completed',?,?,?,?,?)").run(id,grant.id,JSON.stringify(selection),report,digest,at,at+3600000);return{digest,report};};
 const sampleId=`fsr_${'a'.repeat(32)}`,sample=await makeReceipt(sampleId),input={requestId:crypto.randomUUID(),grantId:grant.id,grantRevision:1,grantDigest:grant.digest,sampleReceiptId:sampleId,sampleDigest:sample.digest,roomId,linkId:'link-one',maxSends:2,expiresAt:Date.now()+7200000},verify=async()=>{};
 const prepare=()=>prepareStripeSlack(env,owner,input,verify,ownerSession),decision=(row:{digest:string;expires_at:number})=>({expectedVersion:1 as const,digest:row.digest,expiresAt:row.expires_at,reviewed:true as const});
 const enabled=async()=>{const id=await prepare(),row=await readStripeSlackGrant(env,owner,id);await transitionStripeSlack(env,owner,id,'disclose',decision(row),verify,ownerSession);await transitionStripeSlack(env,admin,id,'approve',decision(row),verify,adminSession);return id;};
 const post=vi.fn(async(_token:string,_input:{channel:string;threadTs:string;text:string;clientMsgId:string})=>({channel:'C123',ts:'1720000000.000001'})),verifyInstallation=vi.fn(async()=>({teamId:'T123',userId:'UB123',botId:'B123'}));
 return{db,env,owner,admin,ownerSession,adminSession,grant,sample,input,makeReceipt,prepare,decision,enabled,post,verifyInstallation,verify};
}
describe('separate Stripe standing Slack authority',()=>{
 it('keeps the reviewed renderer code pin synchronized',()=>{execFileSync(process.execPath,[new URL('../src/founder-stripe-slack-manifest.mjs',import.meta.url).pathname,'--check']);});
 it('requires exact owner disclosure and different human approval; sends a qualified future receipt once',async()=>{
  const f=await fixture(),id=await f.prepare(),row=await readStripeSlackGrant(f.env,f.owner,id),view=await stripeSlackView(f.env,f.owner,row,f.verify,f.ownerSession);
  expect(view.sampleContent).toContain('dataset completeness unknown');expect(view.sampleContent).toContain('net_minor=97');expect(view.sampleContent).toContain(f.sample.digest);
  await expect(transitionStripeSlack(f.env,f.owner,id,'approve',f.decision(row),f.verify,f.ownerSession)).rejects.toThrow();
  await transitionStripeSlack(f.env,f.owner,id,'disclose',f.decision(row),f.verify,f.ownerSession);
  await expect(transitionStripeSlack(f.env,f.owner,id,'approve',f.decision(row),f.verify,f.ownerSession)).rejects.toThrow();
  await transitionStripeSlack(f.env,f.admin,id,'approve',f.decision(row),f.verify,f.adminSession);
  expect((await tickFounderStripeAutomaticSlack(f.env,{postMessage:f.post,verifyInstallation:f.verifyInstallation})).sent).toBe(0);
  vi.setSystemTime(Date.now()+5000);await f.makeReceipt(`fsr_${'b'.repeat(32)}`);
  expect((await tickFounderStripeAutomaticSlack(f.env,{postMessage:f.post,verifyInstallation:f.verifyInstallation})).sent).toBe(1);
  expect((await tickFounderStripeAutomaticSlack(f.env,{postMessage:f.post,verifyInstallation:f.verifyInstallation})).sent).toBe(0);expect(f.post).toHaveBeenCalledTimes(1);
  expect(f.post.mock.calls[0]?.[1]).toMatchObject({channel:'C123',threadTs:'1710000000.000100'});
 });
 it('revocation during bot verification blocks the final send',async()=>{
  const f=await fixture();await f.enabled();vi.setSystemTime(Date.now()+5000);await f.makeReceipt(`fsr_${'b'.repeat(32)}`);
  f.verifyInstallation.mockImplementation(async()=>{f.db.sqlite.prepare("UPDATE founder_stripe_read_grants SET state='revoked' WHERE id=?").run(f.grant.id);return{teamId:'T123',userId:'UB123',botId:'B123'};});
  expect((await tickFounderStripeAutomaticSlack(f.env,{postMessage:f.post,verifyInstallation:f.verifyInstallation})).blocked).toBe(1);expect(f.post).not.toHaveBeenCalled();
 });
 it('refuses a changed frozen contract',async()=>{
  const f=await fixture(),id=await f.enabled();f.db.sqlite.prepare("UPDATE founder_stripe_slack_grants SET family_json=json_set(family_json,'$.renderPolicy','other') WHERE id=?").run(id);
  vi.setSystemTime(Date.now()+5000);await f.makeReceipt(`fsr_${'b'.repeat(32)}`);expect((await tickFounderStripeAutomaticSlack(f.env,{postMessage:f.post,verifyInstallation:f.verifyInstallation})).blocked).toBe(1);expect(f.post).not.toHaveBeenCalled();
 });
 it('blocks an existing unknown OAuth-family send and never claims a Stripe receipt',async()=>{
  const f=await fixture(),id=await f.enabled(),row=await readStripeSlackGrant(f.env,f.owner,id);vi.setSystemTime(Date.now()+5000);await f.makeReceipt(`fsr_${'b'.repeat(32)}`);
  f.db.sqlite.prepare("INSERT INTO founder_automatic_slack_deliveries(id,grant_id,workspace_id,occurrence_id,source_key,destination_key,report_hash,content,content_hash,client_msg_id,state,lease_id,lease_expires_at,created_at,expires_at) VALUES('old','oauth',?,'old-occurrence','old-key',?,'hash','private','hash','old-client','unknown','lease',?,?,?)").run(f.owner.workspaceId,row.destination_key,Date.now()-1,Date.now()-5000,Date.now()+60000);
  await tickFounderStripeAutomaticSlack(f.env,{postMessage:f.post,verifyInstallation:f.verifyInstallation});
  expect(f.post).not.toHaveBeenCalled();expect(f.db.sqlite.prepare('SELECT state,used_sends FROM founder_stripe_slack_grants WHERE id=?').get(id)).toMatchObject({state:'blocked',used_sends:0});
 });
 it('requires the current native session at the final human decision',async()=>{
  const f=await fixture(),id=await f.prepare(),row=await readStripeSlackGrant(f.env,f.owner,id);
  f.db.sqlite.prepare('DELETE FROM "session" WHERE id=?').run(f.ownerSession.id);
  await expect(transitionStripeSlack(f.env,f.owner,id,'disclose',f.decision(row),f.verify,f.ownerSession)).rejects.toThrow();
  expect(f.db.sqlite.prepare('SELECT state FROM founder_stripe_slack_grants WHERE id=?').get(id)).toMatchObject({state:'draft'});
 });
 it('reserves once during concurrent ticks and latches an uncertain Slack result without retry',async()=>{
  const f=await fixture(),id=await f.enabled();vi.setSystemTime(Date.now()+5000);await f.makeReceipt(`fsr_${'b'.repeat(32)}`);
  let arrived!:()=>void,release!:()=>void;const waiting=new Promise<void>(resolve=>{arrived=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
  f.verifyInstallation.mockImplementation(async()=>{arrived();await hold;return{teamId:'T123',userId:'UB123',botId:'B123'};});
  f.post.mockImplementation(async()=>{throw new Error('lost acknowledgment');});
  const first=tickFounderStripeAutomaticSlack(f.env,{postMessage:f.post,verifyInstallation:f.verifyInstallation});await waiting;
  expect((await tickFounderStripeAutomaticSlack(f.env,{postMessage:f.post,verifyInstallation:f.verifyInstallation})).sent).toBe(0);release();
  expect((await first).unknown).toBe(1);expect(f.post).toHaveBeenCalledTimes(1);
  expect(f.db.sqlite.prepare('SELECT used_sends,state FROM founder_stripe_slack_grants WHERE id=?').get(id)).toMatchObject({used_sends:1,state:'blocked'});
  await tickFounderStripeAutomaticSlack(f.env,{postMessage:f.post,verifyInstallation:f.verifyInstallation});expect(f.post).toHaveBeenCalledTimes(1);
 });
 it('posts only once to the fixed Slack endpoint with manual redirects and no broadcasts',async()=>{
  const send=vi.fn(async()=>Response.json({ok:true,channel:'C123',ts:'1720000000.000001'}));vi.stubGlobal('fetch',send);
  await postReportSlackMessage('fixture-token',{channel:'C123',threadTs:'1710000000.000100',text:'qualified captured evidence',clientMsgId:crypto.randomUUID()});
  expect(send).toHaveBeenCalledTimes(1);const [url,init]=send.mock.calls[0] as unknown as [string,RequestInit];
  expect(url).toBe('https://slack.com/api/chat.postMessage');expect(init.redirect).toBe('manual');expect(JSON.parse(String(init.body))).toMatchObject({channel:'C123',thread_ts:'1710000000.000100',mrkdwn:false,parse:'none',reply_broadcast:false,unfurl_links:false,unfurl_media:false});
 });
 it('requires a native cookie and exact explicit consent at the real route',async()=>{
  const f=await fixture();const call=async(path:string,body?:unknown,cookie=true)=>handleFounderStripeAutomaticSlack(new Request('https://shiba.test/api/founder-stripe-slack'+path,{method:body===undefined?'GET':'POST',headers:{Origin:'https://shiba.test','Content-Type':'application/json','X-Shiba-Workspace':f.owner.workspaceId,...(cookie?{Cookie:'fixture=session'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}),f.env);
  expect((await call('',undefined,false))?.status).toBe(403);const preview=await call('',f.input);expect(preview?.status).toBe(200);const value=await preview!.json() as {grant:{id:string;digest:string;expiresAt:number}};
  const decision={expectedVersion:1,digest:value.grant.digest,expiresAt:value.grant.expiresAt,reviewed:true};
  expect((await call(`/${value.grant.id}/disclose`,decision))?.status).toBe(400);
  expect((await call(`/${value.grant.id}/disclose`,{...decision,futureReportConsent:'share-future-completed-stripe-receipts-from-this-exact-grant',audienceConsent:'all-current-and-future-people-with-access-to-selected-slack-channel-thread'}))?.status).toBe(200);
  expect((await call(`/${value.grant.id}/approve`,decision))?.status).toBe(403);
  identity.email=ADMIN;identity.accountId='native-admin';
  const discovery=await call('');expect(discovery?.status).toBe(200);expect((await discovery!.json() as {grants:string[]}).grants).toContain(value.grant.id);
  expect((await call(`/${value.grant.id}/approve`,decision))?.status).toBe(200);
 });
});
