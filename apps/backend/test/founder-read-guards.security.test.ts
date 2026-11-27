import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { createTeamWorkspace, getTeamWorkspaceMembership } from "../src/team-workspaces-store.js";
import { handleFounderReads, tickFounderReads, type FounderReadsEnv } from "../src/founder/reads/index.js";
import { loadReconciliationSources } from "../src/founder/founder-reconciliation-sources.js";

const actor = vi.hoisted(() => ({ expiresAt: Date.now() + 86400000, member: null as null | { workspaceId: string; userId: string; accountId: string; version: number; role: string } }));
vi.mock("@shiba/auth/better-auth", async (original) => ({ ...await original<typeof import("@shiba/auth/better-auth")>(), resolveBetterAuthSessionAccount: async () => ({ policy: { accountId: "native-owner", email: "owner@example.test" }, emailVerified: true, sessionId: "session-fixture", sessionExpiresAt: actor.expiresAt }) }));
vi.mock("../src/org-request-auth.js", () => ({ resolveOrgForApiRequest: async () => ({ workspace: actor.member, principal: null }) }));
vi.mock("../src/workspace-native-authority.js", async (original) => ({ ...await original<typeof import("../src/workspace-native-authority.js")>(), resolveWorkspaceNativeMember: async () => actor.member }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const stripeDecision = (digest: string) => ({ digest, reviewed: true, readConsent: "allow-exact-scheduled-stripe-reads-and-quota", readOnlyAttestation: "restricted-key-read-only-for-selected-resources" });
const hubspotDecision = (digest: string) => ({ digest, reviewed: true, readConsent: "allow-exact-daily-hubspot-reads-and-quota", credentialAttestation: "creator-attests-token-appropriate-for-hubspot-deals-read" });

async function fixture() {
  const db = customAgentD1(), email = "owner@example.test", account = "native-owner";
  db.sqlite.prepare(`INSERT INTO "user"(id,email,emailVerified,name,createdAt,updatedAt) VALUES(?,?,1,'Fixture',1,1)`).run(account, email);
  db.sqlite.prepare(`INSERT INTO shiba_auth_account_policy(account_id,email,kind,invitation_id,workspace_id) VALUES(?,?,'invited','fixture-invite','fixture-workspace')`).run(account, email);
  db.sqlite.prepare('INSERT INTO "session"(id,userId,expiresAt,token,createdAt,updatedAt) VALUES(?,?,?,lower(hex(randomblob(16))),1,1)').run("session-fixture", account, actor.expiresAt);
  for (const path of ["0027_founder_stripe_reads.sql", "0032_founder_hubspot_reads.sql"]) db.sqlite.exec(readFileSync(new URL(`../migrations/${path}`, import.meta.url), "utf8"));
  const env = { AGENT_AUDIT: db.database, FOUNDER_STRIPE_READS_ENABLED: "true", FOUNDER_STRIPE_CREDENTIAL_KEY: "ab".repeat(32), FOUNDER_HUBSPOT_READS_ENABLED: "true", FOUNDER_HUBSPOT_CREDENTIAL_KEY: "cd".repeat(32) } as FounderReadsEnv;
  const workspace = await createTeamWorkspace(env, email, { name: "Guard fixture" });
  const member = { ...(await getTeamWorkspaceMembership(env, workspace.workspaceId, email))!, accountId: account };
  actor.member = member;
  const call = async (path: string, method: string, body?: unknown) => (await handleFounderReads(new Request(`https://shiba.test${path}`, { method, headers: { "X-Shiba-Workspace": member.workspaceId, "Content-Type": "application/json", Origin: "https://shiba.test", cookie: "better-auth.session_token=fixture" }, ...(body ? { body: JSON.stringify(body) } : {}) }), env))!;
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    const target = new URL(String(url));
    if (target.hostname === "api.hubapi.com") return target.pathname.endsWith("/details") ? Response.json({ portalId: 123, companyCurrency: "USD", timeZone: "UTC" }) : Response.json({ status: "COMPLETE", results: [{ id: "11", properties: { invoice_id: "in_A", paid_amount: "10.00", currency: "USD" } }] });
    return target.pathname === "/v1/account" ? Response.json({ object: "account", id: "acct_Fixture" }) : Response.json({ object: "list", has_more: false, data: [{ id: "in_A", object: "invoice", created: 150, currency: "usd", amount_paid: 1000, status: "paid", livemode: false }] });
  });
  vi.stubGlobal("fetch", fetcher);
  const expiresAt = Date.now() + 600000;
  const stripeDraft = async () => (await (await call("/api/founder-stripe-reads", "POST", { accountId: "acct_Fixture", mode: "test", restrictedKey: `rk_test_${"F".repeat(24)}`, expiresAt, maxCalls: 2, selection: { kind: "invoices", createdGte: 100, createdLt: 200, limit: 5 }, readOnlyAttestation: "restricted-key-read-only-for-selected-resources" })).json() as { grant: { id: string; digest: string } }).grant;
  const hubspotDraft = async () => (await (await call("/api/founder-hubspot-reads", "POST", { accountId: "123", accessToken: "fixture-hubspot-token-123456789", expiresAt, maxCalls: 2, selection: { dealIds: ["11"], invoiceIdProperty: "invoice_id", paidAmountProperty: "paid_amount", currencyProperty: "currency" }, credentialAttestation: "creator-attests-token-appropriate-for-hubspot-deals-read" })).json() as { grant: { id: string; digest: string } }).grant;
  return { db, env, member, call, fetcher, stripeDraft, hubspotDraft, expiresAt };
}

