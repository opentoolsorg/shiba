/**
 * Interface-only fixture for the founder read-grant module.
 *
 * Everything here reaches the module through `founder/reads/index.ts`: a grant is
 * taken draft → verify → enable → tick with `handleFounderReads` and
 * `tickFounderReads`, the provider is a stubbed `fetch`, and the database is the
 * node:sqlite D1 stand-in. Tests take the module's interface from `seed.reads`.
 */
import { onTestFinished, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { customAgentD1 } from "./custom-agent-d1.js";
import { createTeamWorkspace, getTeamWorkspaceMembership } from "../../src/team-workspaces-store.js";
import type { WorkspaceNativeMember } from "../../src/workspace-native-authority.js";
import type { FounderReadsEnv, ReadProvider } from "../../src/founder/reads/index.js";

export type { Evidence, FounderReadsEnv, GrantPin, ReadProvider, SqlFence } from "../../src/founder/reads/index.js";

const actor = {
  email: "owner@example.test",
  account: "native-owner",
  sessionId: "session-fixture",
  member: null as null | Record<string, unknown>,
  /** What the session resolver reports as the captured expiry; null means a day from now. */
  expiresAt: null as null | number,
};

type Reads = typeof import("../../src/founder/reads/index.js");
let reads: Promise<Reads> | undefined;
/**
 * The module under test, loaded after the request-auth stand-ins are registered.
 * `vi.mock` is only hoisted in test files, so the fixture registers with `vi.doMock`
 * and imports the module afterwards; tests take the interface from `seed.reads`.
 */
function loadReads(callerAuth: boolean): Promise<Reads> {
  return reads ??= callerAuth ? import("../../src/founder/reads/index.js") : (async () => {
    const betterAuth = await vi.importActual<typeof import("@shiba/auth/better-auth")>("@shiba/auth/better-auth");
    const authority = await vi.importActual<typeof import("../../src/workspace-native-authority.js")>("../../src/workspace-native-authority.js");
    vi.doMock("@shiba/auth/better-auth", () => ({
      ...betterAuth,
      resolveBetterAuthSessionAccount: async () => ({ policy: { accountId: actor.account, email: actor.email, kind: "invited" }, emailVerified: true, sessionId: actor.sessionId, sessionExpiresAt: actor.expiresAt ?? Date.now() + 86400000 }),
    }));
    vi.doMock("../../src/org-request-auth.js", () => ({ resolveOrgForApiRequest: async () => ({ workspace: actor.member, principal: null }) }));
    vi.doMock("../../src/workspace-native-authority.js", () => ({ ...authority, resolveWorkspaceNativeMember: async () => actor.member }));
    // A consumer test has usually loaded the module already (through the code under test), with real request auth.
    // Load a second instance behind the stand-ins and leave the registry as it was; both instances share the database.
    vi.resetModules();
    const loaded = await import("../../src/founder/reads/index.js");
    for (const id of ["@shiba/auth/better-auth", "../../src/org-request-auth.js", "../../src/workspace-native-authority.js"]) vi.doUnmock(id);
    vi.resetModules();
    return loaded;
  })();
}

export const READ_PROVIDERS = ["stripe", "hubspot", "meta"] as const satisfies readonly ReadProvider[];

/** The only place provider differences live. */
export const READ_PROVIDER_FIXTURES = {
  stripe: {
    route: "/api/founder-stripe-reads", grants: "founder_stripe_read_grants", receipts: "founder_stripe_read_receipts",
    tokenField: "restrictedKey", token: `rk_test_${"F".repeat(24)}`,
    draft: { accountId: "acct_Fixture", mode: "test", selection: { kind: "balance_transactions", createdGte: 100, createdLt: 200, limit: 2 }, readOnlyAttestation: "restricted-key-read-only-for-selected-resources" },
    consent: { readConsent: "allow-exact-scheduled-stripe-reads-and-quota", readOnlyAttestation: "restricted-key-read-only-for-selected-resources" },
    host: "api.stripe.com", isVerify: (url: string) => url.endsWith("/v1/account"),
    verifyBody: { object: "account", id: "acct_Fixture" },
    readBody: { object: "list", has_more: false, data: [{ id: "txn_abc", object: "balance_transaction", created: 150, currency: "usd", amount: 100, fee: 3, net: 97, type: "charge", source: "ch_abc" }] },
    reportMarker: "txn_abc",
    /** A verification answer for some other account, and a read answer that echoes the credential in a projected field. */
    wrongAccountBody: { object: "account", id: "acct_Wrong" },
    echoBody: (token: string): unknown => ({ object: "list", has_more: false, data: [{ id: "txn_abc", object: "balance_transaction", created: 150, currency: "usd", amount: 100, fee: 3, net: 97, type: "charge", source: token }] }),
    /** Columns the exact-row predicate binds beyond the shared base. */
    extraColumns: { mode: "live" } as Record<string, string>,
    otherSelection: { kind: "balance_transactions", createdGte: 100, createdLt: 300, limit: 2 }, otherAccount: "acct_Other",
    /** Drafts whose account id or selection contains the credential. Stripe's shapes cannot hold an `rk_` key. */
    leaks: [] as { where: string; token: string; draft: Record<string, unknown> }[],
  },
  hubspot: {
    route: "/api/founder-hubspot-reads", grants: "founder_hubspot_read_grants", receipts: "founder_hubspot_read_receipts",
    tokenField: "accessToken", token: "fixture-hubspot-token-123456789",
    draft: { accountId: "123", selection: { dealIds: ["11"], invoiceIdProperty: "invoice_id", paidAmountProperty: "paid_amount", currencyProperty: "currency" }, credentialAttestation: "creator-attests-token-appropriate-for-hubspot-deals-read" },
    consent: { readConsent: "allow-exact-daily-hubspot-reads-and-quota", credentialAttestation: "creator-attests-token-appropriate-for-hubspot-deals-read" },
    host: "api.hubapi.com", isVerify: (url: string) => url.endsWith("/details"),
    verifyBody: { portalId: 123, companyCurrency: "USD", timeZone: "UTC" },
    readBody: { status: "COMPLETE", results: [{ id: "11", properties: { invoice_id: "in_A", paid_amount: "10", currency: "USD" } }] },
    reportMarker: "in_A",
    wrongAccountBody: { portalId: 999, companyCurrency: "USD", timeZone: "UTC" },
    echoBody: (token: string): unknown => ({ status: "COMPLETE", results: [{ id: "11", properties: { invoice_id: token, paid_amount: "10", currency: "USD" } }] }),
    extraColumns: { currency: "EUR", timezone_name: "Europe/Paris" } as Record<string, string>,
    otherSelection: { dealIds: ["12"], invoiceIdProperty: "invoice_id", paidAmountProperty: "paid_amount", currencyProperty: "currency" }, otherAccount: "124",
    leaks: [
      { where: "selection", token: "12345678901234567", draft: { selection: { dealIds: ["12345678901234567"], invoiceIdProperty: "invoice_id", paidAmountProperty: "paid_amount", currencyProperty: "currency" } } },
      { where: "account id", token: "1234567890123456", draft: { accountId: "1234567890123456" } },
    ] as { where: string; token: string; draft: Record<string, unknown> }[],
  },
  meta: {
    route: "/api/founder-meta-reads", grants: "founder_meta_read_grants", receipts: "founder_meta_read_receipts",
    tokenField: "accessToken", token: "fixtureMetaToken123456789",
    draft: { accountId: "123456", selection: { since: "2025-01-01", until: "2025-01-07", limit: 2 }, credentialAttestation: "creator-attests-token-appropriate-for-ads-read" },
    consent: { readConsent: "allow-exact-daily-meta-reads-and-quota", credentialAttestation: "creator-attests-token-appropriate-for-ads-read" },
    host: "graph.facebook.com", isVerify: (url: string) => !url.includes("/insights"),
    verifyBody: { id: "act_123456", account_id: "123456", currency: "USD", timezone_name: "America/New_York" },
    readBody: { data: [{ impressions: "123", clicks: "3", spend: "2.10", account_currency: "USD", date_start: "2025-01-01", date_stop: "2025-01-07" }] },
    reportMarker: '"impressions"',
    wrongAccountBody: { id: "act_123456", account_id: "654321", currency: "USD", timezone_name: "America/New_York" },
    echoBody: (token: string): unknown => ({ data: [{ impressions: token, clicks: "3", spend: "2.10", account_currency: "USD", date_start: "2025-01-01", date_stop: "2025-01-07" }] }),
    extraColumns: { currency: "EUR", timezone_name: "Europe/Paris" } as Record<string, string>,
    otherSelection: { since: "2025-01-02", until: "2025-01-08", limit: 2 }, otherAccount: "123457",
    leaks: [
      { where: "account id", token: "12345678901234567890", draft: { accountId: "12345678901234567890" } },
    ] as { where: string; token: string; draft: Record<string, unknown> }[],
  },
} as const satisfies Record<ReadProvider, unknown>;

type GrantRow = Record<string, string | number | null> & { id: string; state: string; revision: number; ciphertext: string; contract_digest: string; owner_json: string; selection_json: string; expires_at: number; max_calls: number; used_calls: number };
type ReceiptRow = { id: string; grant_id: string; state: string; report_json: string | null; result_digest: string | null; expires_at: number; created_at: number };

interface World {
  env: FounderReadsEnv;
  db: DatabaseSync;
  member: WorkspaceNativeMember;
  sessionId: string;
  fetcher: ReturnType<typeof vi.fn>;
  beforeRead?: () => void | Promise<void>;
  respond: Partial<Record<ReadProvider, Partial<Record<"verify" | "read", Responder>>>>;
  hooks: Map<string, { when: "before" | "after"; run: () => void | Promise<void>; fired: boolean; done: boolean }[]>;
  /**
   * Errors the module may have swallowed: a test's own hook that threw, or a request to a host no provider owns.
   * The engine records either as an unknown outcome, which is what most refusal tests assert, so the first one
   * fails the test when it finishes instead of letting it pass for the wrong reason.
   */
  faults: unknown[];
}

/** A provider stand-in for one kind of call; receives exactly what the module passed to `fetch`. */
export type Responder = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

// The engine's statement tags (reads/ledger.ts `TAG`), by name: the `reads:<name>` comment that leads a statement.
export type ReadStatementTag = "grant-get" | "verify-reserve" | "verify-settle" | "enable" | "dispatch-proof" | "tick-due" | "reserve" | "settle" | "grant-list" | "report" | "final-proof" | "session-proof";

/**
 * Lets a test act once, just before or just after one tagged engine statement runs. Keyed on the tag, never on SQL text.
 * A tagged statement inside a batch fires around the whole batch, so a hook may itself call the module.
 */
function tapStatements(database: D1Database, hooks: World["hooks"], faults: World["faults"]): D1Database {
  const prepare = database.prepare.bind(database), batch = database.batch.bind(database);
  type Statement = { tag?: string; bind(...values: unknown[]): Statement; run(): Promise<unknown>; first(): Promise<unknown>; all(): Promise<unknown> };
  const fire = async (tag: string | undefined, when: "before" | "after") => {
    for (const hook of tag ? hooks.get(tag) ?? [] : []) if (hook.when === when && !hook.fired) {
      // `fired` latches first so a hook that calls the module is not re-entered; `done` is what a test may rely on.
      hook.fired = true;
      try { await hook.run(); hook.done = true; } catch (error) { faults.push(error); throw error; }
    }
  };
  const tap = (statement: Statement, tag: string): Statement => {
    const around = async (call: () => Promise<unknown>) => { await fire(tag, "before"); const result = await call(); await fire(tag, "after"); return result; };
    return {
      ...statement, tag,
      bind: (...values) => tap(statement.bind(...values), tag),
      run: () => around(() => statement.run()), first: () => around(() => statement.first()), all: () => around(() => statement.all()),
    };
  };
  database.prepare = ((sql: string) => {
    const statement = prepare(sql) as unknown as Statement, tag = /\/\*reads:([a-z-]+)\*\//.exec(sql)?.[1];
    return (tag ? tap(statement, tag) : statement) as unknown as D1PreparedStatement;
  }) as D1Database["prepare"];
  database.batch = (async (statements: D1PreparedStatement[]) => {
    const tags = statements.map((statement) => (statement as unknown as Statement).tag);
    for (const tag of tags) await fire(tag, "before");
    const result = await batch(statements);
    for (const tag of tags) await fire(tag, "after");
    return result;
  }) as D1Database["batch"];
  return database;
}

async function createWorld(options: SeedOptions): Promise<World> {
  Object.assign(actor, { email: "owner@example.test", account: "native-owner", sessionId: "session-fixture" }, options.identity);
  const { database, sqlite } = customAgentD1();
  const hooks: World["hooks"] = new Map(), faults: World["faults"] = [];
  tapStatements(database, hooks, faults);
  sqlite.prepare(`INSERT INTO "user"(id,email,emailVerified,name,createdAt,updatedAt) VALUES(?,?,1,'Fixture',1,1)`).run(actor.account, actor.email);
  sqlite.prepare(`INSERT INTO shiba_auth_account_policy(account_id,email,kind,invitation_id,workspace_id) VALUES(?,?,'invited','fixture-invite','fixture-workspace')`).run(actor.account, actor.email);
  sqlite.prepare(`INSERT INTO "session"(id,userId,expiresAt,token,createdAt,updatedAt) VALUES(?,?,?,lower(hex(randomblob(16))),1,1)`).run(actor.sessionId, actor.account, options.sessionExpiresAt ?? Date.now() + 172800000);
  const key = "ab".repeat(32);
  const env = {
    AGENT_AUDIT: database,
    FOUNDER_STRIPE_READS_ENABLED: "true", FOUNDER_STRIPE_CREDENTIAL_KEY: key,
    FOUNDER_HUBSPOT_READS_ENABLED: "true", FOUNDER_HUBSPOT_CREDENTIAL_KEY: key,
    FOUNDER_META_READS_ENABLED: "true", FOUNDER_META_CREDENTIAL_KEY: key,
  } as unknown as FounderReadsEnv;
  const workspace = await createTeamWorkspace(env, actor.email, { name: "Founder read fixture" });
  const member = { ...(await getTeamWorkspaceMembership(env, workspace.workspaceId, actor.email))!, accountId: actor.account } as WorkspaceNativeMember;
  actor.member = member as unknown as Record<string, unknown>;
  // A session stored with a short expiry is also captured with it, or every human step would be refused as shortened.
  actor.expiresAt = options.sessionExpiresAt ?? null;
  const world: World = { env, db: sqlite, member, sessionId: actor.sessionId, fetcher: vi.fn(), hooks, faults, respond: {} };
  world.fetcher.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const found = Object.entries(READ_PROVIDER_FIXTURES).find(([, entry]) => new URL(url).host === entry.host);
    if (!found) { const fault = new Error(`founder-read fixture: unexpected provider host ${new URL(url).host}`); faults.push(fault); throw fault; }
    const [id, entry] = found as [ReadProvider, (typeof READ_PROVIDER_FIXTURES)[ReadProvider]];
    const kind = entry.isVerify(url) ? "verify" : "read";
    if (kind === "read") try { await world.beforeRead?.(); } catch (error) { faults.push(error); throw error; }
    const custom = world.respond[id]?.[kind];
    return custom ? custom(url, init) : Response.json(kind === "verify" ? entry.verifyBody : entry.readBody);
  });
  vi.stubGlobal("fetch", world.fetcher);
  onTestFinished(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); if (faults.length) throw faults[0]; });
  return world;
}

