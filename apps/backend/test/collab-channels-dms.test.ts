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
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='workspace_notifications'").get()).toBeUndefined();
  });
});