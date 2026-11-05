import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { ReportSlackIntent, ReportSlackState } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { createTeamWorkspace, getTeamWorkspaceMembership } from "../src/team-workspaces-store.js";
import { addCollaborationMember, createCollaborationRoom } from "../src/collaboration-store.js";
import { handleReportSlack } from "../src/report-slack-routes.js";
import { ensureReportSlackSchema, neutralizeReportSlackText, type ReportSlackDeps } from "../src/report-slack-store.js";
import { REPORT_SLACK_SCHEMA } from "../src/report-slack-schema.js";
import { postReportSlackMessage } from "../src/report-slack-sender.js";
import { ensureSlackInstallations, installationDigest, installationPurpose, installationSnapshot, type SlackInstallationRow } from "../src/slack-installations-store.js";
import { sealSlackSecret } from "../src/slack-installations-crypto.js";

const identity = vi.hoisted(() => ({ email: "owner@example.test", native: true, accounts: {} as Record<string, string>, afterLoad: undefined as (() => void) | undefined }));
vi.mock("../src/request-auth.js", async (original) => ({ ...await original<typeof import("../src/request-auth.js")>(), isAuthorizedRequest: async () => true, resolveUserId: async () => identity.email }));
vi.mock("@shiba/auth/better-auth", async (original) => ({ ...await original<typeof import("@shiba/auth/better-auth")>(), resolveBetterAuthSessionAccount: async () => identity.native
  ? { policy: { accountId: identity.accounts[identity.email], email: identity.email, kind: "invited", createdAt: 1 }, emailVerified: true } : null }));
// The report seam is an exact, private SQL fixture; actual report composition has its own SQLite/HTTP suite.
vi.mock("../src/founder-evidence-reports.js", () => ({
  loadFounderEvidenceReport: async (env: Env, member: { accountId: string }, _library: string, reportId: string, options: { requireExportOwnership: boolean }) => {
    const row = await env.AGENT_AUDIT.prepare("SELECT * FROM fixture_reports WHERE id=? AND account_id=? AND active=1 AND issuer_id=account_id").bind(reportId, member.accountId).first<{ id: string; report_hash: string; markdown: string; source_json: string; expires_at: number }>();
    if (!row || options.requireExportOwnership !== true) throw new Error("Private report source unavailable");
    const authority = { reportId: row.id, reportHash: row.report_hash, authorityJson: row.source_json, markdown: row.markdown, expiresAt: row.expires_at };
    const afterLoad = identity.afterLoad; identity.afterLoad = undefined; afterLoad?.();
    return { report: {}, authority };
  },
  founderEvidenceReportGuard: (authority: { reportId: string; reportHash: string; authorityJson: string; markdown: string; expiresAt: number }, options: { requireExportOwnership: boolean }) => {
    if (!options.requireExportOwnership) throw new Error("Ownership proof missing");
    return { sql: "EXISTS(SELECT 1 FROM fixture_reports WHERE id=? AND active=1 AND issuer_id=account_id AND report_hash=? AND source_json=? AND markdown=? AND expires_at=? AND expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))",
      values: [authority.reportId, authority.reportHash, authority.authorityJson, authority.markdown, authority.expiresAt] };
  },
}));

