import { readFileSync } from "node:fs";
import {
  tickSlackCoworkerPrivateStatus,
  readSlackCoworkerPrivateStatus,
  revokeSlackCoworkerPrivateStatus,
} from "../src/slack-coworker-private-status.js";
import {
  installationSnapshot,
  installationPurpose,
  type SlackInstallationRow,
} from "../src/slack-installations-store.js";
import { sealSlackSecret } from "../src/slack-installations-crypto.js";
import { pinCollaborationHandoffExecutor } from "../src/collaboration-store.js";
import { describe, it, expect, vi } from "vitest";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { createTeamWorkspace } from "../src/team-workspaces-store.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import {
  createCollaborationRoom,
  addCollaborationMember,
  createRootCollaborationHandoff,
  linkCollaborationHandoffRun,
  humanActorId,
} from "../src/collaboration-store.js";
import {
  prepareSlackCoworkerSubmission,
  claimSlackCoworkerSubmission,
  consumeSlackCoworkerSubmission,
  finishSlackCoworkerSubmission,
  bindSlackCoworkerApproval,
} from "../src/slack-coworker-execution.js";
import type { Env } from "../src/env.js";
const state = vi.hoisted(() => ({
  scope: null as any,
  grant: null as any,
  grantCurrent: true,
  approval: null as any,
}));
vi.mock("agents/routing", async (original) => ({
  ...(await original<typeof import("agents/routing")>()),
  getAgentByName: async () => ({
    fetch: async (request: Request) =>
      new URL(request.url).pathname === "/api/approvals"
        ? Response.json({ approvals: state.approval ? [state.approval] : [], decided: [] })
        : new Response("", { status: 404 }),
  }),
}));
vi.mock("../src/personal-execution-store.js", async (original) => ({
  ...(await original<typeof import("../src/personal-execution-store.js")>()),
  resolvePersonalExecutionOwner: async () => state.scope,
  resolvePersonalExecutionGrant: async () => state.grant,
  personalGrantFence: async () => state.grantCurrent,
}));
vi.mock("../src/request-auth.js", async (original) => ({
  ...(await original<typeof import("../src/request-auth.js")>()),
  isAuthorizedRequest: async () => true,
  resolveUserId: async () => "owner@example.test",
}));
const OWNER = "owner@example.test",
  ROOM = `room_${"1".repeat(24)}`,
  DRAFT = `sd_${"2".repeat(32)}`;
