import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { createTeamWorkspace, getTeamWorkspaceMembership } from "../src/team-workspaces-store.js";
import { createStripeDraft, getStripeGrant, stripeTransition, revokeStripeGrant, type StripeEnv } from "../src/founder-stripe-store.js";
import { tickFounderStripeReads, verifyFounderStripeAccount } from "../src/founder-stripe-runtime.js";
import { handleFounderStripeReads } from "../src/founder-stripe-routes.js";
vi.mock("../src/request-auth.js", async original => ({ ...await original<typeof import("../src/request-auth.js")>(), isAuthorizedRequest: async () => true, resolveUserId: async () => "stripe-owner@example.test" }));
vi.mock("@shiba/auth/better-auth", async original => ({ ...await original<typeof import("@shiba/auth/better-auth")>(), resolveBetterAuthSessionAccount: async () => ({ policy: { accountId: "native-owner", email: "stripe-owner@example.test", kind: "invited" }, emailVerified: true, sessionId: "session-fixture", sessionExpiresAt: Date.now()+86400000 }) }));
const email="stripe-owner@example.test", account="native-owner";
const session=()=>({id:"session-fixture",expiresAt:Date.now()+86400000});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
async function fixture(){const db=customAgentD1();db.sqlite.exec('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT UNIQUE,emailVerified INTEGER);CREATE TABLE shiba_auth_account_policy(account_id TEXT PRIMARY KEY,email TEXT)');db.sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run(account,email);db.sqlite.prepare('INSERT INTO shiba_auth_account_policy VALUES(?,?)').run(account,email);db.sqlite.exec('CREATE TABLE "session"(id TEXT PRIMARY KEY,userId TEXT,expiresAt INTEGER)');db.sqlite.prepare('INSERT INTO "session" VALUES(?,?,?)').run('session-fixture',account,Date.now()+86400000);db.sqlite.exec(readFileSync(new URL('../migrations/0027_founder_stripe_reads.sql',import.meta.url),'utf8'));const env={AGENT_AUDIT:db.database,FOUNDER_STRIPE_READS_ENABLED:"true",FOUNDER_STRIPE_CREDENTIAL_KEY:"ab".repeat(32)} as StripeEnv;const workspace=await createTeamWorkspace(env,email,{name:"Stripe fixture"}),member={...(await getTeamWorkspaceMembership(env,workspace.workspaceId,email))!,accountId:account};const input={accountId:"acct_Fixture",mode:"test",restrictedKey:`rk_test_${"F".repeat(24)}`,expiresAt:Date.now()+86400000,maxCalls:2,selection:{kind:"balance_transactions",createdGte:100,createdLt:200,limit:2},readOnlyAttestation:"restricted-key-read-only-for-selected-resources"};return{db,env,member,input};}

async function enabled() {
  const f = await fixture(), draft = await createStripeDraft(f.env, f.member, f.input, session());
  const network = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ object: "account", id: "acct_Fixture" })); vi.stubGlobal("fetch", network);
  await verifyFounderStripeAccount(f.env, f.member, draft.id, draft.digest, session());
  await stripeTransition(f.env, f.member, draft.id, "verified", "enabled", draft.digest, session());
  f.db.sqlite.prepare("UPDATE founder_stripe_read_grants SET next_due_at=? WHERE id=?").run(Date.now() - 1000, draft.id);
  network.mockClear(); network.mockImplementation(async () => Response.json({ object: "list", has_more: false, data: [] }));
  return { ...f, draft, network };
}
describe("independent Stripe lifecycle security v3", () => {
  it("does not call Stripe after revocation arrives with the successful reservation acknowledgement", async () => {
    const f = await enabled(), batch = f.env.AGENT_AUDIT.batch.bind(f.env.AGENT_AUDIT);
    let injected = false;
    f.env.AGENT_AUDIT.batch = async <T = unknown>(statements: D1PreparedStatement[]) => {
      const result = await batch<T>(statements);
      if (!injected) { injected = true; await revokeStripeGrant(f.env, f.member, f.draft.id, f.draft.digest, session()); }
      return result;
    };
    await tickFounderStripeReads(f.env);
    expect(injected).toBe(true); expect(f.network).not.toHaveBeenCalled();
    expect(f.db.sqlite.prepare("SELECT used_calls,state,ciphertext FROM founder_stripe_read_grants").get()).toEqual({ used_calls: 2, state: "revoked", ciphertext: "" });
  });
  it("competing ticks consume exactly one call and do not retry an unknown response", async () => {
    const f = await enabled(); f.network.mockRejectedValue(new Error("fixture unknown provider outcome"));
    await Promise.all([tickFounderStripeReads(f.env), tickFounderStripeReads(f.env)]); await tickFounderStripeReads(f.env);
    expect(f.network).toHaveBeenCalledTimes(1);
    expect(f.db.sqlite.prepare("SELECT used_calls,state FROM founder_stripe_read_grants").get()).toEqual({ used_calls: 2, state: "blocked" });
    expect(f.db.sqlite.prepare("SELECT state,report_json FROM founder_stripe_read_receipts").all()).toEqual([{ state: "unknown", report_json: null }]);
  });
});

