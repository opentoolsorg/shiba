import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bindCollaborationContextApproval, freezeCollaborationContext,
  isCollaborationApprovalDispatchable, isCollaborationContextCurrent,
  isCollaborationContextQueueable, prepareCollaborationHumanAssignment,
  readCollaborationHumanAssignment,
} from "../src/collaboration-context.js";
import {
  addCollaborationMember, createCollaborationMessage, createCollaborationRoom,
  createRootCollaborationHandoff, humanActorId, linkCollaborationHandoffRun,
  type CollaborationHandoffRow, type CollaborationScope,
} from "../src/collaboration-store.js";
import type { Env } from "../src/env.js";
import {
  beginSlackCoworkerBinding, claimSlackCoworkerExecution, confirmSlackCoworkerBinding,
  confirmSlackCoworkerOnSlack, finishSlackCoworkerExecution, grantSlackCoworkerIntake,
  intakeSlackCoworkerEvent, isSlackCoworkerExecutionCurrent, observeSlackCoworkerChallenge,
  readSlackCoworkerDrafts, revokeSlackCoworkerIntake,
} from "../src/slack-coworker-store.js";
import { installationSnapshot, type SlackInstallationRow } from "../src/slack-installations-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const ROOM = `room_${"2".repeat(24)}`;
const TASK = "Build a local artifact";
const APPROVAL = "approval-slack-context";