async function fixture() {
  const { database, sqlite } = customAgentD1();
  sqlite.exec(
    'CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT,emailVerified INTEGER); CREATE TABLE shiba_auth_account_policy(account_id TEXT PRIMARY KEY,email TEXT); CREATE TABLE "session"(id TEXT PRIMARY KEY,userId TEXT,expiresAt INTEGER)',
  );
  const env = {
      AGENT_AUDIT: database,
      SLACK_INSTALLATIONS_ENABLED: "true",
      SLACK_COWORKER_PRIVATE_STATUS_ENABLED: "true",
      SLACK_OAUTH_APP_ID: "A1",
      SLACK_OAUTH_CLIENT_ID: "1.1",
      SLACK_OAUTH_REDIRECT_URI: "https://shiba.test/api/slack/installations/callback",
      SLACK_OAUTH_PKCE_ENABLED: "true",
      SLACK_OAUTH_QUERY_REDACTION_VERIFIED: "true",
      SLACK_SIGNING_SECRET: "fixture-only",
      SLACK_INSTALLATION_KEYRING: JSON.stringify({
        activeKeyId: "v1",
        keys: { v1: "11".repeat(32) },
      }),
      CodingOrchestrator: {},
      SLACK_BOT_TOKEN: "legacy-never-used",
      INTERNAL_SIGNING_KEY: "fixture-signing-only-012345678901234567",
    } as unknown as Env,
    session = { id: "s1", expiresAt: Date.now() + 600_000 };
  sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run("account", OWNER);
  sqlite.prepare("INSERT INTO shiba_auth_account_policy VALUES(?,?)").run("account", OWNER);
  sqlite
    .prepare('INSERT INTO "session" VALUES(?,?,?)')
    .run(session.id, "account", session.expiresAt);
  const ws = await createTeamWorkspace(env, OWNER, { name: "Team" }),
    member = {
      workspaceId: ws.workspaceId,
      userId: OWNER,
      accountId: "account",
      version: 1,
      role: "owner" as const,
      joinedAt: 1,
    },
    scope = { tenantId: "self-hosted", workspaceId: ws.workspaceId, userId: OWNER };
  await createCollaborationRoom(env, scope, {
    roomId: ROOM,
    title: "Room",
    visibility: "private",
    createdAt: 1,
  });
  const agent = await createCustomAgent(env, `team:${ws.workspaceId}`, "helper", {
    name: "Helper",
    instructions: "Help",
    harness: "opencode",
  });
  await addCollaborationMember(env, scope, ROOM, {
    userId: OWNER,
    actorId: `agent:${agent.id}`,
    kind: "agent",
    profileVersion: 1,
    displayName: "Helper",
    createdAt: 2,
  });
  for (const migration of ["0018_slack_installations.sql", "0024_slack_coworker.sql"])
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  sqlite
    .prepare(
      `INSERT INTO slack_installations(id,workspace_id,owner_id,owner_account_id,owner_member_json,app_id,team_id,bot_user_id,bot_id,installer_slack_user_id,scopes_json,generation,version,token_revision,state,digest,token_cipher,activation_expires_at,created_at) VALUES('i1',?,?,?,?, 'A1','T1','UBOT','B1','UINSTALL','["chat:write","commands","app_mentions:read"]',1,1,1,'active','digest','cipher',?,1)`,
    )
    .run(ws.workspaceId, OWNER, "account", JSON.stringify(member), Date.now() + 600_000);
  const install = installationSnapshot(
    sqlite.prepare("SELECT * FROM slack_installations").get() as unknown as SlackInstallationRow,
  );
  const sealed = await sealSlackSecret(
    env,
    { workspaceId: ws.workspaceId, subject: install.id, purpose: installationPurpose(install) },
    JSON.stringify({ accessToken: "managed-fixture-only", expiresAt: null }),
  );
  sqlite
    .prepare("UPDATE slack_installations SET token_key_id=?,token_cipher=? WHERE id='i1'")
    .run(sealed.keyId, sealed.cipher);
  sqlite
    .prepare(
      "INSERT INTO slack_coworker_bindings(id,workspace_id,account_id,actor_id,member_version,member_role,installation_id,app_id,team_id,generation,slack_user_id,status,created_at) VALUES('b1',?,?,?,1,'owner','i1','A1','T1',1,'U1','active',1)",
    )
    .run(ws.workspaceId, "account", OWNER);
  sqlite
    .prepare(
      "INSERT INTO slack_coworker_intake_grants(id,binding_id,workspace_id,account_id,installation_id,app_id,team_id,generation,channel_id,thread_ts,expires_at,status,created_at) VALUES('g1','b1',?,?,'i1','A1','T1',1,'C1','123.0001',?,'active',1)",
    )
    .run(ws.workspaceId, "account", Date.now() + 600_000);
  sqlite
    .prepare(
      "INSERT INTO slack_coworker_drafts(id,grant_id,workspace_id,account_id,app_id,team_id,channel_id,thread_ts,message_ts,event_id,slack_user_id,text,status,created_at) VALUES(?,'g1',?,?,'A1','T1','C1','123.0001','123.0002','E1','U1','Build it','pending',1)",
    )
    .run(DRAFT, ws.workspaceId, "account");
  state.scope = { ownerAccountId: "account", actorId: OWNER, workspaceId: ws.workspaceId };
  state.grantCurrent = true;
  state.grant = {
    version: 1,
    grantId: `plex_${"3".repeat(32)}`,
    grantVersion: 1,
    ownerAccountId: "account",
    actorId: OWNER,
    workspaceId: ws.workspaceId,
    membershipVersion: 1,
    machineId: "machine",
    machineRevision: 1,
    harness: "codex",
    billingMode: "native-subscription",
    accountFingerprint: "a".repeat(64),
    authVersion: "b".repeat(64),
    codingModel: "openai/gpt-5",
    repoUrl: "https://github.com/example/repo",
    expiresAt: Date.now() + 600_000,
    allowedPhases: ["local_repository_task"],
  };
  sqlite.exec(
    "CREATE TABLE personal_execution_grants(grant_id TEXT,owner_account_id TEXT,workspace_id TEXT,status TEXT,version INTEGER,snapshot_json TEXT,scope_json TEXT,expires_at INTEGER)",
  );
  sqlite
    .prepare("INSERT INTO personal_execution_grants VALUES(?,?,?,'active',1,?,?,?)")
    .run(
      state.grant.grantId,
      "account",
      ws.workspaceId,
      JSON.stringify(state.grant),
      JSON.stringify(state.scope),
      state.grant.expiresAt,
    );
  const req = new Request("https://shiba.test/api/slack/coworker/drafts/submit", {
      headers: {
        Cookie: "fixture",
        Origin: "https://shiba.test",
        "X-Shiba-Workspace": ws.workspaceId,
      },
    }),
    input = {
      requestId: crypto.randomUUID(),
      id: DRAFT,
      roomId: ROOM,
      recipientActorId: `agent:${agent.id}`,
      personalExecution: { grantId: state.grant.grantId, expectedVersion: 1 },
    };
  const preview = await prepareSlackCoworkerSubmission(env, req, member, session, input),
    decision = {
      previewId: preview.previewId,
      digest: preview.digest,
      reviewed: true as const,
      privateStatusConsent: true,
      audienceConsent: "share-my-slack-task-and-results-with-reviewed-room-audience" as const,
    };
  return { env, sqlite, member, session, req, input, preview, decision, agent };
}
async function readyStatus() {
  const f = await fixture();
  expect(f.preview.privateStatus).not.toBeNull();
  const claim = await claimSlackCoworkerSubmission(f.env, f.req, f.member, f.session, f.decision),
    body = (await claim.request.clone().json()) as Record<string, unknown>;
  expect(
    await consumeSlackCoworkerSubmission(
      f.env,
      claim.request,
      body,
      f.member.workspaceId,
      OWNER,
      ROOM,
    ),
  ).toBe(true);
  const scope = { tenantId: "self-hosted", workspaceId: f.member.workspaceId, userId: OWNER },
    executor = `web:${OWNER}:11111111-1111-4111-8111-111111111111`;
  const h = {
    ...scope,
    handoffId: claim.handoffId,
    roomId: ROOM,
    taskId: claim.handoffId,
    senderUserId: OWNER,
    senderActorId: humanActorId(OWNER),
    recipientUserId: OWNER,
    recipientActorId: f.input.recipientActorId,
    parentHandoffId: null,
    rootHandoffId: claim.handoffId,
    depth: 0,
    ancestorHandoffIds: [],
    remainingBudget: 0,
    grantedCapabilities: ["room.read" as const],
    profileVersion: 1,
    status: "active" as const,
    createdAt: 3,
    cancelledAt: null,
  };
  expect(await createRootCollaborationHandoff(f.env, scope, h)).not.toBeNull();
  expect(await pinCollaborationHandoffExecutor(f.env, scope, claim.handoffId, executor)).toBe(true);
  const task = "Help\n\n---\n\nBuild it",
    approvalId = "ap1";
  expect(await bindSlackCoworkerApproval(f.env, claim.handoffId, approvalId, task)).toBe(true);
  expect(
    await linkCollaborationHandoffRun(
      f.env,
      scope,
      claim.handoffId,
      approvalId,
      `agent-tool:${approvalId}`,
    ),
  ).toBe(true);
  await finishSlackCoworkerSubmission(f.env, claim.handoffId, "queued");
  state.approval = {
    approvalId,
    threadKey: executor,
    task,
    repoUrl: "https://github.com/example/repo",
    baseBranch: "main",
    publishPullRequest: false,
    status: "pending",
    createdAt: Date.now(),
    collaborationHandoffId: claim.handoffId,
    customAgentId: f.input.recipientActorId.slice(6),
    customAgentVersion: 1,
    personalExecution: state.grant,
  };
  return { ...f, claim };
}
const auth = () =>
  new Response(
    JSON.stringify({ ok: true, team_id: "T1", user_id: "UBOT", bot_id: "B1", enterprise_id: null }),
    { headers: { "x-oauth-scopes": "chat:write" } },
  );