it("A1: the reconciliation write fence re-proves both receipts, not only the grants", async () => {
  const f = await fixture(), stripe = await f.stripeDraft(), hub = await f.hubspotDraft();
  expect((await f.call(`/api/founder-stripe-reads/${stripe.id}/verify`, "POST", stripeDecision(stripe.digest))).status).toBe(200);
  expect((await f.call(`/api/founder-stripe-reads/${stripe.id}/enable`, "POST", stripeDecision(stripe.digest))).status).toBe(200);
  const verified = await (await f.call(`/api/founder-hubspot-reads/${hub.id}/verify`, "POST", hubspotDecision(hub.digest))).json() as { grant: { digest: string } };
  expect((await f.call(`/api/founder-hubspot-reads/${hub.id}/enable`, "POST", hubspotDecision(verified.grant.digest))).status).toBe(200);
  f.db.sqlite.exec(`UPDATE founder_stripe_read_grants SET next_due_at=${Date.now() - 1000}; UPDATE founder_hubspot_read_grants SET next_due_at=${Date.now() - 1000}`);
  expect((await tickFounderReads(f.env, "stripe")).created).toBe(1);
  expect((await tickFounderReads(f.env, "hubspot")).created).toBe(1);
  const receipt = (table: string) => (f.db.sqlite.prepare(`SELECT id FROM ${table} WHERE state='completed'`).get() as { id: string }).id;
  const input = { hubspot: { grantId: hub.id, grantVersion: 1, occurrenceId: receipt("founder_hubspot_read_receipts"), sourceOrdinal: 0 as const }, stripe: { grantId: stripe.id, receiptId: receipt("founder_stripe_read_receipts") }, mapping: { invoiceIdProperty: "invoice_id", paidAmountProperty: "paid_amount", currencyProperty: "currency", amountUnit: "major-decimal" as const, basisAttestation: "crm-property-represents-stripe-invoice-amount-paid" as const }, expiresAt: f.expiresAt - 1000 };
  const proof = await loadReconciliationSources(f.env, f.member, input);
  expect(proof.values.length + 20).toBeLessThanOrEqual(100);
  const holds = () => f.db.sqlite.prepare(`SELECT 1 AS ok WHERE ${proof.sql}`).get(...proof.values as never[]);
  expect(holds()).toEqual({ ok: 1 });
  const stored = f.db.sqlite.prepare("SELECT expires_at,report_json FROM founder_stripe_read_receipts").get() as { expires_at: number; report_json: string };
  f.db.sqlite.prepare("UPDATE founder_stripe_read_receipts SET expires_at=1").run();
  expect(holds()).toBeUndefined();
  f.db.sqlite.prepare("UPDATE founder_stripe_read_receipts SET expires_at=?").run(stored.expires_at);
  expect(holds()).toEqual({ ok: 1 });
  f.db.sqlite.prepare("UPDATE founder_hubspot_read_receipts SET report_json='{}'").run();
  expect(holds()).toBeUndefined();
});

it("A2: a membership change after the draft refuses verification before any call is reserved", async () => {
  const f = await fixture(), draft = await f.stripeDraft();
  f.db.sqlite.prepare("UPDATE team_workspace_memberships SET version=version+1 WHERE workspace_id=?").run(f.member.workspaceId);
  actor.member = { ...f.member, version: f.member.version + 1 };
  const response = await f.call(`/api/founder-stripe-reads/${draft.id}/verify`, "POST", stripeDecision(draft.digest));
  expect(response.status).toBe(409);
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.db.sqlite.prepare("SELECT state,used_calls FROM founder_stripe_read_grants WHERE id=?").get(draft.id)).toEqual({ state: "draft", used_calls: 0 });
});
