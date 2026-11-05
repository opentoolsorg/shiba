/** Deterministic integration: real auth, grants, Slack identity store, room/run/approval and local mailbox.
 * Think transport, child RPC and local CLI are fixtures; no installed Slack or provider is contacted. */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  localRunEnvelopeSchema,
  personalExecutionContextDigest,
  type PersonalExecutionSnapshot,
  type LocalRunEnvelope,
} from "@shiba/shared";
import { handleBetterAuth } from "../src/better-auth.js";
import type { Env } from "../src/env.js";
import { handlePersonalExecution } from "../src/personal-execution-routes.js";
import { LocalDispatch } from "../src/local-dispatch.js";
import { handleLocalAdapter } from "../src/local-routes.js";
import {
  createTeamWorkspace,
  createTeamWorkspaceInvitation,
  acceptTeamWorkspaceInvitation,
} from "../src/team-workspaces-store.js";
import { handleCollaboration } from "../src/collaboration-routes.js";
import { handleCollaborationApproval } from "../src/collaboration-approval-routes.js";
import { handleSlackCoworker } from "../src/slack-coworker-routes.js";
import { sealSlackSecret } from "../src/slack-installations-crypto.js";
import { tickSlackCoworkerPrivateStatus } from "../src/slack-coworker-private-status.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import {
  beginSlackCoworkerBinding,
  observeSlackCoworkerChallenge,
  confirmSlackCoworkerOnSlack,
  confirmSlackCoworkerBinding,
  grantSlackCoworkerIntake,
  intakeSlackCoworkerEvent,
  revokeSlackCoworkerIntake,
} from "../src/slack-coworker-store.js";
import {
  installationSnapshot,
  installationPurpose,
  slackInstallationGuard,
  type SlackInstallationRow,
} from "../src/slack-installations-store.js";
import { resolveWorkspaceNativeMember } from "../src/workspace-native-authority.js";
import { resolveOrgForApiRequest } from "../src/org-request-auth.js";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { parseAgentToolInput, formatAgentResult } from "../src/opencode-input.js";
import { assertChildDispatchAuthorized } from "../src/child-dispatch.js";
import { LocalRuntimeAdapter, type LocalDispatchClient } from "../src/runtime.js";
import { resolveHarness } from "../src/harness/index.js";

const routed = vi.hoisted(() => ({
  fetch: undefined as ((name: string, request: Request) => Promise<Response>) | undefined,
  execute: vi.fn(),
}));
vi.mock("agents/routing", async (original) => ({
  ...(await original<typeof import("agents/routing")>()),
  getAgentByName: async (_ns: unknown, name: string) => ({
    fetch: (input: Request | string) =>
      routed.fetch!(name, input instanceof Request ? input : new Request(input)),
  }),
}));
vi.mock("agents", async (original) => ({
  ...(await original<typeof import("agents")>()),
  getAgentByName: async (_ns: unknown, name: string) => ({
    fetch: (input: Request | string) =>
      routed.fetch!(name, input instanceof Request ? input : new Request(input)),
  }),
}));
vi.mock("@cloudflare/think", () => ({
  Think: class {
    messages: unknown[] = [];
    async addMessages(messages: unknown[]) {
      this.messages.push(...messages);
    }
    onStart() {}
    getTools() {
      return {};
    }
    onRequest() {
      return new Response(null, { status: 404 });
    }
    keepAliveWhile(fn: () => Promise<unknown>) {
      return fn();
    }
    async schedule() {
      return {};
    }
  },
}));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: routed.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
const BASE = "https://personal.example.test",
  OWNER = "owner@example.test",
  ALICE = "alice@example.test",
  BOB = "bob@example.test";
const ACCOUNT = "a".repeat(64),
  AUTH = "b".repeat(64),
  REPO = "https://github.com/opentoolsorg/shiba";
const databases: DatabaseSync[] = [];
interface FixtureStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  transaction<T>(operation: (tx: FixtureStorage) => Promise<T>): Promise<T>;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  routed.execute.mockReset();
  for (const db of databases.splice(0)) db.close();
  routed.fetch = undefined;
});