describe("independent Stripe report source security v3", () => {
  it("does not revive an original source grant after native workspace removal and re-add", async () => {
    const f = await enabled(); await tickFounderStripeReads(f.env);
    const receipt = f.db.sqlite.prepare("SELECT id FROM founder_stripe_read_receipts WHERE state='completed'").get()!;
    const request = () => new Request(`https://shiba.test/api/founder-stripe-reads/${f.draft.id}/reports/${receipt.id}`, { headers: { "X-Shiba-Workspace": f.member.workspaceId, cookie: "better-auth.session_token=fixture" } });
    expect((await handleFounderStripeReads(request(), f.env))?.status).toBe(200);
    f.db.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed',version=version+1 WHERE workspace_id=? AND user_id=?").run(f.member.workspaceId, f.member.userId);
    f.db.sqlite.prepare("UPDATE team_workspace_memberships SET status='active',version=version+1 WHERE workspace_id=? AND user_id=?").run(f.member.workspaceId, f.member.userId);
    const response = await handleFounderStripeReads(request(), f.env);
    expect(response!.status).not.toBe(200); expect(await response!.text()).not.toContain("shiba.stripe-read-report.v1");
  });
});

function holdFinalProof(env: StripeEnv, needle: string) {
  let arrived!: () => void, release!: () => void, held = false;
  const ready = new Promise<void>(resolve => { arrived = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const prepare = env.AGENT_AUDIT.prepare.bind(env.AGENT_AUDIT);
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, { get(target, property) {
    if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
    if (property === "first") return async () => { const result = await target.first(); if (!held && sql.includes(needle)) { held = true; arrived(); await gate; } return result; };
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
  vi.spyOn(env.AGENT_AUDIT, "prepare").mockImplementation(sql => wrap(prepare(sql), sql));
  return { ready, release };
}
describe("independent Stripe held-proof lease security v3", () => {
  it.each(["verify", "scheduled-read"])("does not dispatch %s when a final positive SQL proof arrives after lease expiry", async mode => {
    const f = mode === "scheduled-read" ? await enabled() : await (async () => {
      const f = await fixture(), draft = await createStripeDraft(f.env, f.member, f.input, session());
      const network = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ object: "account", id: "acct_Fixture" })); vi.stubGlobal("fetch", network);
      return { ...f, draft, network };
    })();
    const hold = holdFinalProof(f.env, "FROM founder_stripe_read_grants WHERE id=? AND revision=? AND contract_digest=? AND ciphertext=? AND state=?");
    const running = (mode === "verify" ? verifyFounderStripeAccount(f.env, f.member, f.draft.id, f.draft.digest, session()) : tickFounderStripeReads(f.env)).catch(() => undefined);
    await hold.ready; vi.spyOn(Date, "now").mockReturnValue(f.input.expiresAt + 1); hold.release(); await running;
    expect(f.network).not.toHaveBeenCalled();
  });
  it.each(["grant", "receipt"])("withholds report bytes when the final positive SQL proof arrives after %s lease expiry", async mode => {
    const f = await enabled(); await tickFounderStripeReads(f.env);
    const receipt = f.db.sqlite.prepare("SELECT id FROM founder_stripe_read_receipts WHERE state='completed'").get()!;
    const expires = mode === "receipt" ? Date.now() + 3600_000 : f.input.expiresAt;
    if (mode === "receipt") f.db.sqlite.prepare("UPDATE founder_stripe_read_receipts SET expires_at=? WHERE id=?").run(expires, receipt.id!);
    const hold = holdFinalProof(f.env, "SELECT s.expiresAt AS session_expires FROM founder_stripe_read_receipts");
    const pending = handleFounderStripeReads(new Request(`https://shiba.test/api/founder-stripe-reads/${f.draft.id}/reports/${receipt.id}`, { headers: { "X-Shiba-Workspace": f.member.workspaceId, cookie: "better-auth.session_token=fixture" } }), f.env);
    await hold.ready; vi.spyOn(Date, "now").mockReturnValue(expires + 1); hold.release();
    const response = await pending; expect(response!.status).not.toBe(200); expect(await response!.text()).not.toContain("shiba.stripe-read-report.v1");
  });
});