describe("private Slack status outbox", () => {
  it("creates no status grant when private status consent is absent", async () => {
    const f = await fixture();
    await claimSlackCoworkerSubmission(f.env, f.req, f.member, f.session, {
      ...f.decision,
      privateStatusConsent: false,
    });
    expect(
      await readSlackCoworkerPrivateStatus(f.env, f.member, f.preview.previewId),
    ).toBeUndefined();
  });
  it("posts only the bound private target once under concurrent ticks", async () => {
    const f = await readyStatus(),
      calls: Array<{ url: string; auth: string | null; body: string }> = [];
    const http: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        auth: new Headers(init?.headers).get("Authorization"),
        body: String(init?.body ?? ""),
      });
      return url.endsWith("auth.test") ? auth() : Response.json({ ok: true, message_ts: "1.2" });
    };
    await Promise.all([
      tickSlackCoworkerPrivateStatus(f.env, { fetch: http }),
      tickSlackCoworkerPrivateStatus(f.env, { fetch: http }),
    ]);
    const posts = calls.filter((c) => c.url.endsWith("chat.postEphemeral"));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.auth).toBe("Bearer managed-fixture-only");
    expect(JSON.parse(posts[0]!.body)).toMatchObject({
      channel: "C1",
      user: "U1",
      thread_ts: "123.0001",
    });
    expect(posts[0]!.body).not.toMatch(/Build it|github|plex_|legacy/);
    await tickSlackCoworkerPrivateStatus(f.env, { fetch: http });
    expect(calls.filter((c) => c.url.endsWith("chat.postEphemeral"))).toHaveLength(1);
  });
  it.each(["source", "installation"])(
    "blocks revoked %s during auth.test before posting",
    async (kind) => {
      const f = await readyStatus();
      let posts = 0;
      const http: typeof fetch = async (input) => {
        if (String(input).endsWith("auth.test")) {
          if (kind === "source")
            f.sqlite
              .prepare("UPDATE slack_coworker_drafts SET status='invalidated',text='' WHERE id=?")
              .run(DRAFT);
          else f.sqlite.prepare("UPDATE slack_installations SET generation=generation+1").run();
          return auth();
        }
        posts++;
        return Response.json({ ok: true, message_ts: "1.2" });
      };
      await tickSlackCoworkerPrivateStatus(f.env, { fetch: http });
      expect(posts).toBe(0);
      expect(await readSlackCoworkerPrivateStatus(f.env, f.member, f.preview.previewId)).toBe(
        "blocked",
      );
    },
  );
  it("retains unknown on a lost ephemeral receipt and never retries", async () => {
    const f = await readyStatus();
    let posts = 0;
    const http: typeof fetch = async (input) => {
      if (String(input).endsWith("auth.test")) return auth();
      posts++;
      throw new Error("lost");
    };
    await tickSlackCoworkerPrivateStatus(f.env, { fetch: http });
    expect(posts).toBe(1);
    expect(await readSlackCoworkerPrivateStatus(f.env, f.member, f.preview.previewId)).toBe(
      "unknown",
    );
    f.sqlite.prepare("UPDATE slack_coworker_private_status SET next_check_at=0").run();
    await tickSlackCoworkerPrivateStatus(f.env, { fetch: http });
    expect(posts).toBe(1);
  });
  it("recovers abandoned claims without posting", async () => {
    const f = await readyStatus();
    let posts = 0;
    const http: typeof fetch = async () => {
      posts++;
      throw new Error("must not call Slack");
    };
    f.sqlite
      .prepare(
        "UPDATE slack_coworker_private_status SET delivery_state='sending',claim_id='lost',lease_expires_at=1,next_check_at=0",
      )
      .run();
    await tickSlackCoworkerPrivateStatus(f.env, { fetch: http });
    expect(posts).toBe(0);
    expect(await readSlackCoworkerPrivateStatus(f.env, f.member, f.preview.previewId)).toBe(
      "unknown",
    );
  });
  it.each(["channelId", "slackUserId", "expiresAt"])(
    "rejects changed %s before Slack authentication",
    async (key) => {
      const f = await readyStatus();
      const row = f.sqlite
          .prepare("SELECT target_json FROM slack_coworker_private_status")
          .get() as { target_json: string },
        target = JSON.parse(row.target_json);
      target[key] = key === "expiresAt" ? target.expiresAt + 1 : "OTHER";
      f.sqlite
        .prepare("UPDATE slack_coworker_private_status SET target_json=?")
        .run(JSON.stringify(target));
      let calls = 0;
      await tickSlackCoworkerPrivateStatus(f.env, {
        fetch: async () => {
          calls++;
          throw new Error("unexpected");
        },
      });
      expect(calls).toBe(0);
      expect(await readSlackCoworkerPrivateStatus(f.env, f.member, f.preview.previewId)).toBe(
        "blocked",
      );
    },
  );
  it("expires before delivery and never uses a legacy credential", async () => {
    const f = await readyStatus();
    f.sqlite.prepare("UPDATE slack_coworker_private_status SET expires_at=1,next_check_at=0").run();
    let calls = 0;
    await tickSlackCoworkerPrivateStatus(f.env, {
      fetch: async () => {
        calls++;
        throw new Error("unexpected");
      },
    });
    expect(calls).toBe(0);
    expect(await readSlackCoworkerPrivateStatus(f.env, f.member, f.preview.previewId)).toBe(
      "expired",
    );
  });
  it("retains owner-only revocation metadata while the feature is disabled", async () => {
    const f = await readyStatus();
    f.env.SLACK_COWORKER_PRIVATE_STATUS_ENABLED = "false";
    expect(await revokeSlackCoworkerPrivateStatus(f.env, f.member, f.preview.previewId)).toBe(true);
    expect(await readSlackCoworkerPrivateStatus(f.env, f.member, f.preview.previewId)).toBe(
      "revoked",
    );
    f.sqlite
      .prepare("UPDATE team_workspace_memberships SET status='removed' WHERE user_id=?")
      .run(OWNER);
    expect(
      await readSlackCoworkerPrivateStatus(f.env, f.member, f.preview.previewId),
    ).toBeUndefined();
  });
});
