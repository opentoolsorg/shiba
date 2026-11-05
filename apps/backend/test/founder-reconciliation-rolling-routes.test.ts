import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { createTeamWorkspace, getTeamWorkspaceMembership } from "../src/team-workspaces-store.js";
import { createFounderReconciliation, composeFounderReconciliation } from "../src/founder-reconciliation-store.js";
import { handleFounderReconciliations } from "../src/founder-reconciliation-routes.js";
import { FOUNDER_HUBSPOT_EXECUTOR_DIGEST } from "../src/founder-hubspot-generated.js";
import type { StripeEnv } from "../src/founder-stripe-store.js";
import type { WorkspaceNativeMember } from "../src/workspace-native-authority.js";

const state = vi.hoisted(() => ({ proof: null as unknown, member: null as WorkspaceNativeMember | null, session: null as { id: string; expiresAt: number } | null }));
vi.mock("../src/founder-reconciliation-sources.js", () => ({ loadReconciliationSources: async () => state.proof }));
vi.mock("../src/org-request-auth.js", () => ({ resolveOrgForApiRequest: async () => ({ workspace: state.member, principal: null }) }));
vi.mock("../src/workspace-native-authority.js", async original => ({ ...await original<typeof import("../src/workspace-native-authority.js")>(), resolveWorkspaceNativeMember: async () => state.member }));
vi.mock("../src/founder-reconciliation-session.js", async original => ({ ...await original<typeof import("../src/founder-reconciliation-session.js")>(), reconciliationSession: async () => state.session }));
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const db = customAgentD1(), email = "rolling@example.test", accountId = "native-rolling", asOf = 1700000000;
  db.sqlite.exec('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT UNIQUE,emailVerified INTEGER); CREATE TABLE shiba_auth_account_policy(account_id TEXT PRIMARY KEY,email TEXT); CREATE TABLE proof_state(current INTEGER NOT NULL); INSERT INTO proof_state VALUES(1); CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT,expiresAt INTEGER)');
  db.sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run(accountId, email);
  db.sqlite.prepare('INSERT INTO shiba_auth_account_policy VALUES(?,?)').run(accountId, email);
  db.sqlite.exec(readFileSync(new URL("../migrations/0030_founder_reconciliation.sql", import.meta.url), "utf8"));
  const env = { AGENT_AUDIT: db.database, FOUNDER_STRIPE_READS_ENABLED: "true", FOUNDER_STRIPE_CREDENTIAL_KEY: "ab".repeat(32), FOUNDER_HUBSPOT_READS_ENABLED: "true", FOUNDER_HUBSPOT_CREDENTIAL_KEY: "cd".repeat(32) } as StripeEnv;
  const ws = await createTeamWorkspace(env, email, { name: "Rolling fixture" });
  const member = { ...(await getTeamWorkspaceMembership(env, ws.workspaceId, email))!, accountId };
  const session = { id: "rolling-session", expiresAt: Date.now() + 600000 };
  state.member = member;
  state.session = session;
  db.sqlite.prepare("INSERT INTO session VALUES(?,?,?)").run(session.id, accountId, session.expiresAt);
  const expiresAt = Date.now() + 300000, hash = "a".repeat(64);
  const input = { hubspot: { grantId: `fhc_${"a".repeat(32)}`, grantVersion: 1, occurrenceId: `fhr_${"b".repeat(32)}`, sourceOrdinal: 0 }, stripe: { grantId: `fsc_${"a".repeat(32)}`, receiptId: `fsr_${"b".repeat(32)}` }, mapping: { invoiceIdProperty: "invoice_id", paidAmountProperty: "paid", currencyProperty: "currency", amountUnit: "major-decimal", basisAttestation: "crm-property-represents-stripe-invoice-amount-paid" }, expiresAt };
  state.proof = {
    sources: {
      hubspot: { kind: "native-hubspot", accountId: "123", currency: "USD", timezoneName: "UTC", ...input.hubspot, dealIds: ["1"], reportHash: hash, resultDigest: hash, connectionId: "connection", connectionVersion: 1, capturedAt: Date.now(), runtimeVersionId: "native-hubspot.v1", manifestDigest: FOUNDER_HUBSPOT_EXECUTOR_DIGEST, executorHash: hash, expiresAt: expiresAt + 1000 },
      stripe: { ...input.stripe, resultDigest: hash, grantRevision: 1, accountId: "acct_Fixture", mode: "test", executorDigest: hash, capturedAt: Date.now(), createdGte: asOf - 28 * 86400, createdLt: asOf, hasMore: false, expiresAt: expiresAt + 1000 },
    },
    deals: [{ dealId: "1", properties: { invoice_id: "in_A", paid: "10.00", currency: "USD" } }],
    invoices: [{ id: "in_A", currency: "usd", amountPaid: 1000, status: "paid", created: asOf - 1, livemode: false }],
    sql: "EXISTS(SELECT 1 FROM proof_state WHERE current=1)", values: [], expiresAt: expiresAt + 1000,
  };
  const created = await createFounderReconciliation(env, member, input, session);
  const result = await composeFounderReconciliation(env, member, created.draft.id, created.draft.digest, session);
  const body = { digest: result.draft.digest, reviewed: true, consent: "filter-captured-invoice-created-window-not-revenue-mrr-or-churn", asOf, periodDays: 1 };
  const request = (changes = {}, headers = {}) => new Request(`https://shiba.test/api/founder-reconciliations/${result.draft.id}/rolling`, { method: "POST", headers: { "content-type": "application/json", origin: "https://shiba.test", "X-Shiba-Workspace": ws.workspaceId, cookie: "better-auth.session_token=fixture", ...headers }, body: JSON.stringify({ ...body, ...changes }) });
  return { db, env, result, request };
}

