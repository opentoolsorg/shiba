import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureCollaborationSchema } from "../src/collaboration-store.js";
import { handleCollaboration } from "../src/collaboration-routes.js";
import type { Env } from "../src/env.js";
import { applyCollabV2Migrations } from "./fixtures/collab-v2-migrations.js";
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
    const listed = await (await f.send("/channels/public"))!.json() as { channels: Array<{ roomId: string }> };
    expect(listed.channels.map((c) => c.roomId)).toContain(created.channel.roomId);
    authState.userId = "member@example.test";
    expect((await f.send(`/channels/${created.channel.roomId}/join`, "POST"))?.status).toBe(201);
    expect((await f.send(`/channels/${created.channel.roomId}/leave`, "POST"))?.status).toBe(200);
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

  it("returns 503 before v2 migration", async () => {
    const { database, sqlite } = customAgentD1();
    const env = { AGENT_AUDIT: database } as unknown as Env;
    await ensureCollaborationSchema(env);
    const response = await handleCollaboration(
      new Request("https://worker.test/api/collaboration/channels/public", { method: "GET" }),
      env,
    );
    expect(response?.status).toBe(503);
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='collaboration_task_threads'").get()).toBeUndefined();
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