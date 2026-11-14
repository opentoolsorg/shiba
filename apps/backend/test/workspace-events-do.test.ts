import { beforeEach, describe, expect, it, vi } from "vitest";
import { VERIFIED_SUBSCRIBER_HEADER, WorkspaceEvents, workspaceEventsName } from "../src/platform/workspace-events-do.js";
import { handleWorkspaceEvents } from "../src/platform/workspace-events-routes.js";

const getCollaborationMembership = vi.hoisted(() => vi.fn());

vi.mock("../src/collaboration-store.js", () => ({
  COLLAB_TENANT_ID: "self-hosted",
  humanActorId: (userId: string) => `human:${userId}`,
  getCollaborationMembership,
}));

vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: vi.fn(async () => true),
  resolveUserId: vi.fn(async () => "alice@example.test"),
}));

vi.mock("../src/team-workspaces-store.js", () => ({
  isTeamWorkspaceMember: vi.fn(async () => true),
}));

const ALICE = "alice@example.test";
const BOB = "bob@example.test";
const EVE = "eve@example.test";
const WORKSPACE = `ws_${"cd".repeat(12)}`;
const ROOM = `room_${"ab".repeat(12)}`;

class FakeSocket {
  sent: string[] = [];
  attachment: unknown = null;
  send(value: string) { this.sent.push(value); }
  serializeAttachment(value: unknown) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return this.attachment == null ? null : structuredClone(this.attachment); }
  close() {}
}

class FakeWebSocketPair {
  0: FakeSocket;
  1: FakeSocket;
  constructor() {
    this[0] = new FakeSocket();
    this[1] = new FakeSocket();
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const ctx = {
    getWebSockets: () => sockets,
    acceptWebSocket: (ws: FakeSocket) => { sockets.push(ws); },
  };
  const hub = new WorkspaceEvents(ctx as never, { AGENT_AUDIT: { prepare() { throw new Error("room membership must use the collaboration store"); } } } as never);
  return { hub, sockets };
}

async function connect(hub: WorkspaceEvents, sockets: FakeSocket[], userId: string, query = ""): Promise<FakeSocket> {
  const headers = new Headers({ upgrade: "websocket", [VERIFIED_SUBSCRIBER_HEADER]: userId });
  try {
    const response = await hub.fetch(new Request(`https://workspace-events.internal/subscribe${query}`, { headers }));
    expect(response.status).toBe(101);
  } catch (error) {
    // Node's Response rejects the 101 status Workers use for a WebSocket upgrade.
    // The socket is tagged before that response is built.
    if (!(error instanceof RangeError)) throw error;
  }
  const socket = sockets.at(-1);
  if (!socket) throw new Error("socket was not accepted");
  return socket;
}

async function publish(hub: WorkspaceEvents, event: Record<string, unknown>) {
  const response = await hub.fetch(new Request("https://workspace-events.internal/internal/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: WORKSPACE, ...event }),
  }));
  expect(response.status).toBe(200);
  return response.json() as Promise<{ ok: boolean; delivered: number }>;
}

function messages(socket: FakeSocket): Record<string, unknown>[] {
  return socket.sent.map((item) => JSON.parse(item) as Record<string, unknown>);
}