describe("private rolling capture endpoint", () => {
  it("returns the consented window and makes no extra persisted effects on retry", async () => {
    const f = await fixture();
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Provider calls are forbidden during rolling composition"));
    const first = await handleFounderReconciliations(f.request(), f.env), second = await handleFounderReconciliations(f.request(), f.env);
    expect(first?.status).toBe(200);
    expect(first?.headers.get("cache-control")).toBe("no-store");
    const output = await first!.json();
    expect(output).toMatchObject({ report: { format: "shiba.founder-reconciliation.rolling-view.v1", rows: [{ invoiceId: "in_A" }], perCurrency: [{ stripeMinor: "1000" }] } });
    expect(await second!.json()).toEqual(output);
    expect(fetch).not.toHaveBeenCalled();
    expect(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM founder_reconciliation_reports").get()).toEqual({ n: 1 });
  });
  it.each(["source", "session", "owner", "tenant", "report", "pin"])("withholds output after %s authority changes", async change => {
    const f = await fixture();
    if (change === "source") f.db.sqlite.exec("UPDATE proof_state SET current=0");
    if (change === "session") f.db.sqlite.exec("DELETE FROM session");
    if (change === "owner") state.member = { ...state.member!, accountId: "different-native-owner" };
    if (change === "tenant") state.member = { ...state.member!, workspaceId: `ws_${"b".repeat(24)}` };
    if (change === "report") f.db.sqlite.exec("UPDATE founder_reconciliation_reports SET state='revoked',report_json=NULL,report_hash=NULL");
    if (change === "pin") f.db.sqlite.exec("UPDATE founder_reconciliation_reports SET executor_digest='stale'");
    const response = await handleFounderReconciliations(f.request(), f.env);
    expect(response?.status).toBeGreaterThanOrEqual(400);
    expect(await response!.text()).not.toContain("in_A");
  });
  it.each([
    ["source revocation", "UPDATE proof_state SET current=0"],
    ["session deletion", "DELETE FROM session"],
    ["session reassignment", "UPDATE session SET userId='different-native-owner'"],
    ["session expiry", "UPDATE session SET expiresAt=0"],
    ["report revocation", "UPDATE founder_reconciliation_reports SET state='revoked',report_json=NULL,report_hash=NULL"],
    ["report replacement", "UPDATE founder_reconciliation_reports SET report_json='{}'"],
  ])("withholds output after %s between the store read and final route proof", async (_change, mutation) => {
    const f = await fixture(), prepare = f.env.AGENT_AUDIT.prepare.bind(f.env.AGENT_AUDIT);
    let proofs = 0;
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, { get(target, key) {
      if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
      if (key === "first") return async () => {
        const result = await target.first();
        if (sql.includes("SELECT s.expiresAt AS session_expires FROM founder_reconciliation_reports") && ++proofs === 1) {
          expect(result).not.toBeNull();
          f.db.sqlite.exec(mutation);
        }
        return result;
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    f.env.AGENT_AUDIT.prepare = sql => wrap(prepare(sql), sql);
    const response = await handleFounderReconciliations(f.request(), f.env);
    expect(proofs).toBe(2);
    expect(response?.status).toBe(403);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    const output = await response!.json();
    expect(output).toMatchObject({ error: "reconciliation_authority_changed" });
    expect(output).not.toHaveProperty("report");
    expect(JSON.stringify(output)).not.toContain("in_A");
  });
  it.each(["manager", "native session"])("requires a current %s before reading captured evidence", async authority => {
    const f = await fixture();
    if (authority === "manager") state.member = { ...state.member!, role: "member" };
    else state.session = null;
    const response = await handleFounderReconciliations(f.request(), f.env);
    expect(response?.status).toBe(403);
    expect(await response!.json()).toMatchObject({
      error: authority === "manager" ? "reconciliation_native_manager_required" : "reconciliation_native_session_required",
    });
  });
  it("requires current digest and explicit metric consent, rejects foreign origins and oversized bodies", async () => {
    const f = await fixture();
    expect((await handleFounderReconciliations(f.request({ digest: "b".repeat(64) }), f.env))?.status).toBe(409);
    expect((await handleFounderReconciliations(f.request({ consent: "compare-exact-captured-receipts" }), f.env))?.status).toBe(400);
    expect((await handleFounderReconciliations(f.request({}, { origin: "https://foreign.test" }), f.env))?.status).toBe(403);
    expect((await handleFounderReconciliations(f.request({ padding: "x".repeat(9000) }), f.env))?.status).toBe(400);
  });
});