async function fixture(slack: boolean, human = false) {
  const { database, sqlite } = customAgentD1();
  const env = { AGENT_AUDIT: database, SLACK_INSTALLATIONS_ENABLED: "true" } as unknown as Env;
  sqlite.exec('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT,emailVerified INTEGER); CREATE TABLE shiba_auth_account_policy(account_id TEXT PRIMARY KEY,email TEXT)');
  for (const migration of ["0018_slack_installations.sql", "0024_slack_coworker.sql"]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const member = { workspaceId: `ws_${"1".repeat(24)}`, userId: "owner@example.test", accountId: "native1", version: 1, role: "owner" as const, joinedAt: 1 };
  sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run(member.accountId, member.userId);
  sqlite.prepare("INSERT INTO shiba_auth_account_policy VALUES(?,?)").run(member.accountId, member.userId);
  sqlite.prepare("INSERT INTO team_workspaces VALUES(?,?,?,?,?)").run("self-hosted", member.workspaceId, "Test", 1, 1);
  sqlite.prepare("INSERT INTO team_workspace_memberships(tenant_id,workspace_id,user_id,role,status,version,joined_at) VALUES('self-hosted',?,?,?,'active',1,1)").run(member.workspaceId, member.userId, member.role);
  sqlite.prepare(`INSERT INTO slack_installations(id,workspace_id,owner_id,owner_account_id,owner_member_json,app_id,team_id,bot_user_id,bot_id,installer_slack_user_id,scopes_json,generation,version,token_revision,state,digest,token_cipher,activation_expires_at,created_at)
    VALUES('i1',?,?,?,?, 'A1','T1','UBOT','B1','UINSTALL','["chat:write","commands","app_mentions:read"]',1,1,1,'active','digest','cipher',?,1)`)
    .run(member.workspaceId, member.userId, member.accountId, JSON.stringify(member), Date.now() + 100_000);
  const installation = installationSnapshot(sqlite.prepare("SELECT * FROM slack_installations").get() as unknown as SlackInstallationRow);
  const challenge = await beginSlackCoworkerBinding(env, member, installation);
  await observeSlackCoworkerChallenge(env, installation, challenge.secret, "U1");
  await confirmSlackCoworkerOnSlack(env, installation, challenge.id, "U1", true);
  const binding = await confirmSlackCoworkerBinding(env, member, installation, challenge.id, "U1");
  const grant = await grantSlackCoworkerIntake(env, member, binding.id, "C1", "123.000001");
  expect(await intakeSlackCoworkerEvent(env, installation, "EEXEC", {
    user: "U1", channel: "C1", thread_ts: "123.000001",
    ts: `${Math.floor(Date.now() / 1000) + 1}.000002`, text: TASK,
  })).toBe(true);
  const drafts = await readSlackCoworkerDrafts(env, member);
  expect(drafts).toHaveLength(1);
  const recipientActorId = human ? humanActorId(member.userId) : "agent:helper";
  const claimed = await claimSlackCoworkerExecution(env, member, {
    id: (drafts[0] as { id: string }).id, roomId: ROOM, recipientActorId,
    personalExecution: { grantId: `plex_${"3".repeat(32)}`, expectedVersion: 1 }, reviewed: true,
  });
  expect(claimed.handoffId).toMatch(/^scx_/);
  const handoffId = slack ? claimed.handoffId : "handoff-non-slack-control";
  const scope: CollaborationScope = { tenantId: "self-hosted", workspaceId: member.workspaceId, userId: member.userId };
  await createCollaborationRoom(env, scope, { roomId: ROOM, title: "Shared artifact", visibility: "shared", createdAt: 1 });
  if (!human) {
    await addCollaborationMember(env, scope, ROOM, {
      userId: member.userId, actorId: recipientActorId, kind: "agent", profileVersion: 1, displayName: "Helper", createdAt: 2,
    });
  }
  expect(await createCollaborationMessage(env, scope, {
    ...scope, messageId: "selected_fact", roomId: ROOM, senderUserId: member.userId,
    senderActorId: humanActorId(member.userId), senderKind: "human", body: "Keep the artifact local.", profileVersion: null, createdAt: 3,
  })).not.toBeNull();
  const contextWrite = human ? await prepareCollaborationHumanAssignment(
    env, scope, ROOM, handoffId, recipientActorId, TASK, ["selected_fact"], [],
  ) : undefined;
  const handoff: CollaborationHandoffRow = {
    ...scope, handoffId, roomId: ROOM, taskId: `task-${handoffId}`, senderUserId: member.userId,
    senderActorId: humanActorId(member.userId), recipientUserId: member.userId, recipientActorId,
    parentHandoffId: null, rootHandoffId: handoffId, depth: 0, ancestorHandoffIds: [], remainingBudget: 0,
    grantedCapabilities: ["room.read"], profileVersion: human ? null : 1, status: "active", createdAt: 4, cancelledAt: null,
  };
  expect(await createRootCollaborationHandoff(env, scope, handoff, contextWrite)).not.toBeNull();
  return { env, sqlite, scope, handoffId, revoke: () => revokeSlackCoworkerIntake(env, member, grant.id) };
}

describe("Slack coworker authority at real collaboration context boundaries", () => {
  it.each([true, false])("rechecks queueability and approved dispatch after intake revocation (Slack: %s)", async (slack) => {
    const f = await fixture(slack);
    const frozen = await freezeCollaborationContext(f.env, f.scope, ROOM, f.handoffId, TASK, ["selected_fact"], []);
    expect(frozen.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(await isSlackCoworkerExecutionCurrent(f.env, f.handoffId, f.scope, ROOM)).toBe(true);
    const queueable = () => isCollaborationContextQueueable(f.env, f.scope, ROOM, f.handoffId, frozen.task);
    expect(await queueable()).toBe(true);
    await bindCollaborationContextApproval(f.env, f.handoffId, APPROVAL, frozen.task);
    await linkCollaborationHandoffRun(f.env, f.scope, f.handoffId, APPROVAL, `agent-tool:${APPROVAL}`);
    if (slack) await finishSlackCoworkerExecution(f.env, f.handoffId, "queued");
    const dispatchable = () => isCollaborationApprovalDispatchable(f.env, {
      handoffId: f.handoffId, approvalId: APPROVAL, employeeId: "helper", employeeVersion: 1, task: frozen.task,
    });
    expect(await isCollaborationContextCurrent(f.env, f.handoffId, frozen.task, APPROVAL)).toBe(true);
    expect(await dispatchable()).toBe(true);

    await f.revoke();

    expect(await queueable()).toBe(!slack);
    expect(await isCollaborationContextCurrent(f.env, f.handoffId, frozen.task, APPROVAL)).toBe(!slack);
    expect(await dispatchable()).toBe(!slack);
  });

  it.each([
    "UPDATE slack_installations SET generation=generation+1",
    "UPDATE slack_installations SET state='revoked'",
    "UPDATE slack_coworker_bindings SET status='revoked'",
    "UPDATE user SET emailVerified=0",
    "UPDATE team_workspace_memberships SET version=version+1",
  ])("fences a frozen Slack approval after authority changes: %s", async sql => {
    const f = await fixture(true);
    const frozen = await freezeCollaborationContext(f.env, f.scope, ROOM, f.handoffId, TASK, ["selected_fact"], []);
    const dispatchable = () => isCollaborationApprovalDispatchable(f.env, {
      handoffId: f.handoffId, approvalId: APPROVAL, employeeId: "helper", employeeVersion: 1, task: frozen.task,
    });
    expect(await dispatchable()).toBe(false);
    await bindCollaborationContextApproval(f.env, f.handoffId, APPROVAL, frozen.task);
    await linkCollaborationHandoffRun(f.env, f.scope, f.handoffId, APPROVAL, `agent-tool:${APPROVAL}`);
    await finishSlackCoworkerExecution(f.env, f.handoffId, "queued");
    expect(await dispatchable()).toBe(true);

    f.sqlite.exec(sql);

    expect(await isCollaborationContextQueueable(f.env, f.scope, ROOM, f.handoffId, frozen.task)).toBe(false);
    expect(await isCollaborationContextCurrent(f.env, f.handoffId, frozen.task, APPROVAL)).toBe(false);
    expect(await dispatchable()).toBe(false);
  });

  it.each([true, false])("withholds a frozen human assignment after intake revocation (Slack: %s)", async (slack) => {
    const f = await fixture(slack, true);
    const assignment = () => readCollaborationHumanAssignment(f.env, f.scope, ROOM, f.handoffId);
    expect(await isSlackCoworkerExecutionCurrent(f.env, f.handoffId, f.scope, ROOM)).toBe(true);
    expect(await isCollaborationContextCurrent(f.env, f.handoffId)).toBe(true);
    const before = await assignment();
    expect(before).toMatchObject({ instructions: TASK, requestedByUserId: f.scope.userId, messageCount: 1, noteCount: 0 });
    expect(before?.task).toContain("Keep the artifact local.");

    await f.revoke();

    expect(await isCollaborationContextCurrent(f.env, f.handoffId)).toBe(!slack);
    expect(await assignment()).toEqual(slack ? null : before);
  });
});
