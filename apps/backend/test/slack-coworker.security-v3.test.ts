import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { beginSlackCoworkerBinding, confirmSlackCoworkerBinding, observeSlackCoworkerChallenge, confirmSlackCoworkerOnSlack, grantSlackCoworkerIntake, intakeSlackCoworkerEvent, readSlackCoworkerState } from "../src/slack-coworker-store.js";
import { installationSnapshot, type SlackInstallationEnv, type SlackInstallationRow } from "../src/slack-installations-store.js";
import { handleMultiInstallationSlackCallback } from "../src/slack-installations-routing.js";

import { handleSlackCoworker } from "../src/slack-coworker-routes.js";
const queue = vi.hoisted(() => ({ calls: 0, input: undefined as Record<string, unknown> | undefined, status: 201, fail: false }));
vi.mock("../src/collaboration-routes.js", () => ({ handleCollaboration: async (request: Request) => { queue.calls++; queue.input=await request.json() as Record<string,unknown>; if(queue.fail) throw new Error("unknown queue outcome"); return Response.json({privateTask:"must not leak"},{status:queue.status}); } }));
const native = vi.hoisted(() => ({ calls: 0, hook: undefined as (() => void) | undefined }));
vi.mock("../src/request-auth.js", async original => ({ ...await original<typeof import("../src/request-auth.js")>(), isAuthorizedRequest: async () => true, resolveUserId: async () => "owner@example.test" }));
vi.mock("@shiba/auth/better-auth", async original => ({ ...await original<typeof import("@shiba/auth/better-auth")>(), resolveBetterAuthSessionAccount: async () => { native.calls++; native.hook?.(); return { policy: { accountId: "native1", email: "owner@example.test", kind: "invited" }, emailVerified: true }; } }));
beforeEach(() => { queue.calls=0;queue.input=undefined;queue.status=201;queue.fail=false; native.calls = 0; native.hook = undefined; });
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