export interface SeedOptions {
  /** Reuse another seed's database, member and fetch stub (a second grant, or a second provider, in one workspace). */
  on?: FounderReadSeed;
  /** Default 4: verification spends one call, the seeding tick one, two remain. */
  maxCalls?: number;
  /** Stop early: after the draft, after verification, or once enabled (no tick, no receipt). Default runs the first tick. */
  until?: "draft" | "verified" | "enabled";
  /** Fields merged over the provider's default draft body (a different selection, say). */
  draft?: Record<string, unknown>;
  /** Extra bindings a consumer needs on the same env. */
  env?: Record<string, unknown>;
  /** What the provider answers while seeding (and afterwards, until `respond` replaces it). */
  verifyBody?: unknown;
  readBody?: unknown;
  /** Who owns the workspace and the session row. Only read when the seed creates its own world. */
  identity?: { email: string; account: string; sessionId: string };
  /** Stored expiry of the session row (default two days). */
  sessionExpiresAt?: number;
  /**
   * "caller": the test file mocks request auth itself (with `vi.mock`, for the same identity), so the fixture
   * registers no stand-ins. Every seed in one test file must use the same setting.
   */
  auth?: "caller";
}

export type FounderReadSeed = Awaited<ReturnType<typeof seedFounderRead>>;

