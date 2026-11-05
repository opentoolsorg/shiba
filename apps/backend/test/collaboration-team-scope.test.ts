import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCollaboration } from "../src/collaboration-routes.js";
import { queueCollaborationRun } from "../src/runs-routes.js";
import {
  addCollaborationMember,
  collaborationEmployeeOrgId,
  createCollaborationMessage,
  getCollaborationRoom,
  getCollaborationHandoff,
  getActiveCollaborationMembership,
  ingestCollaborationSlackMessage,
  isCollaborationHandoffDispatchable,
  linkCollaborationHandoffRun,
  listCollaborationRooms,
  listCollaborationSlackSources,
  observeCollaborationSlackThread,
  type CollaborationScope,
} from "../src/collaboration-store.js";
import { isCollaborationContextCurrent } from "../src/collaboration-context.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import type { Env } from "../src/env.js";
import {
  acceptTeamWorkspaceInvitation,
  changeTeamWorkspaceMember,
  createTeamWorkspace,
  createTeamWorkspaceInvitation,
} from "../src/team-workspaces-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const state = vi.hoisted(() => ({ userId: "owner@example.test", authorized: true }));
vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: vi.fn(async () => state.authorized),
  resolveUserId: vi.fn(async () => state.userId),
}));
vi.mock("../src/runs-routes.js", () => ({
  queueCollaborationRun: vi.fn(
    async (_request: Request, _env: Env, input: { commandId: string; task: string }) =>
      Response.json({ approvalId: `approval-${input.commandId}`, task: input.task }),
  ),
}));
vi.mock("agents/routing", () => ({
  getAgentByName: vi.fn(async () => ({
    fetch: async () => Response.json({ approvals: [], decided: [] }),
  })),
}));

