import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCollaboration } from "../src/collaboration-routes.js";
import {
  CollaborationStoreError,
  getCollaborationRoom,
  listCollaborationHandoffs,
} from "../src/collaboration-store.js";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const authState = vi.hoisted(() => ({ userId: "owner@example.test", authorized: true }));
vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: vi.fn(async () => authState.authorized),
  resolveUserId: vi.fn(async () => authState.userId),
}));

function fixture() {
  const { database, sqlite } = customAgentD1();
  const env = { AGENT_AUDIT: database } as unknown as Env;
  const send = async (path: string, method = "GET", body?: unknown) => {
    const url = `https://worker.test/api/collaboration${path}`;
    return handleCollaboration(
      new Request(url, {
        method,
        headers: {
          "content-type": "application/json",
          ...(method === "GET" ? {} : { origin: "https://worker.test" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  };
  return { env, sqlite, send };
}

async function json<T>(response: Response | null): Promise<T> {
  if (!response) throw new Error("route not handled");
  return (await response.json()) as T;
}

beforeEach(() => {
  authState.userId = "owner@example.test";
  authState.authorized = true;
});

describe("authenticated collaboration rooms", () => {
  it("persists human messages and denies a human session impersonating an agent", async () => {
    const f = fixture();
    const created = await json<{ room: { roomId: string } }>(
      await f.send("/rooms", "POST", { title: "Release planning", visibility: "private" }),
    );
    const roomId = created.room.roomId;
    expect(
      (await f.send(`/rooms/${roomId}/members`, "POST", { userId: "teammate@example.test" }))
        ?.status,
    ).toBe(201);
    const agentResponse = await json<{
      member: { actorId: string; actorKind: string; displayName: string };
    }>(await f.send(`/rooms/${roomId}/agents`, "POST", { label: "Planner" }));
    expect(agentResponse.member.actorKind).toBe("agent");
    expect(agentResponse.member.displayName).toBe("Planner");
    expect(
      (await json<{ rooms: Array<{ roomId: string }> }>(await f.send("/rooms"))).rooms.map(
        (item) => item.roomId,
      ),
    ).toEqual([roomId]);
    expect(
      (await f.send(`/rooms/${roomId}/messages`, "POST", { body: "I will own the rollout." }))
        ?.status,
    ).toBe(201);
    expect(
      (
        await f.send(`/rooms/${roomId}/messages`, "POST", {
          actorId: agentResponse.member.actorId,
          body: "I can prepare the checklist.",
        })
      )?.status,
    ).toBe(403);

    const reloaded = await json<{
      members: Array<{ userId: string; actorKind: string }>;
      messages: Array<{ senderKind: string; body: string }>;
    }>(await f.send(`/rooms/${roomId}`));
    expect(reloaded.members).toHaveLength(3);
    expect(reloaded.messages.map((message) => message.body)).toEqual(["I will own the rollout."]);
    expect(reloaded.messages.map((message) => message.senderKind)).toEqual(["human"]);
    expect(
      f.sqlite.prepare("SELECT COUNT(*) AS count FROM collaboration_messages").get()?.count,
    ).toBe(1);
  });

  it("denies unauthenticated users, nonmembers, and cross-tenant room reads", async () => {
    const f = fixture();
    const room = await json<{ room: { roomId: string } }>(
      await f.send("/rooms", "POST", { title: "Private" }),
    );
    authState.authorized = false;
    expect((await f.send(`/rooms/${room.room.roomId}`))?.status).toBe(401);
    authState.authorized = true;
    authState.userId = "outsider@example.test";
    expect((await f.send(`/rooms/${room.room.roomId}`))?.status).toBe(404);
    const crossTenant = await getCollaborationRoom(
      f.env,
      {
        tenantId: "different-tenant",
        workspaceId: "default",
        userId: authState.userId,
      },
      room.room.roomId,
    );
    expect(crossTenant).toBeNull();
  });

  it("prevents duplicate handoffs and enforces the aggregate child budget", async () => {
    const f = fixture();
    const room = await json<{ room: { roomId: string } }>(
      await f.send("/rooms", "POST", { title: "Task" }),
    );
    const roomId = room.room.roomId;
    const alice = "human:alice@example.test";
    const bob = "human:bob@example.test";
    expect((await f.send(`/rooms/${roomId}/members`, "POST", { userId: "alice@example.test" }))?.status).toBe(201);
    expect((await f.send(`/rooms/${roomId}/members`, "POST", { userId: "bob@example.test" }))?.status).toBe(201);
    const root = {
      handoffId: "handoff-root",
      taskId: "task-17",
      recipientActorId: alice,
      budget: 2,
    };
    expect((await f.send(`/rooms/${roomId}/handoffs`, "POST", root))?.status).toBe(201);
    expect((await f.send(`/rooms/${roomId}/handoffs`, "POST", root))?.status).toBe(409);

    authState.userId = "alice@example.test";
    const child = {
      handoffId: "handoff-child",
      taskId: "task-17",
      recipientActorId: bob,
      parentHandoffId: "handoff-root",
    };
    expect((await f.send(`/rooms/${roomId}/handoffs`, "POST", child))?.status).toBe(201);
    expect((await f.send(`/rooms/${roomId}/handoffs`, "POST", child))?.status).toBe(409);
    expect(
      f.sqlite
        .prepare(
          "SELECT remaining FROM collaboration_handoff_budgets WHERE root_handoff_id='handoff-root'",
        )
        .get()?.remaining,
    ).toBe(1);
    expect(
      (
        await f.send(`/rooms/${roomId}/handoffs`, "POST", {
          ...child,
          handoffId: "handoff-child-two",
          recipientActorId: "human:owner@example.test",
        })
      )?.status,
    ).toBe(201);
    expect(
      (
        await f.send(`/rooms/${roomId}/handoffs`, "POST", {
          ...child,
          handoffId: "handoff-child-three",
        })
      )?.status,
    ).toBe(409);
    authState.userId = "owner@example.test";
    expect(
      await listCollaborationHandoffs(
        f.env,
        { tenantId: "self-hosted", workspaceId: "default", userId: "owner@example.test" },
        roomId,
      ),
    ).toHaveLength(3);
    expect(
      f.sqlite
        .prepare(
          "SELECT remaining FROM collaboration_handoff_budgets WHERE root_handoff_id='handoff-root'",
        )
        .get()?.remaining,
    ).toBe(0);
  });

  it("cancels the whole lineage once authorized at the root and fences later children", async () => {
    const f = fixture();
    const room = await json<{ room: { roomId: string } }>(
      await f.send("/rooms", "POST", { title: "Root cancellation" }),
    );
    const roomId = room.room.roomId;
    for (const userId of [
      "alice@example.test",
      "bob@example.test",
      "carol@example.test",
      "dave@example.test",
    ]) {
      expect((await f.send(`/rooms/${roomId}/members`, "POST", { userId }))?.status).toBe(201);
    }
    const bob = "human:bob@example.test";
    const carol = "human:carol@example.test";
    const dave = "human:dave@example.test";

    authState.userId = "alice@example.test";
    expect(
      (
        await f.send(`/rooms/${roomId}/handoffs`, "POST", {
          handoffId: "alice-to-bob",
          taskId: "task-cascade",
          recipientActorId: bob,
          budget: 3,
        })
      )?.status,
    ).toBe(201);
    authState.userId = "bob@example.test";
    expect(
      (
        await f.send(`/rooms/${roomId}/handoffs`, "POST", {
          handoffId: "bob-to-carol",
          taskId: "task-cascade",
          recipientActorId: carol,
          actorId: bob,
          parentHandoffId: "alice-to-bob",
        })
      )?.status,
    ).toBe(201);
    authState.userId = "carol@example.test";
    expect(
      (
        await f.send(`/rooms/${roomId}/handoffs`, "POST", {
          handoffId: "carol-to-dave",
          taskId: "task-cascade",
          recipientActorId: dave,
          actorId: carol,
          parentHandoffId: "bob-to-carol",
        })
      )?.status,
    ).toBe(201);

    authState.userId = "alice@example.test";
    expect((await f.send("/handoffs/alice-to-bob/cancel", "POST", {}))?.status).toBe(200);
    const rows = await listCollaborationHandoffs(
      f.env,
      { tenantId: "self-hosted", workspaceId: "default", userId: "alice@example.test" },
      roomId,
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.status === "cancelled")).toBe(true);

    authState.userId = "dave@example.test";
    expect(
      (
        await f.send(`/rooms/${roomId}/handoffs`, "POST", {
          handoffId: "dave-after-cancel",
          taskId: "task-cascade",
          recipientActorId: carol,
          actorId: dave,
          parentHandoffId: "carol-to-dave",
        })
      )?.status,
    ).toBe(404);
  });

  it("pins a trusted agent recipient version and denies a human impersonating an agent", async () => {
    const f = fixture();
    const room = await json<{ room: { roomId: string } }>(
      await f.send("/rooms", "POST", { title: "Pinned agent continuation" }),
    );
    const roomId = room.room.roomId;
    const bob = "human:bob@example.test";
    expect(
      (await f.send(`/rooms/${roomId}/members`, "POST", { userId: "bob@example.test" }))?.status,
    ).toBe(201);
    const agent = await json<{ member: { actorId: string } }>(
      await f.send(`/rooms/${roomId}/agents`, "POST", { label: "Reviewer" }),
    );
    expect(
      (
        await f.send(`/rooms/${roomId}/handoffs`, "POST", {
          handoffId: "human-root",
          taskId: "task-agent-version",
          recipientActorId: bob,
          budget: 2,
        })
      )?.status,
    ).toBe(201);
    authState.userId = "bob@example.test";
    expect(
      (
        await f.send(`/rooms/${roomId}/handoffs`, "POST", {
          handoffId: "human-to-agent",
          taskId: "task-agent-version",
          recipientActorId: agent.member.actorId,
          actorId: bob,
          parentHandoffId: "human-root",
          profileVersion: 999,
        })
      )?.status,
    ).toBe(201);
    const saved = f.sqlite
      .prepare(
        "SELECT depth,root_handoff_id,profile_version FROM collaboration_handoffs WHERE handoff_id='human-to-agent'",
      )
      .get();
    expect(saved).toEqual({ depth: 1, root_handoff_id: "human-root", profile_version: 1 });

    f.sqlite
      .prepare("UPDATE collaboration_memberships SET profile_version=2 WHERE actor_id=?")
      .run(agent.member.actorId);
    expect((await f.send(`/rooms/${roomId}/handoffs`, "POST", {
      handoffId: "stale-agent-continuation",
      taskId: "task-agent-version",
      recipientActorId: agent.member.actorId,
      actorId: agent.member.actorId,
      parentHandoffId: "human-to-agent",
    }))?.status).toBe(403);
    authState.userId = "owner@example.test";
    expect((await f.send(`/rooms/${roomId}/handoffs`, "POST", {
      handoffId: "fresh-agent-profile",
      taskId: "task-agent-version-2",
      recipientActorId: agent.member.actorId,
      profileVersion: 999,
      budget: 1,
    }))?.status).toBe(201);
    expect(f.sqlite.prepare("SELECT profile_version FROM collaboration_handoffs WHERE handoff_id='fresh-agent-profile'").get()?.profile_version).toBe(2);
  });

  it("revokes membership and cancels a handoff subtree", async () => {
    const f = fixture();
    const room = await json<{ room: { roomId: string } }>(
      await f.send("/rooms", "POST", { title: "Cancel tree" }),
    );
    const roomId = room.room.roomId;
    const agent = await json<{ member: { actorId: string } }>(
      await f.send(`/rooms/${roomId}/agents`, "POST", {}),
    );
    const teammateId = "human:teammate@example.test";
    expect(
      (await f.send(`/rooms/${roomId}/members`, "POST", { userId: "teammate@example.test" }))
        ?.status,
    ).toBe(201);
    expect(
      (
        await f.send(`/rooms/${roomId}/handoffs`, "POST", {
          handoffId: "cancel-root",
          taskId: "task-18",
          recipientActorId: teammateId,
          budget: 1,
        })
      )?.status,
    ).toBe(201);
    authState.userId = "teammate@example.test";
    expect(
      (
        await f.send(`/rooms/${roomId}/handoffs`, "POST", {
          handoffId: "cancel-child",
          taskId: "task-18",
          recipientActorId: agent.member.actorId,
          parentHandoffId: "cancel-root",
        })
      )?.status,
    ).toBe(201);
    authState.userId = "owner@example.test";
    expect((await f.send(`/handoffs/cancel-root/cancel`, "POST", {}))?.status).toBe(200);
    const rows = await listCollaborationHandoffs(
      f.env,
      { tenantId: "self-hosted", workspaceId: "default", userId: "owner@example.test" },
      roomId,
    );
    expect(rows.every((row) => row.status === "cancelled")).toBe(true);
    expect(
      (await f.send(`/rooms/${roomId}/members/${encodeURIComponent(teammateId)}`, "DELETE"))
        ?.status,
    ).toBe(200);
    authState.userId = "teammate@example.test";
    expect((await f.send(`/rooms/${roomId}`))?.status).toBe(404);
    expect(
      (await f.send(`/rooms/${roomId}/messages`, "POST", { body: "Still here?" }))?.status,
    ).toBe(404);
  });
});

it("fails closed when D1 collaboration storage is absent", async () => {
  await expect(
    getCollaborationRoom(
      { AGENT_AUDIT: undefined } as never,
      {
        tenantId: "self-hosted",
        workspaceId: "default",
        userId: "u",
      },
      "room",
    ),
  ).rejects.toBeInstanceOf(CollaborationStoreError);
});
