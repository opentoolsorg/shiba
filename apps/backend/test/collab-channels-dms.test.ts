import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChannel, joinChannel, leaveChannel } from "../src/collaboration-v2-store.js";
import { COLLAB_TENANT_ID, COLLAB_WORKSPACE_ID, ensureCollaborationSchema } from "../src/collaboration-store.js";
import { canReadCollaborationRoom } from "../src/collaboration-room-access.js";
import { handleCollaboration } from "../src/collaboration-routes.js";
import type { Env } from "../src/env.js";
import { applyCollabV2Migrations } from "./fixtures/collab-v2-migrations.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const authState = vi.hoisted(() => ({ userId: "owner@example.test", authorized: true }));
vi.mock("../src/request-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/request-auth.js")>(),
  resolveRequestIdentity: async () => ({ authorized: authState.authorized, userId: authState.userId }), isAuthorizedRequest: vi.fn(async () => authState.authorized),
  resolveUserId: vi.fn(async () => authState.userId),
}));

function fixture() {
  const { database, sqlite } = customAgentD1();
  const env = { AGENT_AUDIT: database } as unknown as Env;
  const send = async (path: string, method = "GET", body?: unknown) => {
    await ensureCollaborationSchema(env);
    applyCollabV2Migrations(sqlite);
    return handleCollaboration(
      new Request(`https://worker.test/api/collaboration${path}`, {
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

beforeEach(() => {
  authState.userId = "owner@example.test";
  authState.authorized = true;
});

describe("collab v2 channels and dms", () => {
  it("creates a public channel, lists it, and supports join/leave", async () => {
    const f = fixture();
    const created = await (await f.send("/channels", "POST", { title: "Engineering", topic: "Build" }))!.json() as { channel: { roomId: string; kind: string } };
    expect(created.channel.kind).toBe("channel");
    const identity = { tenantId: COLLAB_TENANT_ID, workspaceId: COLLAB_WORKSPACE_ID, roomId: created.channel.roomId };
    expect(await canReadCollaborationRoom(f.env, identity, authState.userId)).toBe(true);
    expect(await canReadCollaborationRoom(f.env, identity, "outsider@example.test")).toBe(false);
    const listed = await (await f.send("/channels/public"))!.json() as { channels: Array<{ roomId: string }> };
    expect(listed.channels.map((c) => c.roomId)).toContain(created.channel.roomId);
    authState.userId = "member@example.test";
    expect((await f.send(`/channels/${created.channel.roomId}/join`, "POST"))?.status).toBe(201);
    expect((await f.send(`/channels/${created.channel.roomId}/leave`, "POST"))?.status).toBe(200);
  });

  it("reports only actual membership writes when a channel join is repeated", async () => {
    const { database } = customAgentD1();
    const env = { AGENT_AUDIT: database } as unknown as Env;
    const owner = { tenantId: "default", workspaceId: "default", userId: "owner@example.test" };
    const member = { ...owner, userId: "member@example.test" };
    await createChannel(env, owner, { roomId: "repeat-join", title: "Engineering", createdAt: 1 });
    expect(await joinChannel(env, member, "repeat-join", 2)).toBe(true);
    expect(await joinChannel(env, member, "repeat-join", 3)).toBe(false);
    expect(await leaveChannel(env, owner, "repeat-join", 4)).toBe(false);
    expect(await leaveChannel(env, member, "repeat-join", 5)).toBe(true);
  });

  it("opens a stable dm key for two users", async () => {
    const f = fixture();
    await f.send("/channels", "POST", { title: "Seed", isPrivate: true });
    authState.userId = "owner@example.test";
    const first = await (await f.send("/dms", "POST", { userId: "member@example.test" }))!.json() as { dm: { roomId: string; dmKey: string } };
    const second = await (await f.send("/dms", "POST", { userId: "member@example.test" }))!.json() as { dm: { roomId: string } };
    expect(second.dm.roomId).toBe(first.dm.roomId);
    expect(first.dm.dmKey).toMatch(/^dm:/);
  });

  it("keeps DM messages, unread counts and realtime authority private to its members", async () => {
    const f = fixture();
    const created = await f.send("/dms", "POST", { userId: "member@example.test" });
    expect(created?.status).toBe(201);
    const { dm } = await created!.json() as { dm: { roomId: string } };
    const identity = { tenantId: COLLAB_TENANT_ID, workspaceId: COLLAB_WORKSPACE_ID, roomId: dm.roomId };
    expect((await f.send(`/rooms/${dm.roomId}/messages`, "POST", { body: "Private DM message" }))?.status).toBe(201);
    authState.userId = "member@example.test";
    const detail = await (await f.send(`/rooms/${dm.roomId}`))!.json() as { messages: Array<{ body: string }> };
    expect(detail.messages.some((message) => message.body === "Private DM message")).toBe(true);
    const listed = await (await f.send("/rooms?kind=dm"))!.json() as { rooms: Array<{ roomId: string; unreadCount: number; lastMessageSeq: number }> };
    const room = listed.rooms.find((item) => item.roomId === dm.roomId)!;
    expect(room.unreadCount).toBe(1);
    expect((await f.send("/read-cursors", "PUT", { roomId: dm.roomId, lastReadSeq: room.lastMessageSeq }))?.status).toBe(200);
    const read = await (await f.send("/rooms?kind=dm"))!.json() as { rooms: Array<{ unreadCount: number }> };
    expect(read.rooms[0]?.unreadCount).toBe(0);
    expect(await canReadCollaborationRoom(f.env, identity, authState.userId)).toBe(true);
    expect(await canReadCollaborationRoom(f.env, identity, "owner@example.test")).toBe(true);

    authState.userId = "outsider@example.test";
    const hidden = await (await f.send("/rooms?kind=dm"))!.json() as { rooms: unknown[] };
    expect(hidden.rooms).toEqual([]);
    expect((await f.send(`/rooms/${dm.roomId}`))?.status).toBe(404);
    expect((await f.send(`/rooms/${dm.roomId}/messages`, "POST", { body: "Intrusion" }))?.status).toBe(404);
    expect(await canReadCollaborationRoom(f.env, identity, authState.userId)).toBe(false);
  });

  it("applies the migration file instead of embedding table DDL", async () => {
    const { database, sqlite } = customAgentD1();
    const env = { AGENT_AUDIT: database } as unknown as Env;
    await ensureCollaborationSchema(env);
    const response = await handleCollaboration(
      new Request("https://worker.test/api/collaboration/channels/public", { method: "GET" }),
      env,
    );
    expect(response?.status).toBe(200);
    expect(sqlite.prepare("SELECT name FROM pragma_table_info('collaboration_messages') WHERE name='thread_root_id'").get()).toBeTruthy();
    const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/collaboration-store.ts", import.meta.url), "utf8"));
    expect(source.includes("CREATE TABLE")).toBe(false);
  });

  it("keeps task progress in the thread and posts the result on the channel", async () => {
    const f = fixture();
    const channel = await (await f.send("/channels", "POST", { title: "eng" }))!.json() as { channel: { roomId: string } };
    const opened = await (await f.send(`/rooms/${channel.channel.roomId}/tasks`, "POST", { title: "Ship the fix" }))!.json() as {
      task: { taskId: string; ownerActorId: string; rootMessageId: string };
    };
    expect(opened.task.ownerActorId).toContain("owner@example.test");
    const progress = await f.send(`/rooms/${channel.channel.roomId}/tasks/${opened.task.taskId}/replies`, "POST", {
      role: "progress",
      body: "Investigating",
    });
    expect(progress?.status).toBe(201);
    const done = await (await f.send(`/rooms/${channel.channel.roomId}/tasks/${opened.task.taskId}/replies`, "POST", {
      role: "result",
      body: "Fix landed",
    }))!.json() as { reply: { channelMessageId?: string; task: { status: string } } };
    expect(done.reply.task.status).toBe("done");
    expect(done.reply.channelMessageId).toBeTruthy();
    const handoff = await (await f.send(`/rooms/${channel.channel.roomId}/tasks`, "POST", { title: "Second" }))!.json() as { task: { taskId: string } };
    const assigned = await (await f.send(`/rooms/${channel.channel.roomId}/tasks/${handoff.task.taskId}/replies`, "POST", {
      role: "handoff",
      assigneeActorId: "agent:reviewer",
      body: "Please review",
    }))!.json() as { reply: { task: { ownerActorId: string; status: string } } };
    expect(assigned.reply.task.ownerActorId).toBe("agent:reviewer");
    expect(assigned.reply.task.status).toBe("working");
  });
});