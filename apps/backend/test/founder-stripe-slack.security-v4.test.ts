import { afterEach,describe,expect,it,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { customAgentD1 } from './fixtures/custom-agent-d1.js';
import { createTeamWorkspace,getTeamWorkspaceMembership } from '../src/team-workspaces-store.js';
import { createCollaborationRoom,addCollaborationMember } from '../src/collaboration-store.js';
import { createStripeDraft,stripeDigest,type StripeEnv } from '../src/founder-stripe-store.js';
import { FOUNDER_STRIPE_EXECUTOR_DIGEST } from '../src/founder-stripe-generated.js';
import { ensureSlackInstallations,installationDigest,installationPurpose,installationSnapshot,type SlackInstallationRow } from '../src/slack-installations-store.js';
import { sealSlackSecret } from '../src/slack-installations-crypto.js';
import { ensureAutomaticSlackSchema } from '../src/founder-automatic-slack-store.js';
import { prepareStripeSlack,readStripeSlackGrant,transitionStripeSlack } from '../src/founder-automatic-slack-stripe-store.js';
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
describe('independent Stripe Slack final disclosure lease',()=>{
 it.each(['sample','session'])('withholds private sample when %s expires while final SQL proof returns',async(kind)=>{
  const f=await fixture(),id=await f.prepare(),deadline=Date.now()+60000;
  if(kind==='sample')f.db.sqlite.prepare('UPDATE founder_stripe_read_receipts SET expires_at=? WHERE id=?').run(deadline,f.input.sampleReceiptId);
  else f.db.sqlite.prepare('UPDATE "session" SET expiresAt=? WHERE id=?').run(deadline,f.ownerSession.id);
  const request=()=>new Request(`https://shiba.test/api/founder-stripe-slack/${id}`,{headers:{'X-Shiba-Workspace':f.owner.workspaceId,Cookie:'fixture=session'}});
  expect((await handleFounderStripeAutomaticSlack(request(),f.env))?.status).toBe(200);
  const prepare=f.env.AGENT_AUDIT.prepare.bind(f.env.AGENT_AUDIT);let held=false;
  const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(statement,{get(target,property){if(property==='bind')return(...values:unknown[])=>wrap(target.bind(...values),sql);if(property==='first')return async()=>{const value=await target.first();if(!held&&sql.includes('SELECT 1 AS current FROM founder_stripe_slack_grants WHERE id=')){held=true;vi.setSystemTime(deadline+1);}return value;};const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});
  f.env.AGENT_AUDIT.prepare=sql=>wrap(prepare(sql),sql);
  const result=await handleFounderStripeAutomaticSlack(request(),f.env);expect(held).toBe(true);expect(await result!.text()).not.toContain('net_minor=97');
 });
});