export async function seedFounderRead(provider: ReadProvider, options: SeedOptions = {}) {
  const reads = await loadReads(options.auth === "caller");
  const world: World = options.on?.world ?? await createWorld(options);
  const spec = READ_PROVIDER_FIXTURES[provider];
  const { env, db, member } = world;
  Object.assign(env as unknown as Record<string, unknown>, options.env);
  if (options.verifyBody !== undefined) world.respond[provider] = { ...world.respond[provider], verify: () => Response.json(options.verifyBody) };
  if (options.readBody !== undefined) world.respond[provider] = { ...world.respond[provider], read: () => Response.json(options.readBody) };

  /** A header set to `null` is removed, so a test can drop the cookie. */
  const call = (method: "GET" | "POST", suffix = "", body?: unknown, headers: Record<string, string | null> = {}) => {
    const merged = new Headers({ "X-Shiba-Workspace": member.workspaceId, "Content-Type": "application/json", Origin: "https://shiba.test", cookie: "better-auth.session_token=fixture" });
    for (const [name, value] of Object.entries(headers)) value === null ? merged.delete(name) : merged.set(name, value);
    return reads.handleFounderReads(new Request(`https://shiba.test${spec.route}${suffix}`, { method, headers: merged, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  };
  const draftBody = (overrides: Record<string, unknown> = {}, token: string = spec.token) => ({ ...spec.draft, [spec.tokenField]: token, expiresAt: Date.now() + 86400000, maxCalls: options.maxCalls ?? 4, ...options.draft, ...overrides });
  const decision = (digest: string) => ({ digest, reviewed: true, ...spec.consent });

  /** Every response body the module produced while seeding, for "the credential never leaves" assertions. */
  const wire: string[] = [];
  const ok = async (step: string, response: Response | null, status: number) => {
    const text = response ? await response.text() : "";
    wire.push(text);
    if (response?.status !== status) throw new Error(`founder-read fixture: ${provider} ${step} returned ${response?.status ?? "no response"} ${text.slice(0, 200)}`);
    return JSON.parse(text) as { grant: { id: string; digest: string; state: string } };
  };

  const created = await ok("draft", await call("POST", "", draftBody()), 201);
  const grantId = created.grant.id;
  const grant = () => db.prepare(`SELECT * FROM ${spec.grants} WHERE id=?`).get(grantId) as unknown as GrantRow;
  const receipts = () => db.prepare(`SELECT * FROM ${spec.receipts} WHERE grant_id=? ORDER BY created_at,id`).all(grantId) as unknown as ReceiptRow[];
  const tick = async () => {
    db.prepare(`UPDATE ${spec.grants} SET next_due_at=? WHERE id=?`).run(Date.now() - 1000, grantId);
    return reads.tickFounderReads(env, provider);
  };

  /** A decision with the digest the grant carries right now (verification changes it for HubSpot and Meta). */
  const decide = (action: "verify" | "enable" | "revoke") => call("POST", `/${grantId}/${action}`, decision(grant().contract_digest));
  const stages = ["draft", "verified", "enabled", "ticked"] as const, stop = stages.indexOf(options.until ?? "ticked");
  if (stop >= 1) await ok("verify", await decide("verify"), 200);
  if (stop >= 2 && (await ok("enable", await decide("enable"), 200)).grant.state !== "enabled") throw new Error(`founder-read fixture: ${provider} grant is not enabled after enable`);
  let receiptId = "";
  if (stop >= 3) {
    const ticked = await tick();
    const [receipt] = receipts();
    if (ticked.created !== 1 || receipt?.state !== "completed") throw new Error(`founder-read fixture: ${provider} seeding tick created ${ticked.created}, receipt ${receipt?.state ?? "missing"}`);
    receiptId = receipt.id;
  }

  return {
    /** The module's interface (`founder/reads/index.ts`), loaded behind the auth stand-ins. */
    reads,
    provider, spec, world, env, db, member, sessionId: world.sessionId, fetcher: world.fetcher, wire,
    /** The owner's human session as a consumer's store function takes it. */
    session: { id: world.sessionId, expiresAt: Math.min(options.sessionExpiresAt ?? Infinity, Date.now() + 86400000) },
    call, tick, draftBody, decision, grant, receipts,
    verify: () => decide("verify"), enable: () => decide("enable"), revoke: () => decide("revoke"),
    grantId, digest: grant().contract_digest, receiptId,
    /** Replaces the provider's answer for verification or read calls of this seed's provider. */
    respond(kind: "verify" | "read", responder: Responder) { world.respond[provider] = { ...world.respond[provider], [kind]: responder }; },
    /** The member the request-auth stand-in resolves from now on (a re-added member with a new version, say). */
    actAs(next: WorkspaceNativeMember) { actor.member = next as unknown as Record<string, unknown>; },
    /** The expiry the session resolver reports as captured from the cookie; the stored row is changed separately. */
    captureSessionUntil(expiresAt: number) { actor.expiresAt = expiresAt; },
    /** Runs while each provider read request is in flight (after reserve, before settle); `fired()` proves it ran to completion. */
    onRead(hook: () => void | Promise<void>) {
      let done = false;
      world.beforeRead = async () => { await hook(); done = true; };
      return { fired: () => done };
    },
    /** Runs `run` once, just before or after the next execution of one tagged engine statement; `fired()` proves it ran to completion. */
    tap(when: "before" | "after", tag: ReadStatementTag, run: () => void | Promise<void>) {
      const hook = { when, run, fired: false, done: false };
      world.hooks.set(tag, [...(world.hooks.get(tag) ?? []), hook]);
      return { fired: () => hook.done };
    },
    /** Whether a caller's write would go through if it ANDed this fence into its WHERE. */
    holds(fence: { sql: string; values: unknown[] }) {
      return db.prepare(`SELECT 1 AS ok WHERE ${fence.sql}`).get(...fence.values as never[]) !== undefined;
    },
    /** Receipt ids a caller would read from a `completedReceipts` subquery. */
    selected(subquery: { sql: string; values: unknown[] }) {
      return (db.prepare(`SELECT c.id FROM ${subquery.sql} c ORDER BY c.created_at,c.id`).all(...subquery.values as never[]) as { id: string }[]).map((row) => row.id);
    },
  };
}