const OWNER = "owner@example.test", ADMIN = "approver@example.test", HASH = "a".repeat(64), REPORT = "report_fixture", LIBRARY = "founder-stripe-revenue-pulse";
beforeEach(() => { identity.email = OWNER; identity.native = true; identity.accounts = {}; identity.afterLoad = undefined; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture() {
  const db = customAgentD1();
  db.sqlite.exec('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT,emailVerified INTEGER); CREATE TABLE shiba_auth_account_policy(account_id TEXT PRIMARY KEY,email TEXT)');
  for (const email of [OWNER, ADMIN]) { identity.accounts[email] = crypto.randomUUID(); db.sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run(identity.accounts[email]!, email); db.sqlite.prepare("INSERT INTO shiba_auth_account_policy VALUES(?,?)").run(identity.accounts[email]!, email); }
  const env = { AGENT_AUDIT: db.database, SLACK_ROOM_OUTBOX_ENABLED: "true", SLACK_BOT_TOKEN: "fixture-bot-not-real", SLACK_APPROVALS_CHANNEL: "C123", DASHBOARD_APPROVERS: ADMIN,
    SLACK_CANVAS_OWNERS: JSON.stringify([{ teamId: "T123", channelId: "C123", ownerId: OWNER, viewerIds: [ADMIN] }]) } as unknown as Env;
  const workspace = await createTeamWorkspace(env, OWNER, { name: "Private report export" });
  db.sqlite.prepare("INSERT INTO team_workspace_memberships(tenant_id,workspace_id,user_id,role,status,version,joined_at) VALUES('self-hosted',?,?,'admin','active',1,1)").run(workspace.workspaceId, ADMIN);
  const scope = { tenantId: "self-hosted", workspaceId: workspace.workspaceId, userId: OWNER }, roomId = "room-report";
  await createCollaborationRoom(env, scope, { roomId, title: "Explicit report audience", visibility: "shared", createdAt: Date.now() });
  await addCollaborationMember(env, scope, roomId, { actorId: `human:${ADMIN}`, userId: ADMIN, displayName: ADMIN, kind: "human", createdAt: Date.now() });
  db.sqlite.prepare("INSERT INTO collaboration_slack_room_links VALUES(?,?,?,?,?,?,?,?,'active',?,NULL)").run("link-report", "self-hosted", workspace.workspaceId, roomId, OWNER, "T123", "C123", "1710000000.000100", Date.now());
  db.sqlite.exec("CREATE TABLE fixture_reports(id TEXT PRIMARY KEY,account_id TEXT,issuer_id TEXT,report_hash TEXT,source_json TEXT,markdown TEXT,expires_at INTEGER,active INTEGER)");
  db.sqlite.prepare("INSERT INTO fixture_reports VALUES(?,?,?,?,?,?,?,1)").run(REPORT, identity.accounts[OWNER]!, identity.accounts[OWNER]!, HASH, '{"exactReceipt":"completed-private"}', "One completed stored receipt. <!channel> <https://fixture.invalid/data> & quoted data.", Date.now() + 3_600_000);
  await ensureReportSlackSchema(env);
  const base = `https://shiba.test/api/founder-skills/${LIBRARY}/reports/${REPORT}/slack`;
  const call = async (suffix = "", body?: unknown, deps?: ReportSlackDeps, extra: Record<string, string> = {}, report = REPORT) => {
    const response = await handleReportSlack(new Request(base.replace(`/reports/${REPORT}/`, `/reports/${report}/`) + suffix, { method: body === undefined ? "GET" : "POST", headers: { Origin: "https://shiba.test", "Content-Type": "application/json", "X-Shiba-Workspace": workspace.workspaceId, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, deps);
    return { response: response!, value: await response!.json() as ReportSlackState & { error?: string } };
  };
  const input = () => ({ requestId: crypto.randomUUID(), reportHash: HASH, roomId, linkId: "link-report", expiresAt: Date.now() + 600_000 });
  const prepare = async () => { identity.email = OWNER; const request = input(), result = await call("/preview", request); expect(result.response.status, JSON.stringify(result.value)).toBe(200); return { request, intent: result.value.intents[0]! }; };
  const decision = (intent: ReportSlackIntent) => ({ expectedVersion: 1, digest: intent.digest, contentHash: intent.contentHash, expiresAt: intent.expiresAt, reviewed: true });
  const disclose = async (intent: ReportSlackIntent) => { identity.email = OWNER; return call(`/intents/${intent.id}/disclose`, { ...decision(intent), disclosureConsent: "share-report-to-configured-slack-thread", audienceConsent: "all-people-with-access-to-selected-slack-channel-thread" }); };
  const send = async (intent: ReportSlackIntent, deps?: ReportSlackDeps) => { identity.email = ADMIN; return call(`/intents/${intent.id}/approve`, decision(intent), deps); };
  return { ...db, env, call, input, prepare, disclose, send, decision, workspaceId: workspace.workspaceId, roomId };
}
async function managedInstallation(f: Awaited<ReturnType<typeof fixture>>) {
  Object.assign(f.env, { SLACK_INSTALLATIONS_ENABLED: "true", SLACK_OAUTH_APP_ID: "A123", SLACK_OAUTH_CLIENT_ID: "123.456", SLACK_OAUTH_REDIRECT_URI: "https://shiba.test/api/slack/installations/callback",
    SLACK_OAUTH_PKCE_ENABLED: "true", SLACK_OAUTH_QUERY_REDACTION_VERIFIED: "true", SLACK_SIGNING_SECRET: "fixture-only", SLACK_INSTALLATION_KEYRING: JSON.stringify({ activeKeyId: "v1", keys: { v1: "11".repeat(32) } }),
    SLACK_BOT_TOKEN: undefined, SLACK_APPROVALS_CHANNEL: "OTHER_LEGACY_CHANNEL" });
  await ensureSlackInstallations(f.env);
  const member = await getTeamWorkspaceMembership(f.env, f.workspaceId, OWNER);
  const row: SlackInstallationRow = { id: "managed-report-install", workspace_id: f.workspaceId, owner_id: OWNER, owner_account_id: identity.accounts[OWNER]!, owner_member_json: JSON.stringify({ ...member, accountId: identity.accounts[OWNER] }),
    app_id: "A123", team_id: "T123", bot_user_id: "U_MANAGED", bot_id: "B_MANAGED", installer_slack_user_id: "U_INSTALLER", scopes_json: '["chat:write"]', generation: 1, version: 1, token_revision: 1, state: "active", digest: "", token_key_id: null, token_cipher: null, token_expires_at: null, activation_expires_at: Date.now() + 600_000, created_at: Date.now(), refresh_claim_id: null };
  row.digest = await installationDigest(row);
  const sealed = await sealSlackSecret(f.env, { workspaceId: f.workspaceId, subject: row.id, purpose: installationPurpose(installationSnapshot(row)) }, JSON.stringify({ accessToken: "managed-tenant-fixture-token", expiresAt: null })); row.token_key_id = sealed.keyId; row.token_cipher = sealed.cipher;
  f.sqlite.prepare(`INSERT INTO slack_installations(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row) as never[]);
  return row;
}

describe("native one-shot report disclosure and Slack delivery", () => {
  it("keeps drafts private, requires explicit disclosure and a separate exact human send, and never creates a human room message", async () => {
    const f = await fixture(), { intent } = await f.prepare();
    expect(intent.canDisclose).toBe(true); expect(intent.content).toContain("&lt;!channel&gt;"); expect(intent.content).toContain("Completeness and business success are unverified");
    identity.email = ADMIN; expect((await f.call()).value.intents).toEqual([]);
    const post = vi.fn(async () => ({ channel: "C123", ts: "1710000009.000900" })), verify = vi.fn(async () => ({ teamId: "T123", userId: "W123", botId: "B123" }));
    expect((await f.send(intent, { verifyInstallation: verify, postMessage: post })).response.status).toBe(404);
    expect((await f.disclose(intent)).response.status).toBe(200);
    const result = await f.send(intent, { verifyInstallation: verify, postMessage: post });
    expect(result.response.status, JSON.stringify(result.value)).toBe(200); expect(result.value.intents[0]).toMatchObject({ status: "sent", approvedByUserId: ADMIN, receiptTs: "1710000009.000900", canApprove: false });
    expect(post).toHaveBeenCalledExactlyOnceWith("fixture-bot-not-real", expect.objectContaining({ channel: "C123", threadTs: "1710000000.000100", text: intent.content }));
    expect((await f.send(intent, { verifyInstallation: verify, postMessage: post })).response.status).toBe(409); expect(post).toHaveBeenCalledTimes(1);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM collaboration_messages").get()).toMatchObject({ n: 0 });
  });
  it("deduplicates exact prepare requests without extending expiry and rejects changed or duplicate delivery IDs", async () => {
    const f = await fixture(), { request, intent } = await f.prepare();
    expect((await f.call("/preview", request)).value.intents[0]?.id).toBe(intent.id);
    expect((await f.call("/preview", { ...request, expiresAt: request.expiresAt + 1 })).response.status).toBe(409);
    expect((await f.call("/preview", { ...request, requestId: crypto.randomUUID() })).response.status).toBe(409);
    expect(f.sqlite.prepare("SELECT count(*) AS n,expires_at FROM report_slack_deliveries").get()).toMatchObject({ n: 1, expires_at: request.expiresAt });
  });
  it.each(["native", "source-owner", "configured", "audience"])("fails closed without %s authority", async (which) => {
    const f = await fixture();
    if (which === "native") identity.native = false;
    if (which === "source-owner") f.sqlite.prepare("UPDATE fixture_reports SET issuer_id='other-native-uuid'").run();
    if (which === "configured") f.env.SLACK_ROOM_OUTBOX_ENABLED = "false";
    if (which === "audience") f.env.SLACK_CANVAS_OWNERS = JSON.stringify([{ teamId: "T123", channelId: "C123", ownerId: OWNER }]);
    const result = await f.call("/preview", f.input()); expect(result.response.status).toBeGreaterThanOrEqual(400);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM report_slack_deliveries").get()).toMatchObject({ n: 0 });
  });
  it("binds disclosure bytes, digest, deadline and explicit consent", async () => {
    const f = await fixture(), { intent } = await f.prepare();
    expect((await f.call(`/intents/${intent.id}/disclose`, f.decision(intent))).response.status).toBe(400);
    expect((await f.call(`/intents/${intent.id}/disclose`, { ...f.decision(intent), digest: "f".repeat(64), disclosureConsent: "share-report-to-configured-slack-thread", audienceConsent: "all-people-with-access-to-selected-slack-channel-thread" })).response.status).toBe(409);
    expect((await f.disclose(intent)).value.intents[0]?.status).toBe("disclosed");
    expect((await f.call(`/intents/${intent.id}/approve`, f.decision(intent))).response.status).toBe(403);
  });
  it.each(["source", "policy", "author", "approver", "link", "expiry", "session"])("rechecks %s after delayed bot authentication with zero posts", async (which) => {
    const f = await fixture(), { intent } = await f.prepare(); await f.disclose(intent);
    const post = vi.fn(async () => ({ channel: "C123", ts: "1.1" }));
    const result = await f.send(intent, { verifyInstallation: async () => {
      if (which === "source") f.sqlite.prepare("UPDATE fixture_reports SET active=0").run();
      if (which === "policy") f.env.SLACK_CANVAS_OWNERS = "[]";
      if (which === "author") f.sqlite.prepare("UPDATE collaboration_memberships SET status='removed' WHERE user_id=?").run(OWNER);
      if (which === "approver") f.env.DASHBOARD_APPROVERS = "";
      if (which === "link") f.sqlite.prepare("UPDATE collaboration_slack_room_links SET status='revoked'").run();
      if (which === "expiry") f.sqlite.prepare("UPDATE fixture_reports SET expires_at=1").run();
      if (which === "session") identity.native = false;
      return { teamId: "T123", userId: "W123", botId: "B123" };
    }, postMessage: post });
    expect(result.response.status).toBeLessThan(500); expect(post).not.toHaveBeenCalled();
    expect(f.sqlite.prepare("SELECT state FROM report_slack_deliveries").get()).toMatchObject({ state: "blocked" });
  });
  it("keeps membership remove/readd blocked and does not leak revoked report content", async () => {
    const f = await fixture(), { intent } = await f.prepare(); await f.disclose(intent);
    f.sqlite.prepare("UPDATE collaboration_memberships SET status='removed' WHERE user_id=?").run(ADMIN);
    f.sqlite.prepare("UPDATE collaboration_memberships SET status='active' WHERE user_id=?").run(ADMIN);
    expect(f.sqlite.prepare("SELECT state FROM report_slack_deliveries").get()).toMatchObject({ state: "blocked" });
    f.sqlite.prepare("UPDATE fixture_reports SET active=0").run(); identity.email = ADMIN;
    expect((await f.call()).value.intents).toEqual([]);
  });
  it.each(["source", "intent", "audience"])("fences cached %s in the final read snapshot", async (which) => {
    const f = await fixture(), { intent } = await f.prepare(); await f.disclose(intent);
    let loads = 0;
    const change = () => {
      loads++;
      if (loads < 2) { identity.afterLoad = change; return; }
      if (which === "source") f.sqlite.prepare("UPDATE fixture_reports SET active=0").run();
      if (which === "intent") f.sqlite.prepare("UPDATE report_slack_deliveries SET state='cancelled'").run();
      if (which === "audience") f.sqlite.prepare("UPDATE collaboration_memberships SET status='removed' WHERE user_id=?").run(ADMIN);
    };
    identity.afterLoad = change;
    const result = await f.call(); expect(result.response.status).toBe(200); expect(result.value.intents).toEqual([]);
    if (which !== "intent") expect(result.value.destinations).toEqual([]);
  });
  it("retains unknown outcomes, blocks new IDs and never retries", async () => {
    const f = await fixture(), { request, intent } = await f.prepare(); await f.disclose(intent);
    const post = vi.fn(async () => { throw new Error("Transport lost after potential acceptance"); }), deps = { verifyInstallation: async () => ({ teamId: "T123", userId: "W123", botId: "B123" }), postMessage: post };
    expect((await f.send(intent, deps)).value.intents[0]?.status).toBe("unknown");
    expect((await f.send(intent, deps)).response.status).toBe(409); expect(post).toHaveBeenCalledTimes(1);
    identity.email = OWNER; expect((await f.call("/preview", { ...request, requestId: crypto.randomUUID() })).response.status).toBe(409);
    f.sqlite.prepare("INSERT INTO fixture_reports SELECT 'report-clone',account_id,issuer_id,report_hash,source_json,markdown,expires_at,active FROM fixture_reports WHERE id=?").run(REPORT);
    expect((await f.call("/preview", { ...request, requestId: crypto.randomUUID() }, undefined, {}, "report-clone")).response.status).toBe(409);
  });
  it("latches a completed report hash even under a new report ID and request UUID", async () => {
    const f = await fixture(), { request, intent } = await f.prepare(); await f.disclose(intent);
    const post = vi.fn(async () => ({ channel: "C123", ts: "1.1" }));
    await f.send(intent, { verifyInstallation: async () => ({ teamId: "T123", userId: "W123", botId: "B123" }), postMessage: post });
    identity.email = OWNER;
    f.sqlite.prepare("INSERT INTO fixture_reports SELECT 'report-clone',account_id,issuer_id,report_hash,source_json,markdown,expires_at,active FROM fixture_reports WHERE id=?").run(REPORT);
    expect((await f.call("/preview", { ...request, requestId: crypto.randomUUID() }, undefined, {}, "report-clone")).response.status).toBe(409);
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized Unicode content without truncation or delivery", async () => {
    const f = await fixture(); f.sqlite.prepare("UPDATE fixture_reports SET markdown=?").run("狗".repeat(1_200));
    expect((await f.call("/preview", f.input())).response.status).toBe(413);
    expect(() => neutralizeReportSlackText("a".repeat(4_000))).toThrow("report_slack_content_too_large");
  });
  it("requires same-origin JSON and rejects forged native IDs and unexpected approval fields", async () => {
    const f = await fixture();
    expect((await f.call("/preview", f.input(), undefined, { Origin: "https://outsider.invalid" })).response.status).toBe(403);
    expect((await f.call("/preview", { ...f.input(), ownerAccountId: identity.accounts[OWNER] })).response.status).toBe(400);
    expect((await f.call("/preview", f.input(), undefined, { "Content-Type": "text/plain" })).response.status).toBe(415);
  });
  it("applies migration to a fresh database twice and preserves runtime schema parity", () => {
    const sqlite = new DatabaseSync(":memory:"), migration = readFileSync(new URL("../migrations/0016_report_slack_deliveries.sql", import.meta.url), "utf8");
    sqlite.exec(migration); sqlite.exec(migration);
    for (const sql of REPORT_SLACK_SCHEMA) sqlite.exec(sql);
    expect(sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'report_slack_%'").get()).toMatchObject({ n: 9 }); sqlite.close();
  });
  it("pins a managed installation and uses only that token for an explicitly allowed channel", async () => {
    const f = await fixture(), installation = await managedInstallation(f), { intent } = await f.prepare();
    expect(intent.destination.installation).toMatchObject({ id: installation.id, generation: 1, ownerAccountId: identity.accounts[OWNER] });
    await f.disclose(intent);
    const post = vi.fn(async () => ({ channel: "C123", ts: "1.1" })), verify = vi.fn(async (token: string) => { expect(token).toBe("managed-tenant-fixture-token"); return { teamId: "T123", userId: "U_MANAGED", botId: "B_MANAGED" }; });
    const result = await f.send(intent, { verifyInstallation: verify, postMessage: post }); expect(result.response.status, JSON.stringify(result.value)).toBe(200); expect(result.value.intents[0]?.status).toBe("sent");
    expect(post).toHaveBeenCalledExactlyOnceWith("managed-tenant-fixture-token", expect.objectContaining({ channel: "C123" }));
  });
  it.each(["generation", "bot", "mode"])("never falls back after managed installation %s changes", async (which) => {
    const f = await fixture(); await managedInstallation(f); const { intent } = await f.prepare(); await f.disclose(intent);
    f.env.SLACK_BOT_TOKEN = "legacy-token-must-never-send";
    const post = vi.fn(async () => ({ channel: "C123", ts: "1.1" }));
    const result = await f.send(intent, { verifyInstallation: async () => {
      if (which === "generation") f.sqlite.prepare("UPDATE slack_installations SET generation=generation+1,version=version+1").run();
      if (which === "mode") f.env.SLACK_INSTALLATIONS_ENABLED = "false";
      return { teamId: "T123", userId: which === "bot" ? "OTHER_BOT" : "U_MANAGED", botId: "B_MANAGED" };
    }, postMessage: post });
    expect(result.response.status).toBeLessThan(500); expect(post).not.toHaveBeenCalled(); expect(f.sqlite.prepare("SELECT state FROM report_slack_deliveries").get()).toMatchObject({ state: "blocked" });
  });
  it.each(["active", "revoked"])("does not prepare a new legacy send to a historically managed team with mode off: %s", async (state) => {
    const f=await fixture();await managedInstallation(f);f.sqlite.prepare("UPDATE slack_installations SET state=?").run(state);
    f.env.SLACK_INSTALLATIONS_ENABLED="false";f.env.SLACK_BOT_TOKEN="operator-token-must-not-borrow";f.env.SLACK_APPROVALS_CHANNEL="C123";
    expect((await f.call("/preview",f.input())).response.status).toBe(403);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM report_slack_deliveries").get()).toMatchObject({n:0});
  });
  it("does not send when the final SQL reply arrives after the original disclosure deadline",async()=>{
    const f=await fixture(),{intent}=await f.prepare();await f.disclose(intent);const prepare=f.database.prepare.bind(f.database);let crossed=false;
    const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(statement,{get(target,key){
      if(key==="bind")return(...args:unknown[])=>wrap(target.bind(...args),sql);
      if(key==="first")return async(...args:unknown[])=>{const result=await Reflect.apply(target.first,target,args);if(result&&!crossed&&sql.includes("FROM report_slack_deliveries WHERE id=? AND state='sending' AND digest=?")){crossed=true;vi.spyOn(Date,"now").mockReturnValue(intent.expiresAt+1);}return result;};
      const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
    }});
    vi.spyOn(f.database,"prepare").mockImplementation(sql=>wrap(prepare(sql),sql));
    const post=vi.fn(async()=>({channel:"C123",ts:"1.1"}));await f.send(intent,{verifyInstallation:async()=>({teamId:"T123",userId:"U_LEGACY",botId:"B_LEGACY"}),postMessage:post});
    expect(crossed).toBe(true);expect(post).not.toHaveBeenCalled();expect(f.sqlite.prepare("SELECT state FROM report_slack_deliveries").get()).toMatchObject({state:"blocked"});
  });
});

describe("isolated Slack report HTTP projection", () => {
  it("posts the exact frozen plain text without mentions, unfurls, broadcasting, redirects or retries", async () => {
    const transport = vi.fn(async () => Response.json({ ok: true, channel: "C123", ts: "1710000000.100000" })); vi.stubGlobal("fetch", transport);
    await expect(postReportSlackMessage("fixture-token", { channel: "C123", threadTs: "1.2", text: "&lt;!channel&gt;", clientMsgId: crypto.randomUUID() })).resolves.toEqual({ channel: "C123", ts: "1710000000.100000" });
    expect(transport).toHaveBeenCalledTimes(1); const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/chat.postMessage"); expect(init.redirect).toBe("manual");
    expect(JSON.parse(String(init.body))).toMatchObject({ mrkdwn: false, parse: "none", link_names: false, reply_broadcast: false, unfurl_links: false, unfurl_media: false, unfurl_app_links: false, text: "&lt;!channel&gt;" });
  });
  it.each([{ ok: true, channel: "C123", ts: "1.1", warning: "message_truncated" }, { ok: true }, { ok: false, error: "internal_error" }])("does not mistake an incomplete or uncertain Slack receipt for delivery", async (value) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(value)));
    await expect(postReportSlackMessage("fixture-token", { channel: "C123", threadTs: "1.2", text: "Bound report", clientMsgId: crypto.randomUUID() })).rejects.toThrow();
  });
});