async function signedCallback(f: ReturnType<typeof fixture>, path: string, payload: unknown) {
  f.env.SLACK_INSTALLATIONS_ENABLED = "true"; f.env.SLACK_OAUTH_APP_ID = "A1"; f.env.SLACK_SIGNING_SECRET = "independent-fixture-secret";
  const body = typeof payload === "string" ? payload : JSON.stringify(payload), timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(f.env.SLACK_SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`))).toString("hex");
  return handleMultiInstallationSlackCallback(new Request(`https://shiba.test/api/slack/${path}`, { method: "POST", headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${mac}`, "content-type": path === "events" ? "application/json" : "application/x-www-form-urlencoded" }, body }), f.env);
}
describe("independent Slack identity security v3", () => {
  it("atomically consumes an observed identity once under concurrent native confirmations", async () => {
    const f = fixture(), c = await beginSlackCoworkerBinding(f.env, f.member, f.installation);
    await observeSlackCoworkerChallenge(f.env, f.installation, c.secret, "UHUMAN"); await confirmSlackCoworkerOnSlack(f.env, f.installation, c.id, "UHUMAN", true);
    const results = await Promise.allSettled([confirmSlackCoworkerBinding(f.env, f.member, f.installation, c.id, "UHUMAN"), confirmSlackCoworkerBinding(f.env, f.member, f.installation, c.id, "UHUMAN")]);
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM slack_coworker_bindings").get()).toEqual({ n: 1 });
  });
  it("rejects same-email replacement UUID without consuming the original challenge", async () => {
    const f = fixture(), c = await beginSlackCoworkerBinding(f.env, f.member, f.installation);
    await observeSlackCoworkerChallenge(f.env, f.installation, c.secret, "UHUMAN"); await confirmSlackCoworkerOnSlack(f.env, f.installation, c.id, "UHUMAN", true);
    await expect(confirmSlackCoworkerBinding(f.env, { ...f.member, accountId: "replacement" }, f.installation, c.id, "UHUMAN")).rejects.toThrow();
    expect(f.sqlite.prepare("SELECT state FROM slack_coworker_challenges").get()).toEqual({ state: "slack_confirmed" });
  });
  it("signed ambiguous user identity cannot observe a challenge", async () => {
    const f = fixture(), c = await beginSlackCoworkerBinding(f.env, f.member, f.installation);
    const body = new URLSearchParams({ api_app_id: "A1", team_id: "T1", command: "/shiba-link", user_id: "UONE", text: c.secret }); body.append("user_id", "UTWO");
    expect((await signedCallback(f, "command", body.toString()))?.status).toBe(200);
    expect(f.sqlite.prepare("SELECT state,slack_user_id FROM slack_coworker_challenges").get()).toEqual({ state: "pending", slack_user_id: null });
  });
  it("confirmed identity plus signed private-channel mention/approval payload confers no execution or membership", async () => {
    const f = fixture(), c = await beginSlackCoworkerBinding(f.env, f.member, f.installation);
    await observeSlackCoworkerChallenge(f.env, f.installation, c.secret, "UHUMAN"); await confirmSlackCoworkerOnSlack(f.env, f.installation, c.id, "UHUMAN", true); await confirmSlackCoworkerBinding(f.env, f.member, f.installation, c.id, "UHUMAN");
    const memberships = f.sqlite.prepare("SELECT * FROM team_workspace_memberships").all(), forbidden = vi.fn(() => { throw new Error("unexpected execution authority"); });
    for (const name of ["AI", "CodingOrchestrator", "Sandbox", "ModelConfig", "AI_GATEWAY_TOKEN", "SLACK_BOT_TOKEN", "OPEN_CONNECTOR"]) Object.defineProperty(f.env, name, { get: forbidden });
    expect((await signedCallback(f, "events", { type: "event_callback", api_app_id: "A1", team_id: "T1", event_id: "EV_PRIVATE", event: { type: "app_mention", user: "UHUMAN", channel: "GPRIVATE", text: "approve and run using operator billing" } }))?.status).toBe(200);
    const interaction = new URLSearchParams({ payload: JSON.stringify({ api_app_id: "A1", team: { id: "T1" }, user: { id: "UHUMAN" }, actions: [{ action_id: "approve", value: "other-approval" }] }) });
    expect((await signedCallback(f, "interact", interaction.toString()))?.status).toBe(200);
    expect(forbidden).not.toHaveBeenCalled(); expect(f.sqlite.prepare("SELECT * FROM team_workspace_memberships").all()).toEqual(memberships);
    expect((await readSlackCoworkerState(f.env, f.member)).executionAvailable).toBe(false);
  });
});

describe("independent Slack planting and source revocation v3", () => {
  it("a planted code cannot bind until the observed Slack user explicitly accepts the native principal", async () => {
    const f = fixture(), c = await beginSlackCoworkerBinding(f.env, f.member, f.installation);
    const body = new URLSearchParams({ api_app_id: "A1", team_id: "T1", command: "/shiba-link", user_id: "UVICTIM", text: c.secret });
    const response = await signedCallback(f, "command", body.toString()), content = await response!.text();
    expect(content).toContain(f.member.userId); expect(content).toContain(f.member.accountId); expect(content).toContain(f.member.workspaceId);
    await expect(confirmSlackCoworkerBinding(f.env, f.member, f.installation, c.id, "UVICTIM")).rejects.toThrow();
    const accept = (user: string) => new URLSearchParams({ payload: JSON.stringify({ type: "block_actions", api_app_id: "A1", team: { id: "T1" }, user: { id: user }, actions: [{ action_id: "shiba_link_accept", value: c.id }] }) }).toString();
    await signedCallback(f, "interact", accept("UATTACKER"));
    await expect(confirmSlackCoworkerBinding(f.env, f.member, f.installation, c.id, "UVICTIM")).rejects.toThrow();
    await signedCallback(f, "interact", accept("UVICTIM"));
    expect((await confirmSlackCoworkerBinding(f.env, f.member, f.installation, c.id, "UVICTIM")).slackUserId).toBe("UVICTIM");
  });
  it("withholds a draft if its installation is revoked during final native authentication", async () => {
    const f = fixture(), c = await beginSlackCoworkerBinding(f.env, f.member, f.installation);
    await observeSlackCoworkerChallenge(f.env, f.installation, c.secret, "UHUMAN"); await confirmSlackCoworkerOnSlack(f.env, f.installation, c.id, "UHUMAN", true);
    const binding = await confirmSlackCoworkerBinding(f.env, f.member, f.installation, c.id, "UHUMAN");
    await grantSlackCoworkerIntake(f.env, f.member, binding.id, "GPRIVATE", "123.0001");
    expect(await intakeSlackCoworkerEvent(f.env, f.installation, "EVFUTURE", { user: "UHUMAN", channel: "GPRIVATE", thread_ts: "123.0001", ts: `${Math.floor(Date.now() / 1000) + 1}.0001`, text: "private revoked draft" })).toBe(true);
    f.env.SLACK_INSTALLATIONS_ENABLED = "true";
    native.hook = () => { if (native.calls === 2) f.sqlite.exec("UPDATE slack_installations SET state='revoked'"); };
    const response = await handleSlackCoworker(new Request("https://shiba.test/api/slack/coworker/drafts", { headers: { "X-Shiba-Workspace": f.member.workspaceId } }), f.env);
    expect(native.calls).toBe(2);
    expect(f.sqlite.prepare("SELECT state FROM slack_installations").get()).toEqual({ state: "revoked" });
    expect(await response!.text()).not.toContain("private revoked draft");
  });
});

async function submissionFixture() {
  const f=fixture(); f.env.SLACK_INSTALLATIONS_ENABLED="true";
  const c=await beginSlackCoworkerBinding(f.env,f.member,f.installation);
  await observeSlackCoworkerChallenge(f.env,f.installation,c.secret,"UHUMAN");
  await confirmSlackCoworkerOnSlack(f.env,f.installation,c.id,"UHUMAN",true);
  const binding=await confirmSlackCoworkerBinding(f.env,f.member,f.installation,c.id,"UHUMAN");
  await grantSlackCoworkerIntake(f.env,f.member,binding.id,"GPRIVATE","123.0001");
  await intakeSlackCoworkerEvent(f.env,f.installation,"ESUBMIT",{user:"UHUMAN",channel:"GPRIVATE",thread_ts:"123.0001",ts:`${Math.floor(Date.now()/1000)+1}.0001`,text:"Execute only on my paired local computer"});
  const draft=f.sqlite.prepare("SELECT id FROM slack_coworker_drafts").get() as {id:string};
  const body={id:draft.id,roomId:"room_"+"2".repeat(24),recipientActorId:"agent:helper",personalExecution:{grantId:"plex_"+"3".repeat(32),expectedVersion:1},reviewed:true};
  const request=(input:unknown=body)=>new Request("https://shiba.test/api/slack/coworker/drafts/submit",{method:"POST",headers:{Origin:"https://shiba.test","Content-Type":"application/json","X-Shiba-Workspace":f.member.workspaceId},body:JSON.stringify(input)});
  return {...f,body,request};
}
describe("native-reviewed Slack execution bridge",()=>{
  it("queues the signed draft with only a selected personal execution grant, not an approval",async()=>{
    const f=await submissionFixture();
    const response=await handleSlackCoworker(f.request(),f.env);
    expect(response?.status).toBe(201);
    expect(await response?.json()).toMatchObject({state:"queued",approvalRequired:true});
    expect(queue.input).toMatchObject({task:"Execute only on my paired local computer",personalExecution:f.body.personalExecution,budget:0,grantedCapabilities:["room.read","message.send"]});
    expect(queue.input).not.toHaveProperty("approved");
    expect((await handleSlackCoworker(f.request(),f.env))?.status).toBe(409);
    expect(queue.calls).toBe(1);
  });
  it.each([{reviewed:false},{runtime:"cloud"},{personalExecution:undefined},{recipientActorId:"human:other"}])("rejects missing consent and scope overrides %j",async change=>{
    const f=await submissionFixture();
    expect((await handleSlackCoworker(f.request({...f.body,...change}),f.env))?.status).toBe(400);
    expect(queue.calls).toBe(0);
  });
  it("does not expose the downstream private body or replay uncertain effects",async()=>{
    const f=await submissionFixture();queue.fail=true;
    const response=await handleSlackCoworker(f.request(),f.env);
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({state:"unknown",approvalRequired:true});
    expect((await handleSlackCoworker(f.request(),f.env))?.status).toBe(409);
    expect(queue.calls).toBe(1);
  });
  it("rechecks native authority after claiming and before queue effects",async()=>{
    const f=await submissionFixture();native.hook=()=>{if(native.calls===3)f.sqlite.exec("UPDATE user SET emailVerified=0");};
    expect((await handleSlackCoworker(f.request(),f.env))?.status).toBe(503);
    expect(queue.calls).toBe(0);
  });
});
