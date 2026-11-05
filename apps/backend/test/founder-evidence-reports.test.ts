import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { createTeamWorkspace, createTeamWorkspaceInvitation, acceptTeamWorkspaceInvitation, getTeamWorkspaceMembership } from "../src/team-workspaces-store.js";
import { ensureWorkspaceIntegrationSchema } from "../src/workspace-integrations-store.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { installSkillDefinition } from "../src/skill-library/install.js";
import { activateSkill, getSkill, reviewSkill } from "../src/skills-store.js";
import { getFounderSkillLibraryEntry, founderEvidencePreviewSchema, founderEvidenceRecordSchema, founderEvidenceOptionsSchema, founderEvidenceRevokeResponseSchema, founderEvidenceReportHash } from "@shiba/shared";
import { openConnectorWorkspaceConnectionName } from "../src/integrations/openconnector-provider.js";
import { sha256Hex } from "../src/agent-tokens.js";
import { hashToolArgs } from "../src/mcp-gateway.js";
import type { WorkspaceActionBinding } from "../src/workspace-integration-actions.js";
import type { WorkspaceNativeMember } from "../src/workspace-native-authority.js";
import { previewFounderEvidenceReport, createFounderEvidenceReport, loadFounderEvidenceReport, founderEvidenceReportGuard, revokeFounderEvidenceReport, founderEvidenceOptions } from "../src/founder-evidence-reports.js";
import { handleFounderEvidenceReports } from "../src/founder-evidence-routes.js";
import { createCollaborationRoom, addCollaborationMember } from "../src/collaboration-store.js";
import { handleReportSlack } from "../src/report-slack-routes.js";
import type { ReportSlackState } from "@shiba/shared";

