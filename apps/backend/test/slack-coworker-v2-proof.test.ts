import { readFileSync } from "node:fs";
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
import { isSlackCoworkerClaimSourceCurrent } from "../src/slack-coworker-store.js";
import {
  prepareSlackCoworkerSubmission,
  claimSlackCoworkerSubmission,
  consumeSlackCoworkerSubmission,
  finishSlackCoworkerSubmission,
  readSlackCoworkerSubmission,
  bindSlackCoworkerApproval,
  isSlackCoworkerV2Current,
} from "../src/slack-coworker-execution.js";
import { handleCollaboration } from "../src/collaboration-routes.js";
import { isCollaborationContextQueueable } from "../src/collaboration-context.js";
import type { Env } from "../src/env.js";
const state = vi.hoisted(() => ({ scope: null as any, grant: null as any, grantCurrent: true }));
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
      audienceConsent: "share-my-slack-task-and-results-with-reviewed-room-audience" as const,
    };
  return { env, sqlite, member, session, req, input, preview, decision };
}
describe("one-shot worker proof", () => {
  it("rejects task/agent/grant tampering, public injection and replay", async () => {
    const f = await fixture(),
      claimed = await claimSlackCoworkerSubmission(f.env, f.req, f.member, f.session, f.decision),
      body = (await claimed.request.clone().json()) as Record<string, unknown>;
    for (const changed of [
      { ...body, task: "other" },
      { ...body, recipientActorId: "agent:other" },
      { ...body, personalExecution: undefined },
      { ...body, personalExecution: { grantId: "other", expectedVersion: 1 } },
    ])
      expect(
        await consumeSlackCoworkerSubmission(
          f.env,
          claimed.request,
          changed,
          f.member.workspaceId,
          OWNER,
          ROOM,
        ),
      ).toBe(false);
    expect(
      await consumeSlackCoworkerSubmission(
        f.env,
        new Request(claimed.request.url, { method: "POST" }),
        body,
        f.member.workspaceId,
        OWNER,
        ROOM,
      ),
    ).toBe(false);
    expect(
      await consumeSlackCoworkerSubmission(
        f.env,
        claimed.request,
        body,
        f.member.workspaceId,
        OWNER,
        ROOM,
      ),
    ).toBe(true);
    expect(
      await consumeSlackCoworkerSubmission(
        f.env,
        claimed.request,
        body,
        f.member.workspaceId,
        OWNER,
        ROOM,
      ),
    ).toBe(false);
    await finishSlackCoworkerSubmission(f.env, claimed.handoffId, "unknown");
    await expect(
      claimSlackCoworkerSubmission(f.env, f.req, f.member, f.session, f.decision),
    ).rejects.toThrow();
    expect(
      (await readSlackCoworkerSubmission(f.env, f.member, f.session, DRAFT)).receipt,
    ).toMatchObject({ state: "unknown" });
  });
  it("rejects expired actual sessions, source changes and revoked personal grant", async () => {
    const f = await fixture();
    f.sqlite.prepare('UPDATE "session" SET expiresAt=1').run();
    await expect(
      claimSlackCoworkerSubmission(f.env, f.req, f.member, f.session, f.decision),
    ).rejects.toThrow();
    f.sqlite.prepare('UPDATE "session" SET expiresAt=?').run(f.session.expiresAt);
    state.grantCurrent = false;
    await expect(
      claimSlackCoworkerSubmission(f.env, f.req, f.member, f.session, f.decision),
    ).rejects.toThrow();
    state.grantCurrent = true;
    f.sqlite
      .prepare("UPDATE slack_coworker_drafts SET status='invalidated',text='' WHERE id=?")
      .run(DRAFT);
    await expect(
      claimSlackCoworkerSubmission(f.env, f.req, f.member, f.session, f.decision),
    ).rejects.toThrow();
  });
  it("blocks a public reserved handoff and a tampered Worker request before room reservation", async () => {
    const f = await fixture(),
      claimed = await claimSlackCoworkerSubmission(f.env, f.req, f.member, f.session, f.decision),
      body = (await claimed.request.clone().json()) as Record<string, unknown>;
    const send = (headers: Headers, changed: Record<string, unknown>) =>
      handleCollaboration(
        new Request(claimed.request.url, {
          method: "POST",
          headers,
          body: JSON.stringify(changed),
        }),
        f.env,
      );
    const publicHeaders = new Headers(claimed.request.headers);
    publicHeaders.delete("X-Shiba-Coworker-Proof");
    expect((await send(publicHeaders, body))?.status).toBe(403);
    expect((await send(claimed.request.headers, { ...body, task: "different" }))?.status).toBe(403);
    expect(
      f.sqlite.prepare("SELECT count(*) AS n FROM collaboration_handoffs").get(),
    ).toMatchObject({ n: 0 });
    expect(
      await consumeSlackCoworkerSubmission(
        f.env,
        claimed.request,
        body,
        f.member.workspaceId,
        OWNER,
        ROOM,
      ),
    ).toBe(true);
  });
  it("requires exact canonical approval task and completed queue before dispatch", async () => {
    const f = await fixture(),
      claimed = await claimSlackCoworkerSubmission(f.env, f.req, f.member, f.session, f.decision),
      body = (await claimed.request.clone().json()) as Record<string, unknown>;
    expect(
      await consumeSlackCoworkerSubmission(
        f.env,
        claimed.request,
        body,
        f.member.workspaceId,
        OWNER,
        ROOM,
      ),
    ).toBe(true);
    const scope = { tenantId: "self-hosted", workspaceId: f.member.workspaceId, userId: OWNER };
    const handoff = {
      ...scope,
      handoffId: claimed.handoffId,
      roomId: ROOM,
      taskId: claimed.handoffId,
      senderUserId: OWNER,
      senderActorId: humanActorId(OWNER),
      recipientUserId: OWNER,
      recipientActorId: f.input.recipientActorId,
      parentHandoffId: null,
      rootHandoffId: claimed.handoffId,
      depth: 0,
      ancestorHandoffIds: [],
      remainingBudget: 0,
      grantedCapabilities: ["room.read" as const],
      profileVersion: 1,
      status: "active" as const,
      createdAt: 3,
      cancelledAt: null,
    };
    expect(await createRootCollaborationHandoff(f.env, scope, handoff)).not.toBeNull();
    expect(
      await isSlackCoworkerV2Current(
        f.env,
        claimed.handoffId,
        scope,
        ROOM,
        "Build it",
        undefined,
        state.grant,
      ),
    ).toBe(true);
    expect(
      await isSlackCoworkerV2Current(
        f.env,
        claimed.handoffId,
        scope,
        ROOM,
        "Build it",
        undefined,
        null,
      ),
    ).toBe(false);
    expect(
      await isSlackCoworkerV2Current(f.env, claimed.handoffId, scope, ROOM, "Build it", undefined, {
        ...state.grant,
        machineId: "other",
      }),
    ).toBe(false);
    expect(
      await isCollaborationContextQueueable(
        f.env,
        scope,
        ROOM,
        claimed.handoffId,
        "Build it",
        state.grant,
      ),
    ).toBe(true);
    expect(
      await isCollaborationContextQueueable(f.env, scope, ROOM, claimed.handoffId, "Build it"),
    ).toBe(false);
    expect(
      await isCollaborationContextQueueable(f.env, scope, ROOM, claimed.handoffId, "Build it", {
        ...state.grant,
        machineId: "other",
      }),
    ).toBe(false);
    expect(await bindSlackCoworkerApproval(f.env, claimed.handoffId, "ap1", "extra Build it")).toBe(
      false,
    );
    const task = "Help\n\n---\n\nBuild it";
    expect(await bindSlackCoworkerApproval(f.env, claimed.handoffId, "ap1", task)).toBe(true);
    expect(
      await linkCollaborationHandoffRun(f.env, scope, claimed.handoffId, "ap1", "agent-tool:ap1"),
    ).toBe(true);
    expect(await isSlackCoworkerV2Current(f.env, claimed.handoffId, scope, ROOM, task, "ap1")).toBe(
      false,
    );
    await finishSlackCoworkerSubmission(f.env, claimed.handoffId, "queued");
    expect(await isSlackCoworkerV2Current(f.env, claimed.handoffId, scope, ROOM, task, "ap1")).toBe(
      true,
    );
    const proof = { handoffId: claimed.handoffId, approvalId: "ap1", snapshot: state.grant };
    expect(await isSlackCoworkerClaimSourceCurrent(f.env, proof, task)).toBe(true);
    expect(
      await isSlackCoworkerV2Current(
        f.env,
        claimed.handoffId,
        scope,
        ROOM,
        task,
        "ap1",
        state.grant,
      ),
    ).toBe(true);
    expect(
      await isSlackCoworkerV2Current(f.env, claimed.handoffId, scope, ROOM, task, "ap1", {
        ...state.grant,
        grantVersion: 2,
      }),
    ).toBe(false);
    expect(
      await isSlackCoworkerV2Current(f.env, claimed.handoffId, scope, ROOM, "altered", "ap1"),
    ).toBe(false);
    f.sqlite
      .prepare("UPDATE org_custom_agents SET version=version+1 WHERE id=?")
      .run(f.input.recipientActorId.slice(6));
    expect(
      await isSlackCoworkerV2Current(
        f.env,
        claimed.handoffId,
        scope,
        ROOM,
        task,
        "ap1",
        state.grant,
      ),
    ).toBe(false);
    expect(await isSlackCoworkerClaimSourceCurrent(f.env, proof, task)).toBe(false);
  });
  it("recovers an expired unconfirmed submission as unknown without replay", async () => {
    const f = await fixture(),
      claimed = await claimSlackCoworkerSubmission(f.env, f.req, f.member, f.session, f.decision);
    f.sqlite
      .prepare("UPDATE slack_coworker_execution_v2 SET expires_at=1 WHERE id=?")
      .run(f.preview.previewId);
    expect(
      (await readSlackCoworkerSubmission(f.env, f.member, f.session, DRAFT)).receipt,
    ).toMatchObject({ handoffId: claimed.handoffId, state: "unknown" });
    await expect(
      claimSlackCoworkerSubmission(f.env, f.req, f.member, f.session, f.decision),
    ).rejects.toThrow();
  });
});
