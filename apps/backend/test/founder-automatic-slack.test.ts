import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  handleReadGateway,
  callbackAttempts,
  readGatewayManifest,
  hash,
  digest,
  type GatewayDependencies,
} from "@shiba/openconnector-read-gateway";
import {
  getFounderSkillLibraryEntry,
  founderAutomaticReadStateSchema,
  founderAutomaticReadReportHash,
} from "@shiba/shared";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import {
  createTeamWorkspace,
  createTeamWorkspaceInvitation,
  acceptTeamWorkspaceInvitation,
  getTeamWorkspaceMembership,
} from "../src/team-workspaces-store.js";
import { ensureWorkspaceIntegrationSchema } from "../src/workspace-integrations-store.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { installSkillDefinition } from "../src/skill-library/install.js";
import { activateSkill, getSkill, reviewSkill } from "../src/skills-store.js";
import { openConnectorWorkspaceConnectionName } from "../src/integrations/openconnector-provider.js";
import { handleFounderAutomaticReads } from "../src/founder-auto-read-routes.js";
import { handleFounderAutomaticReadPermit } from "../src/founder-auto-read-permits.js";
import {
  tickFounderAutomaticReads,
  readAutomaticReadReport,
  loadAutomaticReadReportAuthority,
  automaticReadReportAuthorityGuard,
} from "../src/founder-auto-read-runtime.js";
import { readAutomaticReadState } from "../src/founder-auto-read-store.js";
import { automaticSlackStateSchema, type AutomaticSlackGrant } from "@shiba/shared";
import { createCollaborationRoom, addCollaborationMember } from "../src/collaboration-store.js";
import {
  ensureSlackInstallations,
  installationDigest,
  installationPurpose,
  installationSnapshot,
  type SlackInstallationRow,
} from "../src/slack-installations-store.js";
import { sealSlackSecret } from "../src/slack-installations-crypto.js";
import { handleFounderAutomaticSlack } from "../src/founder-automatic-slack-routes.js";
import {
  ensureAutomaticSlackSchema,
  renderAutomaticSlackReport,
} from "../src/founder-automatic-slack-store.js";
import {
  tickFounderAutomaticSlack,
  type AutomaticSlackTickDeps,
} from "../src/founder-automatic-slack-tick.js";
import { AUTOMATIC_SLACK_SCHEMA } from "../src/founder-automatic-slack-schema.js";
const actor = vi.hoisted(() => ({
  email: "owner@example.test",
  accounts: {} as Record<string, string>,
  native: true,
}));
vi.mock("@shiba/auth/better-auth", async (original) => ({
  ...(await original<typeof import("@shiba/auth/better-auth")>()),
  resolveBetterAuthSessionAccount: async () =>
    actor.native
      ? {
          policy: {
            accountId: actor.accounts[actor.email],
            email: actor.email,
            kind: "invited",
            createdAt: 1,
          },
          emailVerified: true,
        }
      : null,
}));
vi.mock("../src/request-auth.js", async (original) => ({
  ...(await original<typeof import("../src/request-auth.js")>()),
  isAuthorizedRequest: async () => true,
  resolveUserId: async () => actor.email,
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const OWNER = "owner@example.test",
  ADMIN = "admin@example.test",
  LIBRARY = "founder-figma-ticket",
  VERSION = "12345678-1234-1234-1234-123456789abc";
async function fixture() {
  const db = customAgentD1();
  db.sqlite.function("julianday", (_v: unknown) => 2440587.5 + Date.now() / 86400000);
  let maxParameters = 0,
    maxSqlBytes = 0;
  const originalPrepare = db.database.prepare.bind(db.database);
  db.database.prepare = (sql) => {
    maxSqlBytes = Math.max(maxSqlBytes, new TextEncoder().encode(sql).length);
    if (maxSqlBytes > 100000) throw new Error("D1 SQL statement length exceeded");
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      ({
        ...statement,
        bind: (...args: unknown[]) => {
          maxParameters = Math.max(maxParameters, args.length);
          if (args.length > 100) throw new Error("D1 bound parameter limit exceeded");
          return wrap(statement.bind(...args));
        },
      }) as D1PreparedStatement;
    return wrap(originalPrepare(sql));
  };
  db.sqlite.exec(
    'CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT UNIQUE,emailVerified INTEGER);CREATE TABLE shiba_auth_account_policy(account_id TEXT PRIMARY KEY,email TEXT)',
  );
  actor.email = OWNER;
  actor.native = true;
  actor.accounts = {};
  for (const email of [OWNER, ADMIN]) {
    actor.accounts[email] = crypto.randomUUID();
    db.sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run(actor.accounts[email]!, email);
    db.sqlite
      .prepare("INSERT INTO shiba_auth_account_policy VALUES(?,?)")
      .run(actor.accounts[email]!, email);
  }
  const manifest = await readGatewayManifest(),
    manifestHash = await hash(manifest),
    provider = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "api.figma.com")
        return Response.json({ name: "Bounded Figma fact", echo: "private-fixture-oauth" });
      expect(url.href).toBe("https://api.linear.app/graphql");
      expect(JSON.parse(String(init?.body)).query).not.toContain("mutation");
      return Response.json({
        data: {
          team: {
            id: "team",
            name: "Team",
            issues: {
              nodes: [{ id: "issue", title: "Bounded Linear fact" }],
              pageInfo: { hasNextPage: true, endCursor: "not-followed" },
            },
          },
        },
      });
    });
  let afterOAuth: (() => void) | undefined,
    loseStage: string | undefined,
    holdResolve: (() => void) | undefined,
    arrived: (() => void) | undefined,
    hold: Promise<void> | undefined;
  const env = {
    AGENT_AUDIT: db.database,
    FOUNDER_AUTOMATIC_READS_ENABLED: "true",
    OPEN_CONNECTOR_READ_VERSION_ID: VERSION,
    OPEN_CONNECTOR_READ_MANIFEST_SHA256: manifestHash,
    OPEN_CONNECTOR_RUNTIME_TOKEN: "oct_private_fixture_runtime_key",
    OPEN_CONNECTOR_READ_RUNTIME_TOKEN: `oct_${"r".repeat(43)}`,
    INTERNAL_SIGNING_KEY: "fixture-internal-signing-key-must-be-at-least-32",
  } as unknown as Env;
  for (const name of ["AI", "CodingOrchestrator", "Sandbox", "AI_GATEWAY_TOKEN"])
    Object.defineProperty(env, name, {
      get() {
        throw new Error(`Automatic reads must not access ${name}`);
      },
    });
  const workspace = await createTeamWorkspace(env, OWNER, { name: "Automatic fixed reads" }),
    invite = await createTeamWorkspaceInvitation(env, workspace.workspaceId, OWNER, {
      email: ADMIN,
      role: "admin",
    });
  await acceptTeamWorkspaceInvitation(env, ADMIN, invite.token);
  const owner = {
      ...(await getTeamWorkspaceMembership(env, workspace.workspaceId, OWNER))!,
      accountId: actor.accounts[OWNER]!,
    },
    admin = {
      ...(await getTeamWorkspaceMembership(env, workspace.workspaceId, ADMIN))!,
      accountId: actor.accounts[ADMIN]!,
    };
  await ensureWorkspaceIntegrationSchema(env);
  const employee = await createCustomAgent(
    env,
    `team:${workspace.workspaceId}`,
    "fixed-read-helper",
    {
      name: "Fixed read helper",
      instructions: "Use supplied bounded receipts only",
      harness: "opencode",
    },
  );
  const recipe = getFounderSkillLibraryEntry(LIBRARY)!,
    teamGrant = { ...owner, role: "owner" as const },
    install = await installSkillDefinition(
      env,
      `team:${workspace.workspaceId}`,
      OWNER,
      {
        slug: LIBRARY,
        name: recipe.name,
        instructions: recipe.instructions,
        sourceUrl: recipe.sourceUrl,
        version: "1.1.0",
      },
      { teamGrant },
    ),
    skill = (await getSkill(env, `team:${workspace.workspaceId}`, OWNER, install.skillId))!;
  await reviewSkill(
    env,
    skill.orgId,
    OWNER,
    skill.id,
    skill.version,
    skill.content.instructions,
    Date.now(),
    { teamGrant },
  );
  await activateSkill(
    env,
    skill.orgId,
    OWNER,
    skill.id,
    skill.version,
    skill.content.instructions,
    Date.now(),
    { teamGrant },
  );
  const alias = await openConnectorWorkspaceConnectionName(workspace.workspaceId),
    accounts: {
      id: string;
      service: string;
      connectionName: string;
      configured: boolean;
      virtual: boolean;
      oauthAuthorizationId: string;
      profile: { displayName: string };
    }[] = [];
  for (const service of ["figma", "linear"]) {
    const connectionId = `connection-${service}`,
      consentId = `consent-${service}`,
      rawId = `raw-${service}`,
      fingerprint = await digest(JSON.stringify([alias, service, consentId])),
      providerId = `ocg_${await digest(JSON.stringify([alias, service, rawId, consentId]))}`;
    accounts.push({
      id: rawId,
      service,
      connectionName: alias,
      configured: true,
      virtual: false,
      oauthAuthorizationId: consentId,
      profile: { displayName: `${service} fixture account` },
    });
    db.sqlite
      .prepare("INSERT INTO workspace_app_connections VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        connectionId,
        workspace.workspaceId,
        service,
        1,
        1,
        "active",
        OWNER,
        owner.accountId,
        owner.version,
        owner.role,
        "pending",
        0,
        fingerprint,
        providerId,
        `${service} fixture account`,
        Date.now(),
        Date.now(),
      );
    db.sqlite
      .prepare("INSERT INTO workspace_app_grants VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        `grant-${service}`,
        workspace.workspaceId,
        connectionId,
        1,
        1,
        fingerprint,
        employee.id,
        employee.version,
        OWNER,
        owner.accountId,
        owner.version,
        owner.role,
        '["execute","discover"]',
        "active",
        1,
        OWNER,
        owner.accountId,
        owner.version,
        owner.role,
        Date.now(),
      );
  }
  Object.assign(env, {
    OPEN_CONNECTOR: {
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        expect(new URL(String(input)).pathname).toBe("/api/connections");
        return Response.json(accounts);
      }),
    },
  });
  const attempts = callbackAttempts({
    fetch: async (input, init) => {
      const body = JSON.parse(String(init?.body)) as { stage: string };
      const response = (await handleFounderAutomaticReadPermit(
        new Request(String(input), init),
        env,
      ))!;
      if (loseStage === body.stage) {
        loseStage = undefined;
        throw new Error("Fixture reply lost after parent CAS");
      }
      return response;
    },
  });
  const deps: GatewayDependencies = {
    enabled: true,
    version: { id: VERSION, tag: "a".repeat(40) },
    manifest,
    verifyRuntime: async (req) => {
      expect(req.headers.get("authorization")).toBe(`Bearer ${env.OPEN_CONNECTOR_READ_RUNTIME_TOKEN}`);
    },
    resolveOAuth: async (input) => {
      afterOAuth?.();
      afterOAuth = undefined;
      return {
        accessToken: "private-fixture-oauth",
        rawConnectionId: `raw-${input.operationId.split(".")[0]}`,
        revision: "revision1",
        consentId: `consent-${input.operationId.split(".")[0]}`,
        expiresAt: Date.now() + 3600000,
      };
    },
    attempts,
    providerFetch: async (input, init) => {
      arrived?.();
      if (hold) await hold;
      return provider(input, init);
    },
    manualFetch: async () => {
      throw new Error("Automatic reads must never fall through to manual action routes");
    },
  };
  Object.assign(env, {
    OPEN_CONNECTOR_READ_GATEWAY: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        handleReadGateway(new Request(String(input), init), deps),
    },
  });
  const input = {
    employeeId: employee.id,
    employeeVersion: employee.version,
    skillId: skill.id,
    skillVersion: skill.version,
    operations: [
      {
        connectionId: "connection-figma",
        connectionVersion: 1,
        operationId: "figma.get_file_metadata",
        arguments: { fileKey: "file123" },
      },
      {
        connectionId: "connection-linear",
        connectionVersion: 1,
        operationId: "linear.list_issues_by_team_id",
        arguments: { team_id: "team", first: 5, include_archived: false },
      },
    ],
    cadence: "daily",
    localTime: "09:00",
    timezone: "UTC",
    expiresAt: Date.now() + 7 * 86400000,
    maxOccurrences: 7,
    maxCalls: 14,
    maxCapturedBytes: 7 * 16384,
    maxBytesPerOccurrence: 16384,
    expectedVersion: 0,
  };
  const call = async (suffix = "", method = "GET", body?: unknown) => {
    const response = (await handleFounderAutomaticReads(
      new Request(`https://shiba.test/api/founder-skills/${LIBRARY}/automatic-reads${suffix}`, {
        method,
        headers: {
          Origin: "https://shiba.test",
          "Content-Type": "application/json",
          "X-Shiba-Workspace": workspace.workspaceId,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    ))!;
    return {
      response,
      body: (await response.json()) as ReturnType<typeof founderAutomaticReadStateSchema.parse> & {
        error?: string;
      },
    };
  };
  const configure = async () => {
    const out = await call("", "POST", input);
    expect(out.response.status, JSON.stringify(out.body)).toBe(200);
    return out.body;
  };
  const decision = (state: Awaited<ReturnType<typeof configure>>) => ({
    expectedVersion: state.grant!.version,
    digest: state.grant!.digest,
    reviewed: true,
    readConsent: "allow-exact-scheduled-read-operations-and-bounded-provider-calls",
    quotaConsent: "provider-requests-may-use-account-quota-or-incur-charges",
  });
  const enable = async () => {
    const draft = await configure(),
      out = await call("/enable", "POST", decision(draft));
    expect(out.response.status, JSON.stringify(out.body)).toBe(200);
    return out.body;
  };
  const due = async () => {
    const enabled = await enable();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(enabled.grant!.nextDueAt + 100);
    return enabled;
  };
  return {
    ...db,
    env,
    owner,
    admin,
    workspace,
    employee,
    skill,
    manifest,
    input,
    provider,
    deps,
    call,
    configure,
    enable,
    due,
    decision,
    get maxParameters() {
      return maxParameters;
    },
    get maxSqlBytes() {
      return maxSqlBytes;
    },
    afterOAuth(fn: () => void) {
      afterOAuth = fn;
    },
    lose(stage: string) {
      loseStage = stage;
    },
    holdProvider() {
      hold = new Promise<void>((resolve) => {
        holdResolve = resolve;
      });
      return new Promise<void>((resolve) => {
        arrived = resolve;
      });
    },
    release() {
      holdResolve?.();
    },
  };
}
async function slackFixture(options: { weekly?: boolean } = {}) {
  const f = await fixture();
  if (options.weekly)
    Object.assign(f.input, {
      cadence: "weekly",
      weekday: 1,
      expiresAt: Date.now() + 28 * 86400000,
    });
  await f.due();
  expect((await tickFounderAutomaticReads(f.env)).completed).toBe(1);
  const source = await readAutomaticReadState(f.env, f.owner, LIBRARY),
    sampleId = source.occurrences[0]!.id,
    sample = await readAutomaticReadReport(f.env, f.owner, LIBRARY, sampleId);
  // The delivery approval occurs after the sample, and authorizes only future occurrences.
  vi.setSystemTime(Date.now() + 5000);
  Object.assign(f.env, {
    SLACK_INSTALLATIONS_ENABLED: "true",
    SLACK_ROOM_OUTBOX_ENABLED: "true",
    SLACK_OAUTH_APP_ID: "A123",
    SLACK_OAUTH_CLIENT_ID: "123.456",
    SLACK_OAUTH_REDIRECT_URI: "https://shiba.test/api/slack/installations/callback",
    SLACK_OAUTH_PKCE_ENABLED: "true",
    SLACK_OAUTH_QUERY_REDACTION_VERIFIED: "true",
    SLACK_SIGNING_SECRET: "fixture-only",
    SLACK_INSTALLATION_KEYRING: JSON.stringify({
      activeKeyId: "v1",
      keys: { v1: "11".repeat(32) },
    }),
    DASHBOARD_APPROVERS: ADMIN,
    SLACK_CANVAS_OWNERS: JSON.stringify([
      { teamId: "T123", channelId: "C123", ownerId: OWNER, viewerIds: [ADMIN] },
    ]),
  });
  const scope = { tenantId: "self-hosted", workspaceId: f.workspace.workspaceId, userId: OWNER },
    roomId = "standing-slack-room";
  await createCollaborationRoom(f.env, scope, {
    roomId,
    title: "Explicit future evidence audience",
    visibility: "shared",
    createdAt: Date.now(),
  });
  await addCollaborationMember(f.env, scope, roomId, {
    actorId: `human:${ADMIN}`,
    userId: ADMIN,
    displayName: ADMIN,
    kind: "human",
    createdAt: Date.now(),
  });
  f.sqlite
    .prepare("INSERT INTO collaboration_slack_room_links VALUES(?,?,?,?,?,?,?,?,'active',?,NULL)")
    .run(
      "standing-link",
      "self-hosted",
      f.workspace.workspaceId,
      roomId,
      OWNER,
      "T123",
      "C123",
      "1710000000.000100",
      Date.now(),
    );
  await ensureSlackInstallations(f.env);
  const install: SlackInstallationRow = {
    id: "standing-managed-install",
    workspace_id: f.workspace.workspaceId,
    owner_id: OWNER,
    owner_account_id: f.owner.accountId,
    owner_member_json: JSON.stringify(f.owner),
    app_id: "A123",
    team_id: "T123",
    bot_user_id: "UB123",
    bot_id: "B123",
    installer_slack_user_id: "UINSTALLER",
    scopes_json: '["chat:write"]',
    generation: 1,
    version: 1,
    token_revision: 1,
    state: "active",
    digest: "",
    token_key_id: null,
    token_cipher: null,
    token_expires_at: null,
    activation_expires_at: Date.now() + 600000,
    created_at: Date.now(),
    refresh_claim_id: null,
  };
  install.digest = await installationDigest(install);
  const sealed = await sealSlackSecret(
    f.env,
    {
      workspaceId: f.workspace.workspaceId,
      subject: install.id,
      purpose: installationPurpose(installationSnapshot(install)),
    },
    JSON.stringify({ accessToken: "standing-managed-fixture-token", expiresAt: null }),
  );
  install.token_key_id = sealed.keyId;
  install.token_cipher = sealed.cipher;
  f.sqlite
    .prepare(
      `INSERT INTO slack_installations(${Object.keys(install).join(",")}) VALUES(${Object.keys(
        install,
      )
        .map(() => "?")
        .join(",")})`,
    )
    .run(...(Object.values(install) as never[]));
  await ensureAutomaticSlackSchema(f.env);
  const callSlack = async (suffix = "", body?: unknown, headers: Record<string, string> = {}) => {
    const response = (await handleFounderAutomaticSlack(
      new Request(`https://shiba.test/api/founder-skills/${LIBRARY}/automatic-slack${suffix}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Origin: "https://shiba.test",
          "Content-Type": "application/json",
          "X-Shiba-Workspace": f.workspace.workspaceId,
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      f.env,
    ))!;
    return {
      response,
      value: (await response.json()) as ReturnType<typeof automaticSlackStateSchema.parse> & {
        error?: string;
      },
    };
  };
  const input = () => ({
    requestId: crypto.randomUUID(),
    readGrantId: source.grant!.id,
    readGrantVersion: source.grant!.version,
    sampleOccurrenceId: sampleId,
    sampleReportHash: sample.reportHash,
    roomId,
    linkId: "standing-link",
    maxSends: 2,
    expiresAt: options.weekly ? source.grant!.contract.expiresAt : Date.now() + 3600000,
  });
  const prepare = async () => {
    actor.email = OWNER;
    const request = input(),
      out = await callSlack("/preview", request);
    expect(out.response.status, JSON.stringify(out.value)).toBe(200);
    return { request, grant: out.value.grants[0]! };
  };
  const decision = (grant: AutomaticSlackGrant) => ({
    expectedVersion: 1,
    digest: grant.digest,
    expiresAt: grant.expiresAt,
    reviewed: true,
  });
  const disclose = async (grant: AutomaticSlackGrant) => {
    actor.email = OWNER;
    return callSlack(`/grants/${grant.id}/disclose`, {
      ...decision(grant),
      futureReportConsent: "share-future-completed-reports-from-this-exact-read-grant",
      audienceConsent: "all-current-and-future-people-with-access-to-selected-slack-channel-thread",
    });
  };
  const approve = async (grant: AutomaticSlackGrant) => {
    actor.email = ADMIN;
    return callSlack(`/grants/${grant.id}/approve`, decision(grant));
  };
  const enabled = async () => {
    const { grant } = await prepare();
    expect((await disclose(grant)).response.status).toBe(200);
    const approved = await approve(grant);
    expect(approved.response.status, JSON.stringify(approved.value)).toBe(200);
    return approved.value.grants[0]!;
  };
  const future = async () => {
    f.sqlite
      .prepare("UPDATE founder_automatic_read_grants SET next_due_at=? WHERE id=?")
      .run(Date.now() + 1000, source.grant!.id);
    vi.setSystemTime(Date.now() + 1100);
    expect((await tickFounderAutomaticReads(f.env)).completed).toBe(1);
    return (await readAutomaticReadState(f.env, f.owner, LIBRARY)).occurrences[0]!.id;
  };
  const post = vi.fn(async () => ({ channel: "C123", ts: "1710000009.000900" })),
    verify = vi.fn(async () => ({ teamId: "T123", userId: "UB123", botId: "B123" })),
    deps: AutomaticSlackTickDeps = { postMessage: post, verifyInstallation: verify };
  return {
    ...f,
    source,
    sample,
    sampleId,
    roomId,
    install,
    callSlack,
    input,
    prepare,
    decision,
    disclose,
    approve,
    enabled,
    future,
    post,
    verify,
    deps,
  };
}
describe("explicit standing Slack disclosure with actual automatic-read source guards, SQLite and fake Slack HTTP", () => {
  it("requires owner disclosure and a different configured native human, then sends only a future completed report once", async () => {
    const f = await slackFixture(),
      { grant } = await f.prepare();
    expect(grant.sampleContent).toContain("Scheduled fixed-read evidence");
    expect(grant.canDisclose).toBe(true);
    expect((await tickFounderAutomaticSlack(f.env, f.deps)).sent).toBe(0);
    expect(f.post).not.toHaveBeenCalled();
    actor.email = ADMIN;
    expect((await f.callSlack()).value.grants).toEqual([]);
    expect((await f.approve(grant)).response.status).toBe(404);
    expect((await f.disclose(grant)).response.status).toBe(200);
    actor.email = OWNER;
    expect(
      (await f.callSlack(`/grants/${grant.id}/approve`, f.decision(grant))).response.status,
    ).toBe(403);
    expect((await f.approve(grant)).response.status).toBe(200);
    expect((await tickFounderAutomaticSlack(f.env, f.deps)).sent).toBe(0);
    await f.future();
    expect(await tickFounderAutomaticSlack(f.env, f.deps)).toMatchObject({
      sent: 1,
      blocked: 0,
      unknown: 0,
    });
    expect(f.post).toHaveBeenCalledExactlyOnceWith(
      "standing-managed-fixture-token",
      expect.objectContaining({
        channel: "C123",
        threadTs: "1710000000.000100",
        text: expect.stringContaining("dataset completeness is unknown"),
      }),
    );
    expect((await tickFounderAutomaticSlack(f.env, f.deps)).sent).toBe(0);
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.sqlite.prepare("SELECT used_sends FROM founder_automatic_slack_grants").get()).toEqual(
      { used_sends: 1 },
    );
    actor.email = OWNER;
    const state = await f.callSlack();
    expect(automaticSlackStateSchema.safeParse(state.value).success).toBe(true);
    expect(state.value.deliveries[0]).toMatchObject({
      state: "sent",
      receiptTs: "1710000009.000900",
    });
    expect(f.maxParameters).toBeLessThanOrEqual(100);
    expect(f.maxSqlBytes).toBeLessThanOrEqual(100000);
  });
  it("deduplicates exact prepare IDs, rejects changed input and missing future/audience acknowledgements", async () => {
    const f = await slackFixture(),
      { request, grant } = await f.prepare();
    expect((await f.callSlack("/preview", request)).value.grants[0]!.id).toBe(grant.id);
    expect((await f.callSlack("/preview", { ...request, maxSends: 3 })).response.status).toBe(409);
    expect(
      (await f.callSlack(`/grants/${grant.id}/disclose`, f.decision(grant))).response.status,
    ).toBe(400);
    expect(f.post).not.toHaveBeenCalled();
  });
  it.each(["disabled", "legacy", "source-owner", "partial", "sample-hash", "over-limit", "native"])(
    "rejects %s before storing standing authority",
    async (kind) => {
      const f = await slackFixture(),
        input = f.input();
      if (kind === "disabled") f.env.SLACK_ROOM_OUTBOX_ENABLED = "false";
      if (kind === "legacy") f.env.SLACK_INSTALLATIONS_ENABLED = "false";
      if (kind === "source-owner")
        f.sqlite.exec("UPDATE workspace_app_connections SET issuer_account_id='other-native-uuid'");
      if (kind === "partial")
        f.sqlite
          .prepare("UPDATE founder_automatic_read_occurrences SET state='partial' WHERE id=?")
          .run(f.sampleId);
      if (kind === "sample-hash") input.sampleReportHash = "b".repeat(64);
      if (kind === "over-limit") input.maxSends = 11;
      if (kind === "native") actor.native = false;
      expect((await f.callSlack("/preview", input)).response.status).toBeGreaterThanOrEqual(400);
      expect(
        f.sqlite.prepare("SELECT COUNT(*)AS n FROM founder_automatic_slack_grants").get(),
      ).toEqual({ n: 0 });
      expect(f.post).not.toHaveBeenCalled();
    },
  );
  it.each([
    "grant",
    "issuer",
    "native-replacement",
    "profile",
    "skill",
    "installation",
    "audience",
    "policy",
    "approver",
    "paused",
    "expiry",
  ])("rechecks %s after awaited bot authentication with zero sends", async (kind) => {
    const f = await slackFixture(),
      grant = await f.enabled();
    await f.future();
    f.verify.mockImplementationOnce(async () => {
      if (kind === "grant") f.sqlite.exec("UPDATE workspace_app_grants SET state='revoked'");
      if (kind === "issuer")
        f.sqlite.exec("UPDATE workspace_app_connections SET generation=generation+1");
      if (kind === "native-replacement") {
        f.sqlite.prepare('DELETE FROM "user" WHERE id=?').run(f.owner.accountId);
        f.sqlite
          .prepare("DELETE FROM shiba_auth_account_policy WHERE account_id=?")
          .run(f.owner.accountId);
        const replacement = crypto.randomUUID();
        f.sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run(replacement, OWNER);
        f.sqlite
          .prepare("INSERT INTO shiba_auth_account_policy VALUES(?,?)")
          .run(replacement, OWNER);
        actor.accounts[OWNER] = replacement;
      }
      if (kind === "profile") f.sqlite.exec("UPDATE org_custom_agents SET version=version+1");
      if (kind === "skill") f.sqlite.exec("UPDATE skills SET status='disabled'");
      if (kind === "installation")
        f.sqlite.exec("UPDATE slack_installations SET generation=generation+1");
      if (kind === "audience")
        f.sqlite
          .prepare("UPDATE collaboration_memberships SET status='removed' WHERE user_id=?")
          .run(ADMIN);
      if (kind === "policy") f.env.SLACK_CANVAS_OWNERS = "[]";
      if (kind === "approver") f.env.DASHBOARD_APPROVERS = "";
      if (kind === "paused")
        f.sqlite
          .prepare("UPDATE founder_automatic_slack_grants SET state='paused' WHERE id=?")
          .run(grant.id);
      if (kind === "expiry") vi.setSystemTime(grant.expiresAt + 1);
      return { teamId: "T123", userId: "UB123", botId: "B123" };
    });
    expect((await tickFounderAutomaticSlack(f.env, f.deps)).blocked).toBe(1);
    expect(f.post).not.toHaveBeenCalled();
    expect(f.sqlite.prepare("SELECT used_sends FROM founder_automatic_slack_grants").get()).toEqual(
      { used_sends: 1 },
    );
  });
  it("atomically allows one concurrent send and one permanent reservation", async () => {
    const f = await slackFixture();
    await f.enabled();
    await f.future();
    let release!: () => void, arrived!: () => void;
    const waiting = new Promise<void>((r) => {
        arrived = r;
      }),
      held = new Promise<void>((r) => {
        release = r;
      });
    f.verify.mockImplementationOnce(async () => {
      arrived();
      await held;
      return { teamId: "T123", userId: "UB123", botId: "B123" };
    });
    const first = tickFounderAutomaticSlack(f.env, f.deps);
    await waiting;
    expect((await tickFounderAutomaticSlack(f.env, f.deps)).sent).toBe(0);
    release();
    expect((await first).sent).toBe(1);
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.sqlite.prepare("SELECT used_sends FROM founder_automatic_slack_grants").get()).toEqual(
      { used_sends: 1 },
    );
  });
  it("removes a stale installation grant from the due scan before bot verification", async () => {
    const f = await slackFixture();
    await f.enabled();
    await f.future();
    f.sqlite.exec("UPDATE slack_installations SET generation=generation+1");
    expect((await tickFounderAutomaticSlack(f.env, f.deps)).blocked).toBe(1);
    expect(f.sqlite.prepare("SELECT state FROM founder_automatic_slack_grants").get()).toEqual({
      state: "blocked",
    });
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
    expect(f.sqlite.prepare("SELECT used_sends FROM founder_automatic_slack_grants").get()).toEqual(
      { used_sends: 0 },
    );
  });
  it("does not apply a changed render policy to an older standing contract", async () => {
    const f = await slackFixture();
    await f.enabled();
    await f.future();
    f.sqlite.exec(
      "UPDATE founder_automatic_slack_grants SET family_json=json_set(family_json,'$.renderPolicy','different-policy.v2')",
    );
    expect((await tickFounderAutomaticSlack(f.env, f.deps)).blocked).toBe(1);
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
  });
  it("returns the raw UTF8 SHA256 receipt hash for the actual Unicode message sent", async () => {
    const f = await slackFixture();
    await f.enabled();
    f.provider.mockImplementationOnce(async () => Response.json({ name: "Unicode evidence 狗🐕" }));
    await f.future();
    expect((await tickFounderAutomaticSlack(f.env, f.deps)).sent).toBe(1);
    actor.email = OWNER;
    const state = await f.callSlack(),
      delivery = state.value.deliveries[0]!;
    expect(delivery.content).toContain("狗🐕");
    const raw = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(delivery.content)),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    expect(delivery.contentHash).toBe(raw);
    expect(f.post).toHaveBeenCalledWith(
      "standing-managed-fixture-token",
      expect.objectContaining({ text: delivery.content }),
    );
  });
  it("retains lost send outcomes, blocks replacement grants and never retries", async () => {
    const f = await slackFixture();
    await f.enabled();
    await f.future();
    f.post.mockRejectedValueOnce(new Error("Fixture lost transport after potential acceptance"));
    expect((await tickFounderAutomaticSlack(f.env, f.deps)).unknown).toBe(1);
    expect((await tickFounderAutomaticSlack(f.env, f.deps)).sent).toBe(0);
    expect(f.post).toHaveBeenCalledTimes(1);
    actor.email = OWNER;
    expect((await f.callSlack("/preview", f.input())).response.status).toBe(403);
    f.sqlite.exec(
      "UPDATE slack_installations SET id='replacement-installation',generation=generation+1,version=version+1,token_revision=token_revision+1",
    );
    expect((await f.callSlack("/preview", f.input())).response.status).toBe(403);
    expect(f.post).toHaveBeenCalledTimes(1);
  });
  it("recovers an orphaned send as unknown without posting again or releasing the send count", async () => {
    const f = await slackFixture();
    await f.enabled();
    await f.future();
    const original = f.env.AGENT_AUDIT.prepare.bind(f.env.AGENT_AUDIT);
    f.env.AGENT_AUDIT.prepare = (sql) => {
      const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
        const proxy = Object.create(s) as D1PreparedStatement;
        proxy.bind = (...v: unknown[]) => wrap(s.bind(...v));
        proxy.run = async () => {
          throw new Error("Fixture receipt storage lost");
        };
        return proxy;
      };
      return /UPDATE founder_automatic_slack_deliveries SET state=\?,receipt_ts=/.test(sql)
        ? wrap(original(sql))
        : original(sql);
    };
    await tickFounderAutomaticSlack(f.env, f.deps);
    f.env.AGENT_AUDIT.prepare = original;
    expect(f.post).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 31000);
    await tickFounderAutomaticSlack(f.env, f.deps);
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.sqlite.prepare("SELECT state FROM founder_automatic_slack_deliveries").get()).toEqual({
      state: "unknown",
    });
    expect(f.sqlite.prepare("SELECT used_sends FROM founder_automatic_slack_grants").get()).toEqual(
      { used_sends: 1 },
    );
  });
  it("permanently invalidates room removal/re-add, and withholds old delivery content after source revocation", async () => {
    const f = await slackFixture();
    await f.enabled();
    await f.future();
    await tickFounderAutomaticSlack(f.env, f.deps);
    f.sqlite
      .prepare("UPDATE collaboration_memberships SET status='removed' WHERE user_id=?")
      .run(ADMIN);
    f.sqlite
      .prepare("UPDATE collaboration_memberships SET status='active' WHERE user_id=?")
      .run(ADMIN);
    expect(f.sqlite.prepare("SELECT state FROM founder_automatic_slack_grants").get()).toEqual({
      state: "blocked",
    });
    f.sqlite.exec("UPDATE workspace_app_grants SET state='revoked'");
    actor.email = OWNER;
    const state = await f.callSlack();
    expect(state.value.deliveries).toEqual([]);
    expect(state.value.grants).toEqual([]);
  });
  it("checks the fresh clock after the final local SQL await and before the only post", async () => {
    const f = await slackFixture(),
      grant = await f.enabled();
    await f.future();
    const original = f.env.AGENT_AUDIT.prepare.bind(f.env.AGENT_AUDIT);
    let hit = false;
    f.env.AGENT_AUDIT.prepare = (sql) => {
      const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
        ({
          ...s,
          bind: (...v: unknown[]) => wrap(s.bind(...v)),
          first: async <T>() => {
            const row = await s.first<T>();
            if (!hit && /SELECT 1 AS current FROM founder_automatic_slack_deliveries d/.test(sql)) {
              hit = true;
              vi.setSystemTime(grant.expiresAt + 1);
            }
            return row;
          },
        }) as D1PreparedStatement;
      return wrap(original(sql));
    };
    expect((await tickFounderAutomaticSlack(f.env, f.deps)).blocked).toBe(1);
    expect(hit).toBe(true);
    expect(f.post).not.toHaveBeenCalled();
    expect(f.sqlite.prepare("SELECT used_sends FROM founder_automatic_slack_grants").get()).toEqual(
      { used_sends: 1 },
    );
  });
  it.each(["sample", "source"])(
    "fences cached %s bytes in the final read snapshot",
    async (kind) => {
      const f = await slackFixture();
      await f.enabled();
      await f.future();
      await tickFounderAutomaticSlack(f.env, f.deps);
      actor.email = OWNER;
      const original = f.env.AGENT_AUDIT.prepare.bind(f.env.AGENT_AUDIT);
      let hit = false;
      f.env.AGENT_AUDIT.prepare = (sql) => {
        const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
          ({
            ...s,
            bind: (...v: unknown[]) => wrap(s.bind(...v)),
            all: async <T>() => {
              if (!hit && sql.includes("SELECT 'actor' AS kind") && sql.includes("asread")) {
                hit = true;
                if (kind === "sample")
                  f.sqlite
                    .prepare(
                      "UPDATE founder_automatic_read_occurrences SET state='cancelled' WHERE id=?",
                    )
                    .run(f.sampleId);
                else f.sqlite.exec("UPDATE workspace_app_grants SET state='revoked'");
              }
              return s.all<T>();
            },
          }) as D1PreparedStatement;
        return wrap(original(sql));
      };
      const state = await f.callSlack();
      expect(hit).toBe(true);
      expect(state.response.status).toBe(200);
      if (kind === "source") {
        expect(state.value.grants).toEqual([]);
        expect(state.value.deliveries).toEqual([]);
      } else {
        expect(state.value.grants[0]).toMatchObject({
          state: "enabled",
          sampleContent: null,
          sampleExpiresAt: null,
          canPause: true,
        });
        expect(state.value.deliveries).toHaveLength(1);
      }
    },
  );
  it("does not exceed a one-send budget or send old reports under a replacement grant", async () => {
    const f = await slackFixture(),
      request = { ...f.input(), maxSends: 1 };
    const out = await f.callSlack("/preview", request),
      grant = out.value.grants[0]!;
    await f.disclose(grant);
    await f.approve(grant);
    await f.future();
    expect((await tickFounderAutomaticSlack(f.env, f.deps)).sent).toBe(1);
    expect(
      f.sqlite.prepare("SELECT state,used_sends FROM founder_automatic_slack_grants").get(),
    ).toEqual({ state: "exhausted", used_sends: 1 });
    await f.future();
    expect((await tickFounderAutomaticSlack(f.env, f.deps)).sent).toBe(0);
    expect(f.post).toHaveBeenCalledTimes(1);
  });
  it("keeps two review contracts and five delivery proofs within D1 statement limits", async () => {
    const f = await slackFixture();
    const prepared = await f.callSlack("/preview", { ...f.input(), maxSends: 5 });
    const grant = prepared.value.grants[0]!;
    await f.disclose(grant);
    await f.approve(grant);
    for (let index = 0; index < 5; index++) {
      await f.future();
      expect((await tickFounderAutomaticSlack(f.env, f.deps)).sent).toBe(1);
    }
    actor.email = OWNER;
    const next = await f.callSlack("/preview", f.input());
    expect(next.response.status, JSON.stringify(next.value)).toBe(200);
    expect(next.value.grants).toHaveLength(2);
    expect(next.value.deliveries).toHaveLength(5);
    expect(f.maxParameters).toBeLessThanOrEqual(100);
    expect(f.maxSqlBytes).toBeLessThanOrEqual(100000);
  });
  it("requires fresh review after the exact standing read-grant version changes", async () => {
    const f = await slackFixture(),
      { grant } = await f.prepare();
    await f.disclose(grant);
    f.sqlite.exec("UPDATE founder_automatic_read_grants SET version=version+1");
    expect((await f.approve(grant)).response.status).toBeGreaterThanOrEqual(400);
    expect((await tickFounderAutomaticSlack(f.env, f.deps)).sent).toBe(0);
    expect(f.post).not.toHaveBeenCalled();
  });
  it.each(["expired", "changed"])(
    "requires the exact still-current sample through human approval (%s)",
    async (kind) => {
      const f = await slackFixture();
      if (kind === "expired") vi.setSystemTime(f.sample.expiresAt - 1000);
      const { grant } = await f.prepare();
      await f.disclose(grant);
      if (kind === "expired") vi.setSystemTime(f.sample.expiresAt + 1);
      else {
        const markdown = f.sample.markdown + "\nChanged illustrative source\n",
          hash = founderAutomaticReadReportHash({ ...f.sample, markdown });
        f.sqlite
          .prepare(
            "UPDATE founder_automatic_read_occurrences SET markdown=?,report_hash=? WHERE id=?",
          )
          .run(markdown, hash, f.sampleId);
      }
      expect((await f.approve(grant)).response.status).toBeGreaterThanOrEqual(400);
      expect(f.sqlite.prepare("SELECT state FROM founder_automatic_slack_grants").get()).toEqual({
        state: "disclosed",
      });
      expect(f.post).not.toHaveBeenCalled();
    },
  );
  it("hides protected grant and delivery bytes if time expires while the final response awaits", async () => {
    const f = await slackFixture(),
      grant = await f.enabled();
    await f.future();
    await tickFounderAutomaticSlack(f.env, f.deps);
    actor.email = OWNER;
    const original = f.env.AGENT_AUDIT.prepare.bind(f.env.AGENT_AUDIT);
    let hit = false;
    f.env.AGENT_AUDIT.prepare = (sql) => {
      const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
        ({
          ...s,
          bind: (...v: unknown[]) => wrap(s.bind(...v)),
          all: async <T>() => {
            const result = await s.all<T>();
            if (!hit && sql.includes("SELECT 'actor' AS kind") && sql.includes("asread")) {
              hit = true;
              vi.setSystemTime(grant.expiresAt + 1);
            }
            return result;
          },
        }) as D1PreparedStatement;
      return wrap(original(sql));
    };
    const state = await f.callSlack();
    expect(hit).toBe(true);
    expect(state.value.grants).toEqual([]);
    expect(state.value.deliveries).toEqual([]);
  });
  it("rejects oversize complete Unicode reports instead of truncating or silently choosing fields", () => {
    expect(() => renderAutomaticSlackReport("🐕".repeat(1000))).toThrow(
      "automatic_slack_complete_report_too_large",
    );
    expect(renderAutomaticSlackReport("<!channel> & details")).toContain(
      "&lt;!channel&gt; &amp; details",
    );
  });
  it("sends the next weekly completed report under a newly reviewed lease after private sample expiry", async () => {
    const f = await slackFixture({ weekly: true }),
      grant = await f.enabled();
    expect(grant.expiresAt).toBeGreaterThan(Date.now() + 7 * 86400000);
    expect(f.post).not.toHaveBeenCalled();
    const due = Number(
      f.sqlite
        .prepare("SELECT next_due_at FROM founder_automatic_read_grants WHERE id=?")
        .get(f.source.grant!.id)?.next_due_at,
    );
    vi.setSystemTime(due + 100);
    expect((await tickFounderAutomaticReads(f.env)).completed).toBe(1);
    actor.email = OWNER;
    const state = await f.callSlack();
    expect(state.value.grants[0]).toMatchObject({
      state: "enabled",
      sampleContent: null,
      sampleExpiresAt: null,
      canPause: true,
      canRevoke: true,
    });
    expect(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM founder_automatic_read_occurrences").get(),
    ).toEqual({ n: 2 });
    expect((await tickFounderAutomaticSlack(f.env, f.deps)).sent).toBe(1);
    expect(f.post).toHaveBeenCalledTimes(1);
    expect((await tickFounderAutomaticSlack(f.env, f.deps)).sent).toBe(0);
    expect(f.post).toHaveBeenCalledTimes(1);
  });
  it.each(["unknown", "revoked"])(
    "keeps next-week %s outcomes fenced without replay or unauthorized delivery",
    async (kind) => {
      const f = await slackFixture({ weekly: true });
      await f.enabled();
      const due = Number(
        f.sqlite
          .prepare("SELECT next_due_at FROM founder_automatic_read_grants WHERE id=?")
          .get(f.source.grant!.id)?.next_due_at,
      );
      vi.setSystemTime(due + 100);
      expect((await tickFounderAutomaticReads(f.env)).completed).toBe(1);
      if (kind === "unknown")
        f.post.mockRejectedValueOnce(new Error("Fixture potential Slack acceptance, receipt lost"));
      else
        f.verify.mockImplementationOnce(async () => {
          f.sqlite.exec("UPDATE workspace_app_grants SET state='revoked'");
          return { teamId: "T123", userId: "UB123", botId: "B123" };
        });
      const outcome = await tickFounderAutomaticSlack(f.env, f.deps);
      expect(kind === "unknown" ? outcome.unknown : outcome.blocked).toBe(1);
      const calls = kind === "unknown" ? 1 : 0;
      expect(f.post).toHaveBeenCalledTimes(calls);
      await tickFounderAutomaticSlack(f.env, f.deps);
      expect(f.post).toHaveBeenCalledTimes(calls);
    },
  );
  it("requires authoritative workspace selection, same-origin JSON and verified human session", async () => {
    const f = await slackFixture();
    expect(
      (await f.callSlack("/preview", f.input(), { Origin: "https://other.invalid" })).response
        .status,
    ).toBe(403);
    expect(
      (await f.callSlack("/preview", f.input(), { "X-Shiba-Workspace": "ws_" + "a".repeat(24) }))
        .response.status,
    ).toBe(404);
    expect(
      (await f.callSlack("/preview", { ...f.input(), ownerAccountId: f.owner.accountId })).response
        .status,
    ).toBe(400);
    expect(f.post).not.toHaveBeenCalled();
  });
  it("keeps runtime and migration schema aligned on an existing canonical database", async () => {
    const f = await slackFixture();
    const sql = readFileSync(
      new URL("../migrations/0023_founder_automatic_slack.sql", import.meta.url),
      "utf8",
    );
    f.sqlite.exec(sql);
    f.sqlite.exec(sql);
    for (const statement of AUTOMATIC_SLACK_SCHEMA) expect(sql).toContain(statement);
    expect(
      f.sqlite.prepare("SELECT COUNT(*)AS n FROM founder_automatic_slack_deliveries").get(),
    ).toEqual({ n: 0 });
  });
});