const session=vi.hoisted(()=>({email:"owner@example.test",accounts:{} as Record<string,string>,available:true}));
vi.mock("@shiba/auth/better-auth",async original=>({...await original<typeof import("@shiba/auth/better-auth")>(),resolveBetterAuthSessionAccount:async()=>session.available?({policy:{accountId:session.accounts[session.email],email:session.email,kind:"invited",createdAt:1},emailVerified:true}):null}));
vi.mock("../src/request-auth.js",async original=>({...await original<typeof import("../src/request-auth.js")>(),isAuthorizedRequest:async()=>true,resolveUserId:async()=>session.email}));
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
const OWNER="owner@example.test",ADMIN="admin@example.test",MEMBER="member@example.test",LIBRARY="founder-hubspot-stripe-reconcile";
async function fixture(options:{slack?:boolean}={}) {
  const db=customAgentD1();
  db.sqlite.function("julianday",(_value:unknown)=>2_440_587.5+Date.now()/86_400_000);
  db.sqlite.exec('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT UNIQUE,emailVerified INTEGER);CREATE TABLE shiba_auth_account_policy(account_id TEXT PRIMARY KEY,email TEXT)');
  session.email=OWNER;session.accounts={};session.available=true;
  for(const email of [OWNER,ADMIN,MEMBER]){const accountId=crypto.randomUUID();session.accounts[email]=accountId;db.sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run(accountId,email);db.sqlite.prepare("INSERT INTO shiba_auth_account_policy VALUES(?,?)").run(accountId,email);}
  const accounts:Array<{id:string;service:string;connectionName:string;configured:boolean;virtual:boolean;oauthAuthorizationId:string;profile:{displayName:string}}> = [];
  let afterMetadata:(()=>void)|undefined;let metadataBody:string|undefined;
  const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{expect(new URL(String(input)).pathname).toBe("/api/connections");expect(init?.method??"GET").toBe("GET");const snapshot=metadataBody??JSON.stringify(accounts);afterMetadata?.();afterMetadata=undefined;return new Response(snapshot,{headers:{"content-type":"application/json"}});});
  const env={AGENT_AUDIT:db.database,OPEN_CONNECTOR:{fetch:fetcher},OPEN_CONNECTOR_ADMIN_TOKEN:"fixture-admin"} as unknown as Env;
  for(const name of ["AI","CodingOrchestrator","Sandbox",...(options.slack?[]:["SLACK_BOT_TOKEN"]),"AI_GATEWAY_TOKEN"])Object.defineProperty(env,name,{get(){throw new Error(`Evidence must not access ${name}`);}});
  const workspace=await createTeamWorkspace(env,OWNER,{name:"Evidence workspace"});
  for(const [email,role]of[[ADMIN,"admin"],[MEMBER,"member"]]as const){const invitation=await createTeamWorkspaceInvitation(env,workspace.workspaceId,OWNER,{email,role});await acceptTeamWorkspaceInvitation(env,email,invitation.token);}
  const native=async(email:string)=>({...await getTeamWorkspaceMembership(env,workspace.workspaceId,email),accountId:session.accounts[email]} as WorkspaceNativeMember);
  const owner=await native(OWNER),admin=await native(ADMIN);
  await ensureWorkspaceIntegrationSchema(env);
  const employee=await createCustomAgent(env,`team:${workspace.workspaceId}`,"report-helper",{name:"Evidence helper",instructions:"Report only explicitly supplied facts",harness:"opencode"});
  const recipe=getFounderSkillLibraryEntry(LIBRARY)!;const teamGrant={...owner,role:"owner" as const};
  const installed=await installSkillDefinition(env,`team:${workspace.workspaceId}`,OWNER,{slug:LIBRARY,name:recipe.name,instructions:recipe.instructions,sourceUrl:recipe.sourceUrl,version:"1.1.0"},{teamGrant});
  const skill=(await getSkill(env,`team:${workspace.workspaceId}`,OWNER,installed.skillId))!;
  await reviewSkill(env,skill.orgId,OWNER,skill.id,skill.version,skill.content.instructions,Date.now(),{teamGrant});await activateSkill(env,skill.orgId,OWNER,skill.id,skill.version,skill.content.instructions,Date.now(),{teamGrant});
  const alias=await openConnectorWorkspaceConnectionName(workspace.workspaceId);
  async function receipt(service:string,options:{requester?:WorkspaceNativeMember;issuer?:WorkspaceNativeMember;result?:unknown;arguments?:Record<string,unknown>;status?:string}={}) {
    const requester=options.requester??owner,issuer=options.issuer??owner;
    const connectionId=`connection-${service}`,grantId=`grant-${service}-${requester.accountId}`;
    const upstream={id:`upstream-${service}`,service,connectionName:alias,configured:true,virtual:false,oauthAuthorizationId:`consent-${service}`,profile:{displayName:`${service} fixture account`}};
    if(!accounts.some(item=>item.service===service))accounts.push(upstream);
    const fingerprint=await sha256Hex(JSON.stringify([alias,service,upstream.oauthAuthorizationId]));
    const providerId=`ocg_${await sha256Hex(JSON.stringify([alias,service,upstream.id,upstream.oauthAuthorizationId]))}`;
    db.sqlite.prepare("INSERT OR IGNORE INTO workspace_app_connections VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(connectionId,workspace.workspaceId,service,1,1,"active",issuer.userId,issuer.accountId,issuer.version,issuer.role,"pending",0,fingerprint,providerId,upstream.profile.displayName,Date.now(),Date.now());
    db.sqlite.prepare("INSERT OR REPLACE INTO workspace_app_grants VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(grantId,workspace.workspaceId,connectionId,1,1,fingerprint,employee.id,employee.version,requester.userId,requester.accountId,requester.version,requester.role,'["execute","discover"]',"active",1,owner.userId,owner.accountId,owner.version,owner.role,Date.now());
    const binding:WorkspaceActionBinding={workspaceId:workspace.workspaceId,actorId:requester.userId,actorAccountId:requester.accountId,actorVersion:requester.version,actorRole:requester.role,employeeId:employee.id,employeeVersion:employee.version,connectionId,connectionVersion:1,generation:1,fingerprint,providerConnectionId:providerId,providerKey:service,grantId,grantVersion:1,issuer,grantManager:owner,actionSchemaHash:"a".repeat(64),resultAudience:"requester-private"};
    const id=`receipt_${crypto.randomUUID()}`,actionId=`${service}.fixture`,args=options.arguments??{privateArgument:"not exported"},inputHash=await hashToolArgs({binding,actionId,arguments:args}),resultJson=JSON.stringify(options.result??{errors:[{message:"Vendor semantic error"}],has_more:false,items:[{id:"stored-value"}]});
    db.sqlite.prepare("INSERT INTO workspace_app_approvals VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,workspace.workspaceId,crypto.randomUUID(),requester.userId,JSON.stringify(binding),employee.id,employee.version,employee.config.name,connectionId,1,actionId,JSON.stringify(args),inputHash,options.status??"completed",Date.now()+900000,admin.userId,admin.accountId,admin.version,admin.role,Date.now(),resultJson,null,Date.now(),Date.now());
    return {approvalId:id,inputHash,resultDigest:await sha256Hex(resultJson),binding,resultJson};
  }
  const a=await receipt("stripe"),b=await receipt("hubspot");
  const refs=[a,b].map(({approvalId,inputHash,resultDigest})=>({approvalId,inputHash,resultDigest}));
  const input={employeeId:employee.id,employeeVersion:employee.version,skillId:skill.id,skillVersion:skill.version,receipts:refs,expiresAt:Date.now()+3600000};
  const preview=()=>previewFounderEvidenceReport(env,owner,LIBRARY,input);
  const create=async()=>{const p=await preview();return createFounderEvidenceReport(env,owner,LIBRARY,{...input,expectedReportHash:p.reportHash,requestId:crypto.randomUUID()});};
  const call=async(suffix="",method="GET",body?:unknown)=>{const response=(await handleFounderEvidenceReports(new Request(`https://shiba.test/api/founder-skills/${LIBRARY}/reports${suffix}`,{method,headers:{Origin:"https://shiba.test","Content-Type":"application/json","X-Shiba-Workspace":workspace.workspaceId},...(body===undefined?{}:{body:JSON.stringify(body)})}),env))!;return response;};
  return{...db,env,workspace,owner,admin,employee,skill,input,a,b,refs,accounts,fetcher,native,receipt,preview,create,call,afterMetadata(fn:()=>void){afterMetadata=fn;},metadataBody(value:string){metadataBody=value;}};
}

describe("private deterministic founder evidence using real SQLite and auth-metadata HTTP fixtures",()=>{
  it("combines two explicitly selected stored receipts with frozen uncertainty labels and exact exported bytes",async()=>{
    const f=await fixture(),p=await f.preview();founderEvidencePreviewSchema.parse(p);
    expect(p.reportHash).toBe(founderEvidenceReportHash(p));expect(p.receipts).toHaveLength(2);expect(p.receipts[0]).toMatchObject({sourceKind:"bounded-stored-excerpt",captureCompleteness:"unknown",datasetCompleteness:"unknown",businessSuccess:"unverified"});
    expect(p.markdown).toContain("No new business data");expect(p.markdown).not.toContain("privateArgument");expect(p.json).toContain("Vendor semantic error");
    expect(p.json).toContain('"businessSuccess": "unverified"');expect(p.json).toContain('"has_more": false');
    const before=f.fetcher.mock.calls.length,requestId=crypto.randomUUID();const created=await createFounderEvidenceReport(f.env,f.owner,LIBRARY,{...f.input,expectedReportHash:p.reportHash,requestId});
    expect(f.fetcher.mock.calls.length-before).toBe(1);founderEvidenceRecordSchema.parse(created.report);
    expect(created.report.markdown).toBe(p.markdown);expect(created.report.json).toBe(p.json);
    const repeated=await createFounderEvidenceReport(f.env,f.owner,LIBRARY,{...f.input,expectedReportHash:p.reportHash,requestId});expect(repeated.report.id).toBe(created.report.id);
    const download=await f.call(`/${created.report.id}/download?format=markdown`);expect(download.status).toBe(200);expect(download.headers.get("cache-control")).toBe("no-store");expect(await download.text()).toBe(p.markdown);
    expect(f.fetcher.mock.calls.every(([url,init])=>new URL(String(url)).pathname==="/api/connections"&&(init?.method??"GET")==="GET")).toBe(true);
  });
  it("normalizes receipt selection order and rejects changed preview hashes or source digests",async()=>{
    const f=await fixture(),first=await f.preview(),second=await previewFounderEvidenceReport(f.env,f.owner,LIBRARY,{...f.input,receipts:[...f.refs].reverse()});expect(first.reportHash).toBe(second.reportHash);
    await expect(createFounderEvidenceReport(f.env,f.owner,LIBRARY,{...f.input,expiresAt:f.input.expiresAt+1,expectedReportHash:first.reportHash,requestId:crypto.randomUUID()})).rejects.toThrow("report_preview_changed");
    await expect(previewFounderEvidenceReport(f.env,f.owner,LIBRARY,{...f.input,receipts:[{...f.refs[0]!,resultDigest:"b".repeat(64)}]})).rejects.toThrow("report_receipt_changed");
  });
  it.each(["grant","decider","profile","skill","result"])("fails the final preview fence when %s changes during metadata authentication",async(kind)=>{
    const f=await fixture();f.afterMetadata(()=>{if(kind==="grant")f.sqlite.exec("UPDATE workspace_app_grants SET state='revoked'");if(kind==="decider")f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed',version=version+1 WHERE user_id=?").run(ADMIN);if(kind==="profile")f.sqlite.exec("UPDATE org_custom_agents SET version=version+1");if(kind==="skill")f.sqlite.exec("UPDATE skills SET status='disabled'");if(kind==="result")f.sqlite.exec("UPDATE workspace_app_approvals SET result_json='{}'");});
    await expect(f.preview()).rejects.toThrow("report_sources_changed");
  });
  it("rejects revoked upstream authorization and unknown or oversized connection metadata",async()=>{
    const f=await fixture();f.accounts[0]!.configured=false;await expect(f.preview()).rejects.toThrow("report_connection_authorization_changed");
    f.accounts[0]!.configured=true;f.metadataBody(" ".repeat(524289));await expect(f.preview()).rejects.toThrow();
    f.metadataBody(JSON.stringify(Array.from({length:201},()=>f.accounts[0])));await expect(f.preview()).rejects.toThrow();
  });
  it("never selects another requester's manager-visible receipts or non-completed work",async()=>{
    const f=await fixture(),foreign=await f.receipt("stripe",{requester:f.admin});
    await expect(previewFounderEvidenceReport(f.env,f.owner,LIBRARY,{...f.input,receipts:[{approvalId:foreign.approvalId,inputHash:foreign.inputHash,resultDigest:foreign.resultDigest}]})).rejects.toThrow("report_receipt_changed");
    f.sqlite.exec("UPDATE workspace_app_approvals SET status='unknown'");await expect(f.preview()).rejects.toThrow("report_receipt_changed");
  });
  it("retains creator-native identity, private downloads, expiry and explicit revoke",async()=>{
    const f=await fixture(),{report}=await f.create();session.email=ADMIN;expect((await f.call(`/${report.id}`)).status).toBe(404);session.email=MEMBER;expect((await f.call(`/${report.id}`)).status).toBe(403);session.email=OWNER;
    const revoked=await revokeFounderEvidenceReport(f.env,f.owner,LIBRARY,report.id,report.reportHash);founderEvidenceRevokeResponseSchema.parse(revoked);expect(JSON.stringify(revoked)).not.toContain("stored-value");await expect(loadFounderEvidenceReport(f.env,f.owner,LIBRARY,report.id)).rejects.toThrow("report_sources_changed");
    const again=await f.create();vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(again.report.expiresAt+1);await expect(loadFounderEvidenceReport(f.env,f.owner,LIBRARY,again.report.id)).rejects.toThrow("report_sources_changed");
  });
  it("revalidates source snapshots on read and combines issuer ownership in the export guard",async()=>{
    const f=await fixture(),{report,authority}=await f.create();const guard=founderEvidenceReportGuard(authority,{requireExportOwnership:true});expect(await f.env.AGENT_AUDIT.prepare(`SELECT 1 AS ok WHERE ${guard.sql}`).bind(...guard.values).first()).toEqual({ok:1});
    f.afterMetadata(()=>f.sqlite.exec("UPDATE workspace_app_connections SET generation=generation+1"));await expect(loadFounderEvidenceReport(f.env,f.owner,LIBRARY,report.id)).rejects.toThrow("report_sources_changed");
  });
  it("rechecks report expiry after an awaited authentication metadata response",async()=>{
    const f=await fixture(),{report}=await f.create();vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(report.expiresAt-1);
    f.afterMetadata(()=>vi.setSystemTime(report.expiresAt+1));await expect(loadFounderEvidenceReport(f.env,f.owner,LIBRARY,report.id)).rejects.toThrow("report_sources_changed");
  });
  it.each(["read","download","preview","create"])("rechecks the current native session after metadata awaits for %s",async(action)=>{
    const f=await fixture(),{report}=await f.create(),p=await f.preview();
    f.afterMetadata(()=>{session.available=false;});
    const response=action==="preview"?await f.call("/preview","POST",f.input):action==="create"?await f.call("","POST",{...f.input,expectedReportHash:p.reportHash,requestId:crypto.randomUUID()}):await f.call(`/${report.id}${action==="download"?"/download?format=markdown":""}`);
    expect(response.status).toBe(403);expect(await response.text()).not.toContain("stored-value");expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM founder_evidence_reports").get()).toEqual({n:1});
  });
  it("does not transfer a private report to a replacement native account with the same email",async()=>{
    const f=await fixture(),{report}=await f.create(),replacement=crypto.randomUUID();
    f.sqlite.prepare("DELETE FROM shiba_auth_account_policy WHERE account_id=?").run(f.owner.accountId);f.sqlite.prepare('DELETE FROM "user" WHERE id=?').run(f.owner.accountId);
    f.sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run(replacement,OWNER);f.sqlite.prepare("INSERT INTO shiba_auth_account_policy VALUES(?,?)").run(replacement,OWNER);session.accounts[OWNER]=replacement;
    expect((await f.call(`/${report.id}`)).status).toBe(404);await expect(loadFounderEvidenceReport(f.env,f.owner,LIBRARY,report.id)).rejects.toThrow("workspace_authority_changed");
  });
  it("recovers an unknown insert acknowledgement only through its same request UUID and exact frozen hash",async()=>{
    const f=await fixture(),p=await f.preview(),requestId=crypto.randomUUID(),original=f.env.AGENT_AUDIT.prepare.bind(f.env.AGENT_AUDIT);let lost=false;
    f.env.AGENT_AUDIT.prepare=(sql)=>{const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>({...statement,bind:(...args:unknown[])=>wrap(statement.bind(...args)),run:async<T>()=>{const result=await statement.run<T>();if(!lost&&/INSERT OR IGNORE INTO founder_evidence_reports/.test(sql)){lost=true;throw new Error("Fixture lost acknowledgement after local commit");}return result;}}as D1PreparedStatement);return wrap(original(sql));};
    const input={...f.input,requestId,expectedReportHash:p.reportHash};await expect(createFounderEvidenceReport(f.env,f.owner,LIBRARY,input)).rejects.toThrow("Fixture lost acknowledgement");
    f.env.AGENT_AUDIT.prepare=original;const recovered=await createFounderEvidenceReport(f.env,f.owner,LIBRARY,input);expect(recovered.report.reportHash).toBe(p.reportHash);expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM founder_evidence_reports").get()).toEqual({n:1});
  });
  it("allows private granted evidence but denies its export when a connection was issued by another native manager",async()=>{
    const f=await fixture();f.sqlite.exec("DELETE FROM workspace_app_approvals;DELETE FROM workspace_app_grants;DELETE FROM workspace_app_connections");f.accounts.length=0;
    const receipt=await f.receipt("stripe",{issuer:f.admin}),input={...f.input,receipts:[{approvalId:receipt.approvalId,inputHash:receipt.inputHash,resultDigest:receipt.resultDigest}]};
    const p=await previewFounderEvidenceReport(f.env,f.owner,LIBRARY,input),created=await createFounderEvidenceReport(f.env,f.owner,LIBRARY,{...input,expectedReportHash:p.reportHash,requestId:crypto.randomUUID()});expect(created.report.canRead).toBe(true);
    await expect(loadFounderEvidenceReport(f.env,f.owner,LIBRARY,created.report.id,{requireExportOwnership:true})).rejects.toThrow("report_sources_changed");
  });
  it("rejects excessive output without truncation and bounds request bodies",async()=>{
    const f=await fixture();f.sqlite.exec("DELETE FROM workspace_app_approvals");const receipts=[];
    for(let n=0;n<5;n++){const row=await f.receipt("stripe",{result:{value:"x".repeat(30000)}});receipts.push({approvalId:row.approvalId,inputHash:row.inputHash,resultDigest:row.resultDigest});}
    await expect(previewFounderEvidenceReport(f.env,f.owner,LIBRARY,{...f.input,receipts})).rejects.toThrow("report_evidence_limit");
    expect((await f.call("/preview","POST",{...f.input,padding:"x".repeat(8192)})).status).toBe(413);
  });
  it("returns only qualified source metadata from options and applies its migration to fresh/legacy D1",async()=>{
    const f=await fixture(),options=await founderEvidenceOptions(f.env,f.owner,LIBRARY,f.employee.id,f.employee.version);founderEvidenceOptionsSchema.parse(options);expect(options.receipts).toHaveLength(2);expect(JSON.stringify(options)).not.toContain("stored-value");
    for(const legacy of [false,true]){const db=new DatabaseSync(":memory:");if(legacy)db.exec("CREATE TABLE legacy_runs(id TEXT)");const sql=readFileSync(new URL("../migrations/0015_founder_evidence_reports.sql",import.meta.url),"utf8");db.exec(sql);db.exec(sql);expect(db.prepare("SELECT name FROM sqlite_master WHERE name='founder_evidence_reports'").get()).toBeTruthy();db.close();}
  });
  it("integrates the real private report and source fence with one explicitly disclosed and approved fixture Slack send",async()=>{
    const f=await fixture({slack:true});
    Object.assign(f.env,{SLACK_ROOM_OUTBOX_ENABLED:"true",SLACK_BOT_TOKEN:"fixture-slack-token",SLACK_APPROVALS_CHANNEL:"C123",DASHBOARD_APPROVERS:ADMIN,
      SLACK_CANVAS_OWNERS:JSON.stringify([{teamId:"T123",channelId:"C123",ownerId:OWNER,viewerIds:[ADMIN]}])});
    const roomScope={tenantId:"self-hosted",workspaceId:f.workspace.workspaceId,userId:OWNER};
    await createCollaborationRoom(f.env,roomScope,{roomId:"room-report",title:"Explicit report audience",visibility:"shared",createdAt:Date.now()});
    await addCollaborationMember(f.env,roomScope,"room-report",{actorId:`human:${ADMIN}`,userId:ADMIN,displayName:ADMIN,kind:"human",createdAt:Date.now()});
    f.sqlite.prepare("INSERT INTO collaboration_slack_room_links(link_id,tenant_id,workspace_id,room_id,owner_user_id,team_id,channel_id,thread_ts,status,created_at) VALUES('link-report','self-hosted',?,'room-report',?,'T123','C123','1710000000.000100','active',?)").run(f.workspace.workspaceId,OWNER,Date.now());
    const receipt=await f.receipt("stripe",{result:{note:"<!channel> <https://fixture.invalid> &"}}),input={...f.input,receipts:[{approvalId:receipt.approvalId,inputHash:receipt.inputHash,resultDigest:receipt.resultDigest}]};
    const preview=await previewFounderEvidenceReport(f.env,f.owner,LIBRARY,input),{report}=await createFounderEvidenceReport(f.env,f.owner,LIBRARY,{...input,expectedReportHash:preview.reportHash,requestId:crypto.randomUUID()});
    const post=vi.fn(async()=>({channel:"C123",ts:"1710000009.000900"})),deps={verifyInstallation:async()=>({teamId:"T123",userId:"W123",botId:"B123"}),postMessage:post};
    const call=async(suffix:string,body:unknown)=>{const response=(await handleReportSlack(new Request(`https://shiba.test/api/founder-skills/${LIBRARY}/reports/${report.id}/slack${suffix}`,{method:"POST",headers:{Origin:"https://shiba.test","Content-Type":"application/json","X-Shiba-Workspace":f.workspace.workspaceId},body:JSON.stringify(body)}),f.env,deps))!;return {response,value:await response.json() as ReportSlackState&{error?:string}};};
    const prepared=await call("/preview",{requestId:crypto.randomUUID(),reportHash:report.reportHash,roomId:"room-report",linkId:"link-report",expiresAt:Date.now()+600000});
    expect(prepared.response.status,JSON.stringify(prepared.value)).toBe(200);const intent=prepared.value.intents[0]!;
    expect(intent.content).toContain("&lt;!channel&gt;");expect(post).not.toHaveBeenCalled();
    const decision={expectedVersion:1,digest:intent.digest,contentHash:intent.contentHash,expiresAt:intent.expiresAt,reviewed:true};
    expect((await call(`/intents/${intent.id}/disclose`,{...decision,disclosureConsent:"share-report-to-configured-slack-thread",audienceConsent:"all-people-with-access-to-selected-slack-channel-thread"})).response.status).toBe(200);
    session.email=ADMIN;const sent=await call(`/intents/${intent.id}/approve`,decision);expect(sent.response.status,JSON.stringify(sent.value)).toBe(200);
    expect(post).toHaveBeenCalledExactlyOnceWith("fixture-slack-token",expect.objectContaining({channel:"C123",threadTs:"1710000000.000100",text:intent.content}));
    expect(sent.value.intents[0]).toMatchObject({status:"sent"});expect((await call(`/intents/${intent.id}/approve`,decision)).response.status).toBe(409);expect(post).toHaveBeenCalledTimes(1);
    session.email=OWNER;f.sqlite.prepare("UPDATE workspace_app_connections SET issuer_id=?,issuer_account_id=?,issuer_version=?,issuer_role=? WHERE provider_key='stripe'").run(ADMIN,f.admin.accountId,f.admin.version,f.admin.role);
    await expect(loadFounderEvidenceReport(f.env,f.owner,LIBRARY,report.id,{requireExportOwnership:true})).rejects.toThrow("report_sources_changed");
    expect(post).toHaveBeenCalledTimes(1);
  });
});