function req(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { Origin: BASE, "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const cookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((item) => item.split(";")[0])
    .join("; ");

async function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  const value = (input: unknown): never =>
    (input instanceof Date
      ? input.getTime()
      : typeof input === "boolean"
        ? Number(input)
        : (input ?? null)) as never;
  const prepared = (sql: string, values: unknown[] = []) => ({
    bind: (...input: unknown[]) => prepared(sql, input),
    async all() {
      const results = sqlite.prepare(sql).all(...values.map(value));
      return { results, meta: { changes: Number(sqlite.prepare("SELECT changes() c").get()?.c) } };
    },
    async run() {
      return this.all();
    },
    async first() {
      return sqlite.prepare(sql).get(...values.map(value)) ?? null;
    },
  });
  const database = {
    prepare: (sql: string) => prepared(sql),
    exec: (sql: string) => sqlite.exec(sql),
    async batch(statements: ReturnType<typeof prepared>[]) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.all());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  const send = vi.fn(async (_mail: unknown) => {});
  const env = {
    AGENT_AUDIT: database,
    BETTER_AUTH_SECRET: "s".repeat(32),
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_BOOTSTRAP_TOKEN: "fixture-bootstrap",
    BETTER_AUTH_VERIFICATION_FROM: "auth@example.test",
    SEND_EMAIL: { send },
    SHIBA_LOCAL_RUNTIME: "1",
    SHIBA_PERSONAL_LOCAL_EXECUTION: "1",
    PAIRING_SECRET: "fixture-pairing-key-at-least-32-characters",
    LOCAL_ADAPTER_TOKEN: "legacy-operator-token",
    INTERNAL_SIGNING_KEY: "fixture-internal-key-at-least-32-characters",
  } as unknown as Env;
  const map = new Map<string, unknown>();
  let transactionQueue = Promise.resolve();
  const storage: FixtureStorage = {
    async get<T>(key: string) {
      return map.get(key) as T | undefined;
    },
    async put(key: string, input: unknown) {
      map.set(key, input);
    },
    async delete(key: string) {
      return map.delete(key);
    },
    async list<T>({ prefix }: { prefix: string }) {
      return new Map([...map].filter(([key]) => key.startsWith(prefix))) as Map<string, T>;
    },
    transaction<T>(operation: (tx: FixtureStorage) => Promise<T>): Promise<T> {
      const pending = transactionQueue.then(() => operation(storage));
      transactionQueue = pending.then(
        () => {},
        () => {},
      );
      return pending;
    },
  };
  const dispatch = new LocalDispatch({ storage } as never, env);
  env.LocalDispatch = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: (request: Request) => dispatch.fetch(request) }),
  } as unknown as DurableObjectNamespace;
  const native = (request: Request) =>
    handleBetterAuth(request, env, { teamMemberPolicyEnabled: true });
  const registeredOwner = await native(
    req(
      "/api/auth/sign-up/email",
      "POST",
      { name: "Owner", email: OWNER, password: "fixture-owner-password" },
      { "x-shiba-bootstrap-token": "fixture-bootstrap" },
    ),
  );
  expect(registeredOwner?.status).toBe(200);
  const ownerCookie = cookie(registeredOwner!);
  const status = (await (await native(
    req("/api/auth/bootstrap-verification", "GET", undefined, { cookie: ownerCookie }),
  ))!.json()) as { statusSnapshot: string };
  expect(
    (
      await native(
        req(
          "/api/auth/bootstrap-verification",
          "POST",
          { expectedSnapshot: status.statusSnapshot },
          { cookie: ownerCookie },
        ),
      )
    )?.status,
  ).toBe(200);
  const ownerVerification = (send.mock.calls.at(-1)?.[0] as { text?: string })?.text?.match(
    /https:\/\/\S+/,
  )?.[0];
  if (!ownerVerification) throw new Error("Fixture owner verification URL missing.");
  const ownerToken = new URLSearchParams(new URL(ownerVerification).hash.slice(1)).get(
    "bootstrapVerification",
  );
  expect(
    (await native(req("/api/auth/bootstrap-verification/confirm", "POST", { token: ownerToken })))
      ?.status,
  ).toBe(200);
  const workspace = await createTeamWorkspace(env, OWNER, { name: "Personal run fixture" });
  const cookies = new Map<string, string>();
  for (const email of [ALICE, BOB]) {
    const invitation = await createTeamWorkspaceInvitation(env, workspace.workspaceId, OWNER, {
      email,
      role: "member",
    });
    const registered = (await native(
      req(
        "/api/auth/sign-up/email",
        "POST",
        { name: email, email, password: "fixture-member-password", callbackURL: "/app/" },
        { "x-shiba-workspace-invitation": invitation.token },
      ),
    ))!;
    expect(registered.status).toBe(200);
    cookies.set(email, cookie(registered));
    const mail = send.mock.calls.at(-1)?.[0] as { text?: string };
    const verification = mail.text?.match(/https:\/\/\S+/)?.[0];
    if (!verification) throw new Error("Fixture verification URL missing.");
    expect((await native(new Request(verification)))?.status).toBe(302);
    await acceptTeamWorkspaceInvitation(env, email, invitation.token);
  }
  const headers = (email = ALICE) => ({
    cookie: cookies.get(email)!,
    "X-Shiba-Workspace": workspace.workspaceId,
  });
  const api = (path: string, method = "GET", body?: unknown, email = ALICE) =>
    handlePersonalExecution(
      req(`/api/personal-execution${path}`, method, body, headers(email)),
      env,
    );
  const local = (path: string, body: unknown, token?: string) =>
    handleLocalAdapter(
      req(`/api/local/${path}`, "POST", body, token ? { Authorization: `Bearer ${token}` } : {}),
      env,
    );
  const http = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://api.github.com/repos/opentoolsorg/shiba");
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    return Response.json({ private: false, html_url: REPO });
  });
  vi.stubGlobal("fetch", http);
  async function pair(email = ALICE) {
    const minted = await api(
      "/pairing-token",
      "POST",
      { harness: "claude-code", accountFingerprint: ACCOUNT },
      email,
    );
    expect(minted?.status).toBe(200);
    const token = (await minted!.json()) as { token: string; connectCommand: string };
    expect(token.connectCommand).toContain(
      `--personal-harness claude-code --personal-billing native-subscription --personal-account ${ACCOUNT}`,
    );
    const response = await local("pair", {
      pairingToken: token.token,
      hostname: "Own computer",
      platform: "linux-x64",
      daemonVersion: "fixture",
      harnesses: ["claude", "codex"],
    });
    expect(response.status).toBe(200);
    return {
      ...((await response.json()) as { adapterToken: string; machineId: string }),
      pairingToken: token.token,
    };
  }
  const receipt = () => ({
    schemaVersion: 1,
    harness: "claude-code",
    billingMode: "native-subscription",
    accountFingerprint: ACCOUNT,
    authVersion: AUTH,
    cliVersion: "2.1.0",
    probeMethod: "claude-auth-status",
    probedAt: Date.now(),
  });
  async function ready(email = ALICE) {
    const machine = await pair(email);
    expect(
      (await local("personal-account", { account: receipt() }, machine.adapterToken)).status,
    ).toBe(200);
    const computers = (await (await api("/computers", "GET", undefined, email))!.json()) as {
      computers: Array<{ machineId: string; personalExecution: { revision: number } }>;
    };
    return {
      ...machine,
      revision: computers.computers.find((item) => item.machineId === machine.machineId)!
        .personalExecution.revision,
    };
  }
  async function grant(machine: Awaited<ReturnType<typeof ready>>, email = ALICE) {
    const response = await api(
      "/grants",
      "POST",
      {
        machineId: machine.machineId,
        machineRevision: machine.revision,
        harness: "claude-code",
        accountFingerprint: ACCOUNT,
        authVersion: AUTH,
        codingModel: "anthropic/claude-sonnet-4-6",
        repoUrl: REPO,
        expiresAt: Date.now() + 3_600_000,
        consent: true,
        hostingConsent: true,
      },
      email,
    );
    expect(response?.status).toBe(201);
    return ((await response!.json()) as { snapshot: PersonalExecutionSnapshot }).snapshot;
  }
  function envelope(snapshot: PersonalExecutionSnapshot, sandboxId = "personal-job") {
    const proof = {
      snapshot,
      approvalId: "approval-fixture",
      inputHash: "d".repeat(64),
      generation: 0,
      executionOwner: `web:${ALICE}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      handoffId: "handoff-fixture",
      contextDigest: "e".repeat(64),
      approvedUntil: Date.now() + 60_000,
    };
    const result = localRunEnvelopeSchema.parse({
      version: 1,
      sandboxId,
      repoUrl: REPO,
      baseBranch: "main",
      task: "Review this public repository.",
      harness: "claude-code",
      cloneDir: "${SHIBA_LOCAL_RUN_ROOT}/work",
      homeDir: "${SHIBA_LOCAL_RUN_ROOT}/home",
      setupCommands: [],
      configFiles: [],
      argv: [],
      env: {},
      execAllowlist: [],
      setupAllowlist: [],
      createdAt: Date.now(),
      deadlineAt: Date.now() + 60_000,
      orgId: `team:${snapshot.workspaceId}`,
      customAgentId: "employee-fixture",
      customAgentVersion: 1,
      session: {
        provider: "claude",
        model: "claude-sonnet-4-6",
        permissionMode: "approval-required",
      },
      personalExecution: proof,
    });
    result.personalExecution!.contextDigest = personalExecutionContextDigest({
      ...result,
      handoffId: proof.handoffId,
    });
    return result;
  }
  const dispatchJob = (snapshot: PersonalExecutionSnapshot, sandboxId?: string) =>
    dispatch.fetch(
      new Request("https://local-dispatch/dispatch", {
        method: "POST",
        body: JSON.stringify({
          envelope: envelope(snapshot, sandboxId),
          targetMachineId: snapshot.machineId,
          dashboardOwnerId: snapshot.actorId,
        }),
      }),
    );
  return {
    env,
    sqlite,
    map,
    dispatch,
    api,
    local,
    headers,
    pair,
    ready,
    grant,
    receipt,
    http,
    workspace,
    envelope,
    dispatchJob,
  };
}

async function execution(options: { privateStatus?: boolean; consent?: boolean } = {}) {
  const f = await fixture(),
    machine = await f.ready(),
    snapshot = await f.grant(machine);
  Object.assign(f.env, productionEnvStubs(), {
    SHIBA_LOCAL_RUNTIME: "1",
    SHIBA_PERSONAL_LOCAL_EXECUTION: "1",
    SLACK_INSTALLATIONS_ENABLED: "true",
    ...(options.privateStatus
      ? {
          SLACK_COWORKER_PRIVATE_STATUS_ENABLED: "true",
          SLACK_OAUTH_APP_ID: "A1",
          SLACK_OAUTH_CLIENT_ID: "1.1",
          SLACK_OAUTH_REDIRECT_URI: `${BASE}/api/slack/installations/callback`,
          SLACK_OAUTH_PKCE_ENABLED: "true",
          SLACK_OAUTH_QUERY_REDACTION_VERIFIED: "true",
          SLACK_SIGNING_SECRET: "fixture-slack-signing-secret",
          SLACK_INSTALLATION_KEYRING: JSON.stringify({
            activeKeyId: "fixture",
            keys: { fixture: "c".repeat(64) },
          }),
        }
      : {}),
    CodingOrchestrator: {},
    AI_GATEWAY_TOKEN: undefined,
  });
  const deployment = vi.fn(() => {
    throw new Error("Unexpected deployment inference or sandbox access.");
  });
  f.env.ModelConfig = { idFromName: deployment } as unknown as Env["ModelConfig"];
  f.env.Sandbox = { idFromName: deployment } as unknown as Env["Sandbox"];
  const hosts = new Map<string, CodingOrchestrator>(),
    dispatches = vi.fn();
  routed.fetch = async (name, request) => {
    if (!hosts.has(name))
      hosts.set(
        name,
        Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
          env: f.env,
          name,
          messages: [],
          state: { runs: [] },
          setState(next: OrchestratorState) {
            setStateLikeProduction(this, next);
          },
          dispatchApprovedRun: dispatches,
        }),
      );
    return hosts.get(name)!.onRequest(request);
  };
  const send = (path: string, method = "GET", body?: unknown, actor = ALICE) =>
    (path.endsWith("/approval") ? handleCollaborationApproval : handleCollaboration)(
      req(`/api/collaboration${path}`, method, body, f.headers(actor)),
      f.env,
    );
  const coworker = (path: string, method = "GET", body?: unknown, actor = ALICE) =>
    handleSlackCoworker(req(`/api/slack/coworker${path}`, method, body, f.headers(actor)), f.env);
  const auth = await resolveOrgForApiRequest(
    req("/api/slack/coworker", "GET", undefined, f.headers()),
    f.env,
    { allowMemberWrite: true },
  );
  if (auth instanceof Response || !auth.workspace) throw new Error("Missing native workspace.");
  const member = (await resolveWorkspaceNativeMember(
    req("/api/slack/coworker", "GET", undefined, f.headers()),
    f.env,
    auth.workspace,
  ))!;
  for (const migration of ["0018_slack_installations.sql", "0024_slack_coworker.sql"])
    f.sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  const ownerAccount = f.sqlite.prepare('SELECT id FROM "user" WHERE email=?').get(OWNER) as {
    id: string;
  };
  const installationOwner = {
    workspaceId: member.workspaceId,
    userId: OWNER,
    accountId: ownerAccount.id,
    version: 1,
    role: "owner",
    joinedAt: 1,
  };
  f.sqlite
    .prepare(`INSERT INTO slack_installations(id,workspace_id,owner_id,owner_account_id,owner_member_json,app_id,team_id,bot_user_id,bot_id,installer_slack_user_id,scopes_json,generation,version,token_revision,state,digest,token_cipher,activation_expires_at,created_at)
    VALUES('i1',?,?,?,?, 'A1','T1','UBOT','B1','UINSTALL','["chat:write","commands","app_mentions:read"]',1,1,1,'active','digest','fixture-unused-cipher',?,1)`)
    .run(
      member.workspaceId,
      OWNER,
      ownerAccount.id,
      JSON.stringify(installationOwner),
      Date.now() + 600_000,
    );
  const installation = installationSnapshot(
    f.sqlite.prepare("SELECT * FROM slack_installations").get() as unknown as SlackInstallationRow,
  );
  const installationGuard = slackInstallationGuard(installation);
  if (options.privateStatus) {
    const sealed = await sealSlackSecret(
      f.env,
      {
        workspaceId: member.workspaceId,
        subject: installation.id,
        purpose: installationPurpose(installation),
      },
      JSON.stringify({ accessToken: "xoxb-fixture-status-never-live" }),
    );
    f.sqlite
      .prepare("UPDATE slack_installations SET token_key_id=?,token_cipher=? WHERE id=?")
      .run(sealed.keyId, sealed.cipher, installation.id);
  }
  expect(
    f.sqlite.prepare('SELECT emailVerified FROM "user" WHERE id=?').get(ownerAccount.id),
  ).toMatchObject({ emailVerified: 1 });
  expect(
    f.sqlite
      .prepare("SELECT email FROM shiba_auth_account_policy WHERE account_id=?")
      .get(ownerAccount.id),
  ).toMatchObject({ email: OWNER });
  expect(
    f.sqlite
      .prepare(
        "SELECT role,status,version FROM team_workspace_memberships WHERE workspace_id=? AND user_id=?",
      )
      .get(member.workspaceId, OWNER),
  ).toMatchObject({ role: "owner", status: "active", version: 1 });
  expect(
    await f.env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${installationGuard.sql}`)
      .bind(...installationGuard.values)
      .first(),
  ).not.toBeNull();
  const challenge = await beginSlackCoworkerBinding(f.env, member, installation);
  expect(
    await observeSlackCoworkerChallenge(f.env, installation, challenge.secret, "U1"),
  ).not.toBeNull();
  expect(await confirmSlackCoworkerOnSlack(f.env, installation, challenge.id, "U1", true)).toBe(
    true,
  );
  const binding = await confirmSlackCoworkerBinding(
    f.env,
    member,
    installation,
    challenge.id,
    "U1",
  );
  const intake = await grantSlackCoworkerIntake(f.env, member, binding.id, "C1", "123.000001");
  expect(
    await intakeSlackCoworkerEvent(f.env, installation, "EVENT1", {
      user: "U1",
      channel: "C1",
      thread_ts: "123.000001",
      ts: `${Math.floor(Date.now() / 1000) + 1}.000002`,
      text: "Inspect the public repository.",
    }),
  ).toBe(true);
  const drafts = (await (await coworker("/drafts"))!.json()) as { drafts: Array<{ id: string }> };
  const roomResponse = await send("/rooms", "POST", {
    title: "Slack reviewed work",
    visibility: "shared",
  });
  expect(roomResponse?.status).toBe(201);
  const { room } = (await roomResponse!.json()) as { room: { roomId: string } };
  const profile = await createCustomAgent(
    f.env,
    `team:${f.workspace.workspaceId}`,
    "slack-engineer",
    { name: "Engineer", harness: "opencode", instructions: "Use only the approved repository." },
  );
  expect(
    (
      await send(`/rooms/${room.roomId}/agents`, "POST", {
        profileId: profile.id,
        profileVersion: 1,
      })
    )?.status,
  ).toBe(201);
  const selection = {
    requestId: crypto.randomUUID(),
    id: drafts.drafts[0]!.id,
    roomId: room.roomId,
    recipientActorId: `agent:${profile.id}`,
    personalExecution: { grantId: snapshot.grantId, expectedVersion: 1 },
  };
  const prepared = await coworker("/drafts/prepare-submission", "POST", selection);
  expect(await prepared?.clone().json()).not.toHaveProperty("error");
  expect(prepared?.status).toBe(200);
  const { preview } = (await prepared!.json()) as {
    preview: {
      previewId: string;
      digest: string;
      consent: string;
      personalExecution: PersonalExecutionSnapshot;
    };
  };
  expect(preview.personalExecution).toEqual(snapshot);
  const decision = {
    previewId: preview.previewId,
    digest: preview.digest,
    reviewed: true,
    audienceConsent: preview.consent,
    privateStatusConsent: options.consent ?? options.privateStatus ?? false,
  };
  const submitted = await coworker("/drafts/submit", "POST", decision);
  expect(await submitted?.clone().json()).not.toHaveProperty("error");
  expect(submitted?.status).toBe(201);
  const { receipt } = (await submitted!.json()) as {
    receipt: { handoffId: string; state: string };
  };
  const host = [...hosts.values()][0]!;
  return {
    ...f,
    machine,
    snapshot,
    member,
    intake,
    deployment,
    dispatches,
    host,
    coworker,
    send,
    selection,
    decision,
    receipt,
    roomId: room.roomId,
    profile,
  };
}