describe("workspace events", () => {
  beforeEach(() => {
    getCollaborationMembership.mockReset();
    getCollaborationMembership.mockResolvedValue(null);
    vi.stubGlobal("WebSocketPair", FakeWebSocketPair);
  });

  it("normalizes workspace ids for DO stubs", () => {
    expect(workspaceEventsName("WS_ABC")).toBe("ws_abc");
  });

  it("delivers a room event to a member", async () => {
    getCollaborationMembership.mockImplementation(async (_env: unknown, scope: { userId: string }) => (
      scope.userId === ALICE ? { status: "active" } : null
    ));
    const { hub, sockets } = harness();
    const alice = await connect(hub, sockets, ALICE);
    const result = await publish(hub, {
      id: "evt_member",
      kind: "message.created",
      entityId: ROOM,
      payload: { text: "hello" },
      audience: { roomId: ROOM },
    });
    expect(result.delivered).toBe(1);
    expect(messages(alice)).toEqual([expect.objectContaining({
      id: "evt_member",
      workspaceId: WORKSPACE,
      kind: "message.created",
      entityId: ROOM,
      payload: { text: "hello" },
    })]);
    expect(messages(alice)[0]).not.toHaveProperty("audience");
    expect(getCollaborationMembership).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: "self-hosted", workspaceId: WORKSPACE, userId: ALICE }),
      ROOM,
      `human:${ALICE}`,
    );
  });

  it("does not deliver a room event to a non-member", async () => {
    getCollaborationMembership.mockImplementation(async (_env: unknown, scope: { userId: string }) => (
      scope.userId === ALICE ? { status: "active" } : null
    ));
    const { hub, sockets } = harness();
    const alice = await connect(hub, sockets, ALICE);
    const bob = await connect(hub, sockets, BOB);
    const result = await publish(hub, {
      id: "evt_private",
      kind: "message.created",
      entityId: ROOM,
      payload: { text: "secret" },
      audience: { userIds: [ALICE], roomId: ROOM },
    });
    expect(result.delivered).toBe(1);
    expect(messages(alice)).toHaveLength(1);
    expect(bob.sent).toEqual([]);
    await publish(hub, {
      id: "evt_room_only",
      kind: "message.created",
      entityId: ROOM,
      payload: { text: "still secret" },
      audience: { roomId: ROOM },
    });
    expect(bob.sent).toEqual([]);
    expect(messages(alice)).toHaveLength(2);
  });

  it("broadcasts an event with no audience", async () => {
    const { hub, sockets } = harness();
    const alice = await connect(hub, sockets, ALICE);
    const bob = await connect(hub, sockets, BOB);
    const other = await hub.fetch(new Request("https://workspace-events.internal/publish", {
      method: "POST",
      body: JSON.stringify({ id: "nope", workspaceId: WORKSPACE, kind: "x", entityId: "y" }),
    }));
    expect(other.status).toBe(404);
    const result = await publish(hub, {
      id: "evt_all",
      kind: "workspace.updated",
      entityId: WORKSPACE,
      payload: { version: 3 },
    });
    expect(result.delivered).toBe(2);
    expect(messages(alice)).toHaveLength(1);
    expect(messages(bob)).toHaveLength(1);
    expect(getCollaborationMembership).not.toHaveBeenCalled();
    const legacy = await publish(hub, { type: "task.updated", resourceId: "task_1", version: 4 });
    expect(legacy.delivered).toBe(2);
    expect(messages(bob)[1]).toMatchObject({
      kind: "task.updated",
      entityId: "task_1",
      type: "task.updated",
      resourceId: "task_1",
      version: 4,
    });
  });

  it("ignores a spoofed client userId", async () => {
    const forwarded: Request[] = [];
    const response = await handleWorkspaceEvents(new Request(
      `https://shiba.test/api/workspaces/${WORKSPACE}/events?userId=${encodeURIComponent(EVE)}`,
      { headers: { upgrade: "websocket", [VERIFIED_SUBSCRIBER_HEADER]: EVE } },
    ), {
      WorkspaceEvents: {
        getByName: () => ({ fetch: async (request: Request) => { forwarded.push(request); return new Response(null, { status: 204 }); } }),
      },
    } as never);
    expect(response?.status).toBe(204);
    const subscribe = forwarded[0];
    if (!subscribe) throw new Error("subscribe was not forwarded");
    expect(new URL(subscribe.url).search).toBe("");
    expect(subscribe.headers.get(VERIFIED_SUBSCRIBER_HEADER)).toBe(ALICE);

    const { hub, sockets } = harness();
    const rejected = await hub.fetch(new Request(
      `https://workspace-events.internal/subscribe?userId=${encodeURIComponent(EVE)}`,
      { headers: { upgrade: "websocket" } },
    ));
    expect(rejected.status).toBe(400);
    expect(sockets).toHaveLength(0);
    const alice = await connect(hub, sockets, ALICE, `?userId=${encodeURIComponent(EVE)}`);
    expect(alice.deserializeAttachment()).toMatchObject({ userId: ALICE });
    await hub.webSocketMessage(alice as never, JSON.stringify({ userId: EVE, type: "identify" }));
    expect(alice.deserializeAttachment()).toMatchObject({ userId: ALICE });
    expect(alice.sent).toEqual([]);

    await publish(hub, {
      id: "evt_eve",
      kind: "dm.created",
      entityId: ROOM,
      payload: { text: "for eve" },
      audience: { userIds: [EVE] },
    });
    expect(messages(alice)).toEqual([]);
    await publish(hub, {
      id: "evt_alice",
      kind: "dm.created",
      entityId: ROOM,
      payload: { text: "for alice" },
      audience: { userIds: [EVE.toUpperCase(), `  ${ALICE}  `] },
    });
    expect(messages(alice).map((message) => message.id)).toEqual(["evt_alice"]);
  });
});