beforeEach(() => {
  state.userId = "owner@example.test";
  state.authorized = true;
});
async function fixture() {
  const { database, sqlite } = customAgentD1();
  const env = { AGENT_AUDIT: database } as unknown as Env;
  const workspace = await createTeamWorkspace(env, state.userId, { name: "Product team" });
  const invitation = await createTeamWorkspaceInvitation(env, workspace.workspaceId, state.userId, {
    email: "member@example.test",
    role: "member",
  });
  await acceptTeamWorkspaceInvitation(env, "member@example.test", invitation.token);
  const scope: CollaborationScope = {
    tenantId: "self-hosted",
    workspaceId: workspace.workspaceId,
    userId: state.userId,
  };
  const send = (
    path: string,
    method = "GET",
    body?: unknown,
    selected: string | undefined = workspace.workspaceId,
  ) =>
    handleCollaboration(
      new Request(`https://worker.test/api/collaboration${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(method === "GET" ? {} : { Origin: "https://worker.test" }),
          ...(selected ? { "X-Shiba-Workspace": selected } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  const createRoom = async (title = "Release team", selected = workspace.workspaceId) => {
    const response = await send("/rooms", "POST", { title, visibility: "shared" }, selected);
    expect(response?.status).toBe(201);
    if (!response) throw new Error("Room route was not handled");
    return ((await response.json()) as { room: { roomId: string } }).room.roomId;
  };
  return { env, sqlite, workspace, scope, send, createRoom };
}

async function body(response: Response | null): Promise<Record<string, any>> {
  expect(response).not.toBeNull();
  if (!response) throw new Error("Collaboration route was not handled");
  return response.json() as Promise<Record<string, any>>;
}

async function addEmployee(f: Awaited<ReturnType<typeof fixture>>, roomId: string) {
  const profile = await createCustomAgent(f.env, collaborationEmployeeOrgId(f.scope), "writer", {
    name: "Team Writer",
    instructions: "Draft a reviewed summary.",
    harness: "opencode",
    defaultRepoUrl: "https://github.com/example/repo",
  });
  expect(
    (
      await f.send(`/rooms/${roomId}/agents`, "POST", {
        profileId: profile.id,
        profileVersion: profile.version,
      })
    )?.status,
  ).toBe(201);
  return profile;
}

async function requestEmployee(
  f: Awaited<ReturnType<typeof fixture>>,
  roomId: string,
  handoffId: string,
) {
  const profile = await addEmployee(f, roomId);
  const response = await f.send(`/rooms/${roomId}/handoffs`, "POST", {
    handoffId,
    taskId: "release-summary",
    recipientActorId: `agent:${profile.id}`,
    task: "Write the release summary.",
  });
  expect(response?.status).toBe(201);
  return { profile, handoff: (await body(response)).handoff };
}

describe("explicit team collaboration scope", () => {
  it("does not treat deployment operator pairing as a team local artifact grant", async () => {
    const f = await fixture();
    const roomId = await f.createRoom();
    const profile = await addEmployee(f, roomId);
    vi.mocked(queueCollaborationRun).mockClear();
    const response = await f.send(`/rooms/${roomId}/handoffs`, "POST", {
      handoffId: "team-local-artifact", taskId: "team-artifact",
      recipientActorId: `agent:${profile.id}`, task: "Draft a local brief.",
      runtime: "local", targetMachineId: "operator-computer",
      executionTarget: { kind: "artifact-workspace", expectedDeliverables: ["brief.md"] },
    });
    expect(response?.status).toBe(403);
    expect(await body(response)).toMatchObject({ error: expect.stringContaining("Operator pairing does not authorize") });
    expect(queueCollaborationRun).not.toHaveBeenCalled();
    expect((await getCollaborationHandoff(f.env, f.scope, "team-local-artifact"))?.status).toBe("cancelled");
  });

  it("keeps personal rooms separate while two current workspace members share attributed messages and notes", async () => {
    const f = await fixture();
    const roomId = await f.createRoom();
    const invited = await body(
      await f.send(`/rooms/${roomId}/members`, "POST", { userId: "member@example.test" }),
    );
    expect(invited.member.workspaceId).toBe(f.workspace.workspaceId);
    expect(invited.member.role).toBe("member");
    state.userId = "member@example.test";
    expect(
      (await f.send(`/rooms/${roomId}/messages`, "POST", { body: "The team approved the draft." }))
        ?.status,
    ).toBe(201);
    expect(
      (
        await f.send(`/rooms/${roomId}/memory`, "POST", {
          id: "ctx_shared",
          title: "Team decision",
          content: "Review before release.",
        })
      )?.status,
    ).toBe(201);
    const loaded = await body(await f.send(`/rooms/${roomId}`));
    expect(loaded.messages[0].senderUserId).toBe("member@example.test");
    expect(loaded.memory[0].createdByUserId).toBe("member@example.test");
    expect(
      (await f.send(`/rooms/${roomId}/members`, "POST", { userId: "outsider@example.test" }))
        ?.status,
    ).toBe(403);
    expect(
      (
        await f.send(`/rooms/${roomId}/handoffs`, "POST", {
          handoffId: "human-team-handoff",
          taskId: "review",
          recipientActorId: "human:owner@example.test",
        })
      )?.status,
    ).toBe(201);
    const handoff = f.sqlite
      .prepare(
        "SELECT workspace_id,recipient_user_id FROM collaboration_handoffs WHERE handoff_id='human-team-handoff'",
      )
      .get();
    expect(handoff).toMatchObject({
      workspace_id: f.workspace.workspaceId,
      recipient_user_id: "owner@example.test",
    });
    expect((await body(await f.send("/rooms", "GET", undefined, "default"))).rooms).toEqual([]);
    expect((await f.send(`/rooms/${roomId}`, "GET", undefined, "default"))?.status).toBe(404);
    expect((await f.send("/rooms", "POST", { title: "Private personal" }, "default"))?.status).toBe(
      201,
    );
    expect(
      (await body(await f.send("/rooms"))).rooms.map((item: { roomId: string }) => item.roomId),
    ).toEqual([roomId]);
  });

  it("denies an outsider selecting the workspace or using their own workspace room as a bridge", async () => {
    const f = await fixture();
    const roomId = await f.createRoom();
    expect(
      (await f.send(`/rooms/${roomId}/members`, "POST", { userId: "outsider@example.test" }))
        ?.status,
    ).toBe(403);
    expect(
      f.sqlite
        .prepare("SELECT 1 FROM collaboration_memberships WHERE user_id='outsider@example.test'")
        .get(),
    ).toBeUndefined();
    state.userId = "outsider@example.test";
    expect((await f.send("/rooms"))?.status).toBe(404);
    expect((await f.send("/rooms", "POST", { title: "Guessed team" }))?.status).toBe(404);
    const own = await createTeamWorkspace(f.env, state.userId, { name: "Outsider team" });
    await f.createRoom("Outsider room", own.workspaceId);
    expect((await f.send(`/rooms/${roomId}`, "GET", undefined, own.workspaceId))?.status).toBe(404);
    expect(
      (await f.send(`/rooms/${roomId}/memory`, "GET", undefined, own.workspaceId))?.status,
    ).toBe(404);
    expect(
      (
        await f.send(
          `/rooms/${roomId}/messages`,
          "POST",
          { body: "Cross-team injection" },
          own.workspaceId,
        )
      )?.status,
    ).toBe(404);
    expect(
      (
        await f.send(
          `/rooms/${roomId}/members`,
          "POST",
          { userId: "outsider@example.test" },
          own.workspaceId,
        )
      )?.status,
    ).toBe(404);
  });

  it("uses team employee profile versions and never imports a personal profile into the team", async () => {
    const f = await fixture();
    const roomId = await f.createRoom();
    const personal = await createCustomAgent(f.env, "self-hosted", "private", {
      name: "Private employee",
      instructions: "Private instructions",
      harness: "opencode",
    });
    expect(
      (
        await f.send(`/rooms/${roomId}/agents`, "POST", {
          profileId: personal.id,
          profileVersion: personal.version,
        })
      )?.status,
    ).toBe(404);
    const profile = await addEmployee(f, roomId);
    const member = await getActiveCollaborationMembership(
      f.env,
      f.scope,
      roomId,
      `agent:${profile.id}`,
    );
    expect(member).toMatchObject({
      workspaceId: f.workspace.workspaceId,
      userId: "owner@example.test",
      role: "agent",
      profileVersion: profile.version,
    });
    expect(collaborationEmployeeOrgId(f.scope)).toBe(`team:${f.workspace.workspaceId}`);
    expect(collaborationEmployeeOrgId({ workspaceId: "default" })).toBe("self-hosted");
  });

  it("rechecks workspace removal for rooms, messages, notes, cancellation and existing pending approvals", async () => {
    const f = await fixture();
    const roomId = await f.createRoom();
    await f.send(`/rooms/${roomId}/members`, "POST", { userId: "member@example.test" });
    state.userId = "member@example.test";
    const secondRoom = await f.createRoom("Member's shared room");
    const { profile, handoff } = await requestEmployee(f, secondRoom, "remove-member-task");
    expect(
      await isCollaborationHandoffDispatchable(f.env, {
        handoffId: handoff.handoffId,
        approvalId: handoff.approvalId,
        employeeId: profile.id,
        employeeVersion: profile.version,
      }),
    ).toBe(true);
    await changeTeamWorkspaceMember(
      f.env,
      f.workspace.workspaceId,
      "owner@example.test",
      state.userId,
      { remove: true, expectedVersion: 1 },
    );
    expect((await f.send(`/rooms/${roomId}`))?.status).toBe(404);
    expect(
      (await f.send(`/rooms/${secondRoom}/messages`, "POST", { body: "Must not persist" }))?.status,
    ).toBe(404);
    expect((await f.send(`/rooms/${secondRoom}/memory`))?.status).toBe(404);
    expect((await f.send(`/handoffs/${handoff.handoffId}/cancel`, "POST", {}))?.status).toBe(404);
    expect(
      await isCollaborationHandoffDispatchable(f.env, {
        handoffId: handoff.handoffId,
        approvalId: handoff.approvalId,
        employeeId: profile.id,
        employeeVersion: profile.version,
      }),
    ).toBe(false);
    expect(await isCollaborationContextCurrent(f.env, handoff.handoffId)).toBe(false);
    expect(
      f.sqlite
        .prepare("SELECT status FROM collaboration_handoffs WHERE handoff_id=?")
        .get(handoff.handoffId)?.status,
    ).toBe("cancelled");
  });

  it("fails closed inside store statements even if a stale room grant survives an interrupted revocation", async () => {
    const f = await fixture();
    const roomId = await f.createRoom();
    const { profile, handoff } = await requestEmployee(f, roomId, "stale-team-grant");
    // Inject partial legacy/migration state: workspace grant removed, room grant still active.
    f.sqlite
      .prepare(
        "UPDATE team_workspace_memberships SET status='removed' WHERE workspace_id=? AND user_id=?",
      )
      .run(f.workspace.workspaceId, state.userId);
    expect(
      f.sqlite
        .prepare(
          "SELECT status FROM collaboration_memberships WHERE room_id=? AND actor_kind='human'",
        )
        .get(roomId)?.status,
    ).toBe("active");
    expect(await getCollaborationRoom(f.env, f.scope, roomId)).toBeNull();
    expect(await listCollaborationRooms(f.env, f.scope)).toEqual([]);
    expect(
      await getActiveCollaborationMembership(f.env, f.scope, roomId, `agent:${profile.id}`),
    ).toBeNull();
    expect(
      await createCollaborationMessage(f.env, f.scope, {
        messageId: "rejected-stale-write",
        tenantId: f.scope.tenantId,
        workspaceId: f.scope.workspaceId,
        roomId,
        senderUserId: state.userId,
        senderActorId: `human:${state.userId}`,
        senderKind: "human",
        body: "Do not save",
        profileVersion: null,
        createdAt: 10,
      }),
    ).toBeNull();
    expect(
      await addCollaborationMember(f.env, f.scope, roomId, {
        userId: "member@example.test",
        displayName: "Member",
        actorId: "human:member@example.test",
        kind: "human",
        createdAt: 10,
      }),
    ).toBe(false);
    expect(
      await linkCollaborationHandoffRun(
        f.env,
        f.scope,
        handoff.handoffId,
        handoff.approvalId,
        handoff.runId,
      ),
    ).toBe(false);
    expect(
      await isCollaborationHandoffDispatchable(f.env, {
        handoffId: handoff.handoffId,
        approvalId: handoff.approvalId,
        employeeId: profile.id,
        employeeVersion: profile.version,
      }),
    ).toBe(false);
    expect(
      f.sqlite
        .prepare("SELECT 1 FROM collaboration_messages WHERE message_id='rejected-stale-write'")
        .get(),
    ).toBeUndefined();
  });

  it("does not reuse a handoff identity across workspaces or import a source from another room", async () => {
    const f = await fixture();
    const roomId = await f.createRoom();
    await f.send(`/rooms/${roomId}/members`, "POST", { userId: "member@example.test" });
    expect(
      (
        await f.send(`/rooms/${roomId}/handoffs`, "POST", {
          handoffId: "global-team-task",
          taskId: "review",
          recipientActorId: "human:member@example.test",
        })
      )?.status,
    ).toBe(201);
    const second = await createTeamWorkspace(f.env, state.userId, { name: "Second team" });
    const secondRoom = await f.createRoom("Separate team", second.workspaceId);
    const invite = await createTeamWorkspaceInvitation(f.env, second.workspaceId, state.userId, {
      email: "member@example.test",
      role: "member",
    });
    await acceptTeamWorkspaceInvitation(f.env, "member@example.test", invite.token);
    await f.send(
      `/rooms/${secondRoom}/members`,
      "POST",
      { userId: "member@example.test" },
      second.workspaceId,
    );
    expect(
      (
        await f.send(
          `/rooms/${secondRoom}/handoffs`,
          "POST",
          {
            handoffId: "global-team-task",
            taskId: "review",
            recipientActorId: "human:member@example.test",
          },
          second.workspaceId,
        )
      )?.status,
    ).toBe(409);
    expect(
      f.sqlite
        .prepare(
          "SELECT COUNT(*) count FROM collaboration_handoffs WHERE handoff_id='global-team-task'",
        )
        .get()?.count,
    ).toBe(1);
    const note = (
      await body(
        await f.send(`/rooms/${roomId}/memory`, "POST", {
          id: "ctx_room_a",
          title: "Room A",
          content: "Room A only",
        }),
      )
    ).memory;
    const roomB = await f.createRoom("Different source audience");
    const profile = await addEmployee(f, roomB);
    expect(
      (
        await f.send(`/rooms/${roomB}/handoffs`, "POST", {
          handoffId: "wrong-room-context",
          taskId: "review",
          recipientActorId: `agent:${profile.id}`,
          task: "Summarize",
          memoryRefs: [{ id: note.id, version: note.version, sha256: note.sha256 }],
        })
      )?.status,
    ).toBe(409);
    expect(
      f.sqlite
        .prepare(
          "SELECT COUNT(*) count FROM collaboration_context_snapshots WHERE handoff_id='wrong-room-context'",
        )
        .get()?.count,
    ).toBe(0);
  });

  it("bridges only the exact configured Slack source into an authorized team room and stops after owner removal", async () => {
    const f = await fixture();
    f.env.SLACK_CANVAS_OWNERS = JSON.stringify([
      {
        teamId: "TTEAM",
        channelId: "CPRIVATE",
        ownerId: "owner@example.test",
        viewerIds: ["member@example.test"],
      },
    ]);
    const roomId = await f.createRoom();
    await f.send(`/rooms/${roomId}/members`, "POST", { userId: "member@example.test" });
    await observeCollaborationSlackThread(f.env, {
      teamId: "TTEAM",
      channelId: "CPRIVATE",
      threadTs: "100.001",
      eventId: "seen",
      userId: "UOWNER",
      seenAt: 1,
    });
    expect(await listCollaborationSlackSources(f.env, f.scope, roomId)).toHaveLength(1);
    expect(
      (
        await f.send(`/rooms/${roomId}/slack-links`, "POST", {
          teamId: "TTEAM",
          channelId: "CPRIVATE",
          threadTs: "100.001",
        })
      )?.status,
    ).toBe(201);
    expect(
      await ingestCollaborationSlackMessage(f.env, {
        eventId: "event-1",
        teamId: "TTEAM",
        channelId: "CPRIVATE",
        threadTs: "100.001",
        userId: "UOWNER",
        text: "An attributed source update",
        createdAt: 2,
      }),
    ).toBe(true);
    state.userId = "member@example.test";
    expect((await body(await f.send(`/rooms/${roomId}`))).messages[0]).toMatchObject({
      body: "An attributed source update",
      sourceSlackEventId: "event-1",
    });
    state.userId = "outsider@example.test";
    const own = await createTeamWorkspace(f.env, state.userId, { name: "Outsider" });
    const ownRoom = await f.createRoom("Guessed source target", own.workspaceId);
    expect(
      (await body(await f.send(`/rooms/${ownRoom}`, "GET", undefined, own.workspaceId)))
        .slackSources,
    ).toEqual([]);
    expect(
      (
        await f.send(
          `/rooms/${ownRoom}/slack-links`,
          "POST",
          { teamId: "TTEAM", channelId: "CPRIVATE", threadTs: "100.001" },
          own.workspaceId,
        )
      )?.status,
    ).toBe(409);
    f.sqlite
      .prepare(
        "UPDATE team_workspace_memberships SET status='removed' WHERE workspace_id=? AND user_id='owner@example.test'",
      )
      .run(f.workspace.workspaceId);
    expect(
      await ingestCollaborationSlackMessage(f.env, {
        eventId: "event-2",
        teamId: "TTEAM",
        channelId: "CPRIVATE",
        threadTs: "100.001",
        userId: "UOWNER",
        text: "Must not import",
        createdAt: 3,
      }),
    ).toBe(false);
    expect(
      f.sqlite
        .prepare("SELECT 1 FROM collaboration_messages WHERE source_slack_event_id='event-2'")
        .get(),
    ).toBeUndefined();
  });
});

describe("team collaboration write and dispatch races", () => {
  it("refuses a target member removed after the invitation precheck but before the conditional write", async () => {
    const f = await fixture();
    const roomId = await f.createRoom();
    const prepare = f.env.AGENT_AUDIT.prepare.bind(f.env.AGENT_AUDIT);
    let injected = false;
    f.env.AGENT_AUDIT.prepare = (sql: string) => {
      // Preserve the complete D1 statement/prototype; intercept only the write under test.
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
        get(target, property, receiver) {
          if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
          if (property === "run") return async <T>() => {
            if (!injected && sql.startsWith("INSERT INTO collaboration_memberships")) {
              injected = true;
              f.sqlite.prepare(
                "UPDATE team_workspace_memberships SET status='removed' WHERE workspace_id=? AND user_id='member@example.test'",
              ).run(f.workspace.workspaceId);
            }
            return target.run<T>();
          };
          return Reflect.get(target, property, receiver);
        },
      });
      return wrap(prepare(sql));
    };
    const added = await addCollaborationMember(f.env, f.scope, roomId, {
      userId: "member@example.test",
      displayName: "Member",
      actorId: "human:member@example.test",
      kind: "human",
      createdAt: 10,
    });
    expect(injected).toBe(true);
    expect(added).toBe(false);
    expect(
      f.sqlite
        .prepare(
          "SELECT 1 FROM collaboration_memberships WHERE room_id=? AND user_id='member@example.test'",
        )
        .get(roomId),
    ).toBeUndefined();
  });

  it("rejects ambiguous legacy handoff identities rather than dispatching the first workspace match", async () => {
    const f = await fixture();
    const roomId = await f.createRoom();
    const { profile, handoff } = await requestEmployee(f, roomId, "legacy-duplicate-identity");
    const legacyRoom = await f.createRoom("Legacy personal room", "default");
    f.sqlite.prepare(`INSERT OR IGNORE INTO collaboration_memberships (tenant_id,workspace_id,room_id,user_id,display_name,actor_id,actor_kind,role,status,capabilities_json,profile_version,created_at,removed_at)
      SELECT tenant_id,'default',?,user_id,display_name,actor_id,actor_kind,role,status,capabilities_json,profile_version,created_at,removed_at FROM collaboration_memberships WHERE room_id=?`).run(legacyRoom, roomId);
    f.sqlite
      .prepare(`INSERT INTO collaboration_handoffs (handoff_id,tenant_id,workspace_id,room_id,task_id,sender_user_id,sender_actor_id,recipient_user_id,recipient_actor_id,parent_handoff_id,root_handoff_id,depth,ancestor_handoff_ids_json,remaining_budget,granted_capabilities_json,profile_version,status,created_at,cancelled_at,approval_id,run_id,executor_agent_name)
      SELECT handoff_id,tenant_id,'default',?,task_id,sender_user_id,sender_actor_id,recipient_user_id,recipient_actor_id,parent_handoff_id,root_handoff_id,depth,ancestor_handoff_ids_json,remaining_budget,granted_capabilities_json,profile_version,status,created_at,cancelled_at,approval_id,run_id,executor_agent_name FROM collaboration_handoffs WHERE handoff_id=?`)
      .run(legacyRoom, handoff.handoffId);
    expect(await getCollaborationHandoff(f.env, f.scope, handoff.handoffId)).toBeNull();
    expect(
      await isCollaborationHandoffDispatchable(f.env, {
        handoffId: handoff.handoffId,
        approvalId: handoff.approvalId,
        employeeId: profile.id,
        employeeVersion: profile.version,
      }),
    ).toBe(false);
  });
});