describe("Slack author to approved owned local execution", () => {
  it("does not grant private status merely because an installation and preview target exist", async () => {
    const f = await execution({ privateStatus: true, consent: false });
    f.http.mockClear();
    await tickSlackCoworkerPrivateStatus(f.env);
    expect(
      f.sqlite.prepare("SELECT count(*) AS count FROM slack_coworker_private_status").get(),
    ).toMatchObject({ count: 0 });
    expect(f.http).not.toHaveBeenCalled();
    expect(f.dispatches).not.toHaveBeenCalled();
  });
  it("sends only separately consented private status and never shares room results in Slack", async () => {
    const f = await execution({ privateStatus: true }),
      posts: Array<Record<string, unknown>> = [];
    f.http.mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://api.github.com/repos/opentoolsorg/shiba") {
        expect(
          new Headers(input instanceof Request ? input.headers : init?.headers).has(
            "Authorization",
          ),
        ).toBe(false);
        return Response.json({ private: false, html_url: REPO });
      }
      expect(
        new Headers(input instanceof Request ? input.headers : init?.headers).get("Authorization"),
      ).toBe("Bearer xoxb-fixture-status-never-live");
      if (url === "https://slack.com/api/auth.test")
        return Response.json(
          { ok: true, team_id: "T1", user_id: "UBOT", bot_id: "B1", enterprise_id: null },
          { headers: { "x-oauth-scopes": "chat:write" } },
        );
      expect(url).toBe("https://slack.com/api/chat.postEphemeral");
      posts.push(
        JSON.parse(
          input instanceof Request ? await input.clone().text() : String(init?.body),
        ) as Record<string, unknown>,
      );
      return Response.json({ ok: true, message_ts: "123.456" });
    });
    await tickSlackCoworkerPrivateStatus(f.env);
    await tickSlackCoworkerPrivateStatus(f.env);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel: "C1", user: "U1", thread_ts: "123.000001" });
    expect(String(posts[0]?.text)).not.toContain("Inspect the public repository.");
    const path = `/rooms/${f.roomId}/handoffs/${f.receipt.handoffId}/approval`;
    const reviewResponse = await f.send(path);
    expect(await reviewResponse?.clone().json()).not.toHaveProperty("error");
    expect(reviewResponse?.status).toBe(200);
    const review = (await reviewResponse!.json()) as {
      inputHash: string;
      approval: { approvalId: string };
    };
    expect(
      (
        await f.send(path, "POST", {
          expectedInputHash: review.inputHash,
          reviewed: true,
          approved: true,
        })
      )?.status,
    ).toBe(200);
    routed.execute.mockResolvedValueOnce(
      formatAgentResult({
        status: "completed",
        summary: "PRIVATE_RESULT_MUST_STAY_IN_SHIBA",
        exitCode: 0,
        stderrTail: "",
        changedFiles: ["private.md"],
        diff: "PRIVATE_DIFF_MUST_STAY_IN_SHIBA",
        files: [
          { path: "private.md", content: "PRIVATE_FILE_MUST_STAY_IN_SHIBA", encoding: "utf8" },
        ],
      }),
    );
    const delegate = (
      f.host as unknown as {
        approvedRunDelegate(): { execute(input: unknown, options: unknown): Promise<unknown> };
      }
    ).approvedRunDelegate();
    await delegate.execute({}, { toolCallId: review.approval.approvalId });
    expect(f.host.state.runs[0]?.status).toBe("completed");
    f.sqlite.prepare("UPDATE slack_coworker_private_status SET next_check_at=0").run();
    await tickSlackCoworkerPrivateStatus(f.env);
    await tickSlackCoworkerPrivateStatus(f.env);
    expect(posts).toHaveLength(2);
    expect(JSON.stringify(posts)).not.toMatch(
      /PRIVATE_|Inspect the public repository|github\.com|plex_|Bearer/,
    );
    expect(
      (
        await f.coworker(
          "/drafts/status/revoke",
          "POST",
          { previewId: f.decision.previewId, reviewed: true },
          BOB,
        )
      )?.status,
    ).toBe(404);
    const stopped = await f.coworker("/drafts/status/revoke", "POST", {
      previewId: f.decision.previewId,
      reviewed: true,
    });
    expect(stopped?.status).toBe(200);
    f.env.SLACK_COWORKER_PRIVATE_STATUS_ENABLED = "false";
    f.env.SLACK_INSTALLATIONS_ENABLED = "false";
    expect(
      await (await f.coworker(`/drafts/submission?id=${f.selection.id}`))!.json(),
    ).toMatchObject({ receipt: { privateStatusState: "revoked" } });
    expect(
      (
        await f.coworker("/drafts/status/revoke", "POST", {
          previewId: f.decision.previewId,
          reviewed: true,
        })
      )?.status,
    ).toBe(200);
    expect((await f.coworker("/drafts/prepare-submission", "POST", f.selection))?.status).toBe(503);
    await tickSlackCoworkerPrivateStatus(f.env);
    expect(posts).toHaveLength(2);
    expect(f.deployment).not.toHaveBeenCalled();
  });

  it("requires native review and human approval, claims once, and returns a scoped result without deployment fallback", async () => {
    const f = await execution(),
      path = `/rooms/${f.roomId}/handoffs/${f.receipt.handoffId}/approval`;
    expect(f.host.state.pendingApprovals).toHaveLength(1);
    expect(f.host.state.runs).toEqual([]);
    expect(f.dispatches).not.toHaveBeenCalled();
    expect([...f.map.keys()].filter((key) => key.startsWith("run:"))).toEqual([]);
    expect((await f.coworker("/drafts/submit", "POST", f.decision))?.status).toBe(409);
    expect((await f.send(path, "GET", undefined, BOB))?.status).toBe(404);
    const review = await f.send(path);
    expect(review?.status).toBe(200);
    const { inputHash, approval } = (await review!.json()) as {
      inputHash: string;
      approval: { approvalId: string; personalExecution: PersonalExecutionSnapshot };
    };
    expect(approval.personalExecution).toEqual(f.snapshot);
    expect(
      (
        await f.send(path, "POST", {
          expectedInputHash: "0".repeat(64),
          reviewed: true,
          approved: true,
        })
      )?.status,
    ).toBe(409);
    const approved = await f.send(path, "POST", {
      expectedInputHash: inputHash,
      reviewed: true,
      approved: true,
    });
    expect(await approved?.clone().json()).not.toHaveProperty("error");
    expect(approved?.status).toBe(200);
    expect(f.dispatches).toHaveBeenCalledOnce();
    expect(f.host.state.runs[0]?.personalExecution).toEqual(f.snapshot);
    let claims = 0;
    const client: LocalDispatchClient = {
      async dispatch(envelope, targetMachineId, dashboardOwnerId) {
        expect(envelope.personalExecution?.snapshot).toEqual(f.snapshot);
        expect(envelope.configFiles).toEqual([]);
        expect(envelope.env).toEqual({});
        expect(envelope.setupCommands).toEqual([]);
        const queued = await f.dispatch.fetch(
          new Request("https://local-dispatch/dispatch", {
            method: "POST",
            body: JSON.stringify({ envelope, targetMachineId, dashboardOwnerId }),
          }),
        );
        expect(queued.status).toBe(200);
        const claimed = await f.local("claim", {}, f.machine.adapterToken);
        expect(await claimed.clone().json()).not.toHaveProperty("error");
        expect(claimed.status).toBe(200);
        claims++;
        const held = (await claimed.json()) as { claimToken: string; envelope: LocalRunEnvelope };
        expect(held.envelope.task).toContain("Inspect the public repository.");
        expect(await (await f.local("claim", {}, f.machine.adapterToken)).json()).toEqual({
          envelope: null,
        });
        const result = {
          status: "completed",
          summary: "Fixture CLI inspected the approved repository.",
          exitCode: 0,
          stderrTail: "",
          changedFiles: ["report.md"],
          diff: "diff --git a/report.md b/report.md\nnew file mode 100644\n--- /dev/null\n+++ b/report.md\n@@ -0,0 +1 @@\n+Fixture review\n",
          files: [{ path: "report.md", content: "Fixture review\n", encoding: "utf8" }],
        };
        expect(
          (
            await f.local(
              "result",
              { sandboxId: envelope.sandboxId, claimToken: held.claimToken, result },
              f.machine.adapterToken,
            )
          ).status,
        ).toBe(200);
      },
      async status(sandboxId) {
        return (await (
          await f.dispatch.fetch(
            new Request(`https://local-dispatch/status?sandboxId=${sandboxId}`),
          )
        ).json()) as Awaited<ReturnType<LocalDispatchClient["status"]>>;
      },
      async cancel(sandboxId) {
        await f.dispatch.fetch(
          new Request("https://local-dispatch/cancel", {
            method: "POST",
            body: JSON.stringify({ sandboxId }),
          }),
        );
      },
    };
    routed.execute.mockImplementationOnce(async (raw: string) => {
      const input = parseAgentToolInput([{ role: "user", text: raw }]);
      await assertChildDispatchAuthorized(f.env, input);
      const adapter = new LocalRuntimeAdapter(resolveHarness(input.harness), {
        client,
        pollIntervalMs: 1,
      });
      return formatAgentResult(await adapter.runCodingTask({} as never, input, async () => {}));
    });
    const delegate = (
      f.host as unknown as {
        approvedRunDelegate(): { execute(input: unknown, options: unknown): Promise<unknown> };
      }
    ).approvedRunDelegate();
    await delegate.execute({}, { toolCallId: approval.approvalId });
    expect(claims).toBe(1);
    expect(routed.execute).toHaveBeenCalledOnce();
    expect(f.host.state.runs[0]).toMatchObject({
      status: "completed",
      summary: expect.stringContaining("Fixture CLI inspected the approved repository."),
      diff: expect.stringContaining("report.md"),
    });
    expect(f.deployment).not.toHaveBeenCalled();
    const detail = (await (await f.send(`/rooms/${f.roomId}`))!.json()) as {
      handoffs: Array<{ handoffId: string; execution?: { runStatus?: string; summary?: string } }>;
    };
    expect(
      detail.handoffs.find((h) => h.handoffId === f.receipt.handoffId)?.execution,
    ).toMatchObject({
      runStatus: "completed",
      summary: expect.stringContaining("Fixture CLI inspected"),
    });
    expect(
      (await f.send(path, "POST", { expectedInputHash: inputHash, reviewed: true, approved: true }))
        ?.status,
    ).toBe(409);
    expect(
      f.http.mock.calls.every(
        ([url]) => String(url) === "https://api.github.com/repos/opentoolsorg/shiba",
      ),
    ).toBe(true);
    await revokeSlackCoworkerIntake(f.env, f.member, f.intake.id);
    const revoked = (await (await f.send(`/rooms/${f.roomId}`))!.json()) as {
      handoffs: Array<{ handoffId: string; execution?: unknown }>;
    };
    expect(
      revoked.handoffs.find((h) => h.handoffId === f.receipt.handoffId)?.execution,
    ).toMatchObject({ unavailable: true, runStatus: "unknown" });
    expect(JSON.stringify(revoked)).not.toContain("Fixture CLI inspected the approved repository.");
  });

  it("blocks queued work and receipt task disclosure after source revocation", async () => {
    const f = await execution(),
      path = `/rooms/${f.roomId}/handoffs/${f.receipt.handoffId}/approval`;
    const review = (await (await f.send(path))!.json()) as { inputHash: string };
    await revokeSlackCoworkerIntake(f.env, f.member, f.intake.id);
    expect(
      (
        await f.send(path, "POST", {
          expectedInputHash: review.inputHash,
          reviewed: true,
          approved: true,
        })
      )?.status,
    ).toBe(409);
    const state = await (await f.coworker(`/drafts/submission?id=${f.selection.id}`))!.json();
    expect(state).toMatchObject({
      preview: null,
      sourceAvailable: false,
      receipt: { state: "queued" },
    });
    expect(JSON.stringify(state)).not.toContain("Inspect the public repository.");
    expect(f.dispatches).not.toHaveBeenCalled();
    expect(routed.execute).not.toHaveBeenCalled();
    expect(f.deployment).not.toHaveBeenCalled();
  });

  it("does not let another verified member submit, impersonate the decider or retrieve the source", async () => {
    const f = await execution();
    expect((await f.coworker("/drafts/submit", "POST", f.decision, BOB))?.status).toBe(409);
    const other = await (await f.coworker(
      `/drafts/submission?id=${f.selection.id}`,
      "GET",
      undefined,
      BOB,
    ))!.json();
    expect(other).toMatchObject({ preview: null, receipt: null, sourceAvailable: false });
    expect(JSON.stringify(other)).not.toContain("Inspect the public repository.");
    const otherWorkspace = await createTeamWorkspace(f.env, BOB, { name: "Unrelated team" });
    const cross = await handleSlackCoworker(
      req("/api/slack/coworker/drafts/submit", "POST", f.decision, {
        ...f.headers(BOB),
        "X-Shiba-Workspace": otherWorkspace.workspaceId,
      }),
      f.env,
    );
    expect(cross?.status).toBe(409);
    const path = `/rooms/${f.roomId}/handoffs/${f.receipt.handoffId}/approval`;
    const review = (await (await f.send(path))!.json()) as { inputHash: string };
    expect(
      (
        await f.send(
          path,
          "POST",
          { expectedInputHash: review.inputHash, reviewed: true, approved: true, decidedBy: ALICE },
          BOB,
        )
      )?.status,
    ).toBe(400);
    expect(f.host.state.pendingApprovals?.[0]?.status).toBe("pending");
    expect(f.dispatches).not.toHaveBeenCalled();
    expect(routed.execute).not.toHaveBeenCalled();
  });
});
