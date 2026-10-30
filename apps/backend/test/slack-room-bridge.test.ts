import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCollaboration } from "../src/collaboration-routes.js";
import type { Env } from "../src/env.js";
import { handleSlackEvents, clearSeenSlackEvents } from "../src/slack-events.js";
import { handleSlackRoomEvent } from "../src/slack-room-bridge.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const authState = vi.hoisted(() => ({ userId: "owner@example.test", authorized: true }));
vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: vi.fn(async () => authState.authorized),
  resolveUserId: vi.fn(async () => authState.userId),
}));

const SIGNING_SECRET = "local-signed-event-test-secret";

function fixture() {
  const { database, sqlite } = customAgentD1();
  const env = {
    AGENT_AUDIT: database,
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
  } as unknown as Env;
  const send = (
    path: string,
    method = "GET",
    body?: unknown,
    deps?: Parameters<typeof handleCollaboration>[2],
  ) => handleCollaboration(
    new Request(`https://worker.test/api/collaboration${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(method === "GET" ? {} : { origin: "https://worker.test" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    deps,
  );
  return { env, sqlite, send };
}

async function json<T>(response: Response | null): Promise<T> {
  if (!response) throw new Error("route not handled");
  return (await response.json()) as T;
}

async function signedSlackRequest(body: unknown, secret = SIGNING_SECRET): Promise<Request> {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${rawBody}`),
  );
  const hex = Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request("https://worker.test/api/slack/events", {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${hex}`,
      "content-type": "application/json",
    },
    body: rawBody,
  });
}

async function dispatchSignedEvent(f: ReturnType<typeof fixture>, body: unknown) {
  const pending: Promise<unknown>[] = [];
  const response = await handleSlackEvents(
    await signedSlackRequest(body),
    f.env,
    { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext,
    { onEvent: (event, env) => handleSlackRoomEvent(event, env) },
  );
  await Promise.all(pending);
  return response;
}

function event(
  eventId: string,
  overrides: Record<string, unknown> = {},
  envelope: Record<string, unknown> = {},
) {
  return {
    type: "event_callback",
    event_id: eventId,
    team_id: "T123",
    event: {
      type: "app_mention",
      user: "U123",
      channel: "C123",
      ts: "1710000000.000100",
      text: "<@B123> review this thread",
      ...overrides,
    },
    ...envelope,
  };
}

beforeEach(() => {
  authState.userId = "owner@example.test";
  authState.authorized = true;
  clearSeenSlackEvents();
});

describe("signed Slack continuity through persistent collaboration rooms", () => {
  it("maps an observed thread, mirrors replies once, and records an authorized delivery intent without posting", async () => {
    const f = fixture();
    const room = await json<{ room: { roomId: string } }>(
      await f.send("/rooms", "POST", { title: "Incident room" }),
    );
    const roomId = room.room.roomId;

    const mention = event("EvRoot0001");
    expect((await dispatchSignedEvent(f, mention))?.status).toBe(200);
    let detail = await json<{
      messages: unknown[];
      slackSources: Array<{ teamId: string; channelId: string; threadTs: string }>;
    }>(await f.send(`/rooms/${roomId}`));
    expect(detail.messages).toEqual([]); // Unlinked text is not copied into Shiba.
    expect(detail.slackSources).toContainEqual({
      teamId: "T123",
      channelId: "C123",
      threadTs: "1710000000.000100",
      lastSeenAt: expect.any(Number),
      lastUserId: "U123",
    });

    authState.userId = "outsider@example.test";
    expect((await f.send(`/rooms/${roomId}/slack-links`, "POST", {
      teamId: "T123",
      channelId: "C123",
      threadTs: "1710000000.000100",
    }))?.status).toBe(404);
    authState.userId = "owner@example.test";
    const link = await json<{ link: { linkId: string; status: string } }>(
      await f.send(`/rooms/${roomId}/slack-links`, "POST", {
        teamId: "T123",
        channelId: "C123",
        threadTs: "1710000000.000100",
      }),
    );
    expect(link.link.status).toBe("active");

    const reply = event(
      "EvReply0002",
      {
        type: "message",
        ts: "1710000001.000200",
        thread_ts: "1710000000.000100",
        user: "U456",
        text: "The alert began after the deploy.",
      },
    );
    expect((await dispatchSignedEvent(f, reply))?.status).toBe(200);
    clearSeenSlackEvents(); // Simulate another isolate receiving Slack's replay.
    await dispatchSignedEvent(f, reply);

    const messageDetail = await json<{
      messages: Array<{
        senderUserId: string;
        senderActorId: string;
        body: string;
        sourceSlackEventId?: string;
        sourceSlackTeamId?: string;
        sourceSlackChannelId?: string;
        sourceSlackThreadTs?: string;
        sourceSlackUserId?: string;
      }>;
    }>(await f.send(`/rooms/${roomId}`));
    expect(messageDetail.messages).toHaveLength(1);
    expect(messageDetail.messages[0]).toMatchObject({
      senderUserId: "slack:T123:U456",
      senderActorId: `slack:${link.link.linkId}:U456`,
      body: "The alert began after the deploy.",
      sourceSlackEventId: "EvReply0002",
      sourceSlackTeamId: "T123",
      sourceSlackChannelId: "C123",
      sourceSlackThreadTs: "1710000000.000100",
      sourceSlackUserId: "U456",
    });
    expect((await f.send(
      `/rooms/${roomId}/messages/slack_evt_T123_EvReply0002/slack-delivery`,
      "POST",
      { linkId: link.link.linkId },
    ))?.status).toBe(409);

    await dispatchSignedEvent(f, event("EvUnlinked0003", {
      type: "message",
      ts: "1710000002.000300",
      thread_ts: "1710000000.000100",
      channel: "C999",
      text: "A mismatched channel cannot write to the mapped room.",
    }));
    await dispatchSignedEvent(f, event("EvWrongTeam0004", {
      type: "message",
      ts: "1710000003.000400",
      thread_ts: "1710000000.000100",
      text: "A different workspace cannot write to the mapped room.",
    }, { team_id: "T999" }));

    authState.userId = "outsider@example.test";
    expect((await f.send(`/rooms/${roomId}`))?.status).toBe(404);
    authState.userId = "owner@example.test";
    const messagesAfterMismatch = await json<{ messages: Array<{ sourceSlackEventId?: string }> }>(
      await f.send(`/rooms/${roomId}`),
    );
    expect(messagesAfterMismatch.messages).toHaveLength(1);

    const webMessage = await json<{ message: { messageId: string } }>(
      await f.send(`/rooms/${roomId}/messages`, "POST", { body: "I will investigate the deployment." }),
    );
    expect((await f.send(
      `/rooms/${roomId}/messages/${webMessage.message.messageId}/slack-delivery`,
      "POST",
      { linkId: link.link.linkId },
    ))?.status).toBe(409);
    f.env.SLACK_APPROVALS_CHANNEL = "C123";
    f.env.SLACK_BOT_TOKEN = "xoxb-test-mock-only";
    const deliveryAdapter = vi.fn(async () => {});
    const intent = await f.send(
      `/rooms/${roomId}/messages/${webMessage.message.messageId}/slack-delivery`,
      "POST",
      { linkId: link.link.linkId },
      { onSlackDeliveryIntent: deliveryAdapter },
    );
    expect(intent?.status).toBe(202);
    expect(await intent?.json()).toMatchObject({ sent: false, intent: { status: "pending", channelId: "C123" } });
    expect(deliveryAdapter).toHaveBeenCalledTimes(1);
    expect(
      f.sqlite.prepare("SELECT COUNT(*) AS count FROM collaboration_slack_delivery_intents").get()?.count,
    ).toBe(1);

    expect((await f.send(
      `/rooms/${roomId}/slack-links/${link.link.linkId}`,
      "DELETE",
    ))?.status).toBe(200);
    await dispatchSignedEvent(f, event("EvAfterRevoke0005", {
      type: "message",
      ts: "1710000004.000500",
      thread_ts: "1710000000.000100",
      text: "A revoked link cannot accept new messages.",
    }));
    const messagesAfterRevoke = await json<{ messages: Array<{ sourceSlackEventId?: string }> }>(
      await f.send(`/rooms/${roomId}`),
    );
    expect(messagesAfterRevoke.messages.filter((message) => message.sourceSlackEventId)).toHaveLength(1);
    expect(
      f.sqlite.prepare("SELECT status FROM collaboration_slack_delivery_intents").get(),
    ).toEqual({ status: "blocked" });
  });

  it("does not accept tampered signed payloads or owner links to unseen thread IDs", async () => {
    const f = fixture();
    const room = await json<{ room: { roomId: string } }>(
      await f.send("/rooms", "POST", { title: "No forged sources" }),
    );
    const tampered = await signedSlackRequest(event("EvTamper0001"));
    const raw = await tampered.text();
    const invalid = new Request(tampered.url, {
      method: "POST",
      headers: tampered.headers,
      body: raw.replace("review this thread", "forged replacement"),
    });
    expect((await handleSlackEvents(
      invalid,
      f.env,
      { waitUntil: () => {} } as unknown as ExecutionContext,
      { onEvent: (body, env) => handleSlackRoomEvent(body, env) },
    ))?.status).toBe(401);
    expect((await f.send(`/rooms/${room.room.roomId}/slack-links`, "POST", {
      teamId: "T123",
      channelId: "C123",
      threadTs: "1710000000.000100",
    }))?.status).toBe(409);
  });

  it("sends only after configured dashboard approval, verifies the workspace token binding, and records a deduplicated receipt", async () => {
    const f = fixture();
    const room = await json<{ room: { roomId: string } }>(
      await f.send("/rooms", "POST", { title: "Approved outbound" }),
    );
    const roomId = room.room.roomId;
    await dispatchSignedEvent(f, event("EvOutboxRoot01"));
    const link = await json<{ link: { linkId: string } }>(await f.send(
      `/rooms/${roomId}/slack-links`, "POST", {
        teamId: "T123", channelId: "C123", threadTs: "1710000000.000100",
      },
    ));
    const message = await json<{ message: { messageId: string } }>(await f.send(
      `/rooms/${roomId}/messages`, "POST", { body: "The reviewed outcome is ready." },
    ));
    f.env.SLACK_BOT_TOKEN = "xoxb-test-mock-only";
    f.env.SLACK_APPROVALS_CHANNEL = "C123";
    const intentResponse = await f.send(
      `/rooms/${roomId}/messages/${message.message.messageId}/slack-delivery`, "POST", { linkId: link.link.linkId },
    );
    const intent = await json<{ intent: { intentId: string; content: string; deliveryStatus: string } }>(intentResponse);
    expect(intent.intent).toMatchObject({ content: "The reviewed outcome is ready.", deliveryStatus: "awaiting_approval" });

    const approvePath = `/rooms/${roomId}/slack-delivery/${intent.intent.intentId}/approve`;
    authState.userId = "owner@example.test";
    f.env.DASHBOARD_APPROVERS = "owner@example.test";
    expect((await f.send(approvePath, "POST", {}))?.status).toBe(409); // explicit outbox flag is off by default
    expect(f.sqlite.prepare("SELECT delivery_status FROM collaboration_slack_delivery_intents").get())
      .toEqual({ delivery_status: "awaiting_approval" });

    f.env.SLACK_ROOM_OUTBOX_ENABLED = "true";
    f.env.DASHBOARD_APPROVERS = "";
    expect((await f.send(approvePath, "POST", {}))?.status).toBe(403);
    f.env.DASHBOARD_APPROVERS = "owner@example.test";
    const verifyInstallation = vi.fn(async () => ({ teamId: "T123", userId: "W123", botId: "B123" }));
    const postMessage = vi.fn(async (_token: string, input: { channel: string; text: string; threadTs: string; clientMsgId: string }) => {
      expect(input).toMatchObject({ channel: "C123", threadTs: "1710000000.000100", text: "The reviewed outcome is ready." });
      expect(input.clientMsgId).toMatch(/^[0-9a-f-]{36}$/);
      return { channel: "C123", ts: "1710000009.000900" };
    });
    const response = await f.send(approvePath, "POST", {}, { slackOutbox: { verifyInstallation, postMessage } });
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ delivery: { status: "sent", ts: "1710000009.000900" } });
    expect(verifyInstallation).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(f.sqlite.prepare("SELECT delivery_status,approved_by_user_id,receipt_ts FROM collaboration_slack_delivery_intents").get())
      .toEqual({ delivery_status: "sent", approved_by_user_id: "owner@example.test", receipt_ts: "1710000009.000900" });

    const replay = await f.send(approvePath, "POST", {}, { slackOutbox: { verifyInstallation, postMessage } });
    expect(replay?.status).toBe(202);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("blocks workspace mismatch and revocation before send, and preserves ambiguous outcomes without retry", async () => {
    const create = async (suffix: string) => {
      const f = fixture();
      const room = await json<{ room: { roomId: string } }>(await f.send("/rooms", "POST", { title: `Outbox ${suffix}` }));
      const roomId = room.room.roomId;
      await dispatchSignedEvent(f, event(`EvRoot${suffix}001`));
      const link = await json<{ link: { linkId: string } }>(await f.send(
        `/rooms/${roomId}/slack-links`, "POST", { teamId: "T123", channelId: "C123", threadTs: "1710000000.000100" },
      ));
      const message = await json<{ message: { messageId: string } }>(await f.send(
        `/rooms/${roomId}/messages`, "POST", { body: `Body ${suffix}` },
      ));
      f.env.SLACK_BOT_TOKEN = "xoxb-test-mock-only";
      f.env.SLACK_APPROVALS_CHANNEL = "C123";
      const intent = await json<{ intent: { intentId: string } }>(await f.send(
        `/rooms/${roomId}/messages/${message.message.messageId}/slack-delivery`, "POST", { linkId: link.link.linkId },
      ));
      f.env.SLACK_BOT_TOKEN = "xoxb-test-mock-only";
      f.env.SLACK_APPROVALS_CHANNEL = "C123";
      f.env.SLACK_ROOM_OUTBOX_ENABLED = "true";
      f.env.DASHBOARD_APPROVERS = "owner@example.test";
      return { f, roomId, linkId: link.link.linkId, intentId: intent.intent.intentId };
    };

    const mismatch = await create("Mismatch");
    const mismatchPost = vi.fn(async () => ({ channel: "C123", ts: "x" }));
    const mismatchResponse = await mismatch.f.send(
      `/rooms/${mismatch.roomId}/slack-delivery/${mismatch.intentId}/approve`, "POST", {},
      { slackOutbox: { verifyInstallation: async () => ({ teamId: "T999", userId: "W999", botId: "B999" }), postMessage: mismatchPost } },
    );
    expect(mismatchResponse?.status).toBe(202);
    expect(await mismatchResponse?.json()).toMatchObject({ delivery: { status: "blocked" } });
    expect(mismatchPost).not.toHaveBeenCalled();

    const revoked = await create("Revoked");
    const revokedPost = vi.fn(async () => ({ channel: "C123", ts: "x" }));
    const revokedResponse = await revoked.f.send(
      `/rooms/${revoked.roomId}/slack-delivery/${revoked.intentId}/approve`, "POST", {},
      { slackOutbox: {
        verifyInstallation: async () => {
          await revoked.f.send(`/rooms/${revoked.roomId}/slack-links/${revoked.linkId}`, "DELETE");
          return { teamId: "T123", userId: "W123", botId: "B123" };
        },
        postMessage: revokedPost,
      } },
    );
    expect(revokedResponse?.status).toBe(202);
    expect(await revokedResponse?.json()).toMatchObject({ delivery: { status: "blocked" } });
    expect(revokedPost).not.toHaveBeenCalled();

    const unknown = await create("Unknown");
    const ambiguousPost = vi.fn(async () => { throw new Error("socket closed after request write"); });
    const unknownPath = `/rooms/${unknown.roomId}/slack-delivery/${unknown.intentId}/approve`;
    const unknownDeps = { slackOutbox: { verifyInstallation: async () => ({ teamId: "T123", userId: "W123", botId: "B123" }), postMessage: ambiguousPost } };
    const unknownResponse = await unknown.f.send(unknownPath, "POST", {}, unknownDeps);
    expect(unknownResponse?.status).toBe(202);
    expect(await unknownResponse?.json()).toMatchObject({ delivery: { status: "unknown" } });
    const replay = await unknown.f.send(unknownPath, "POST", {}, unknownDeps);
    expect(await replay?.json()).toMatchObject({ delivery: { status: "not_ready" } });
    expect(ambiguousPost).toHaveBeenCalledTimes(1);
    expect(unknown.f.sqlite.prepare("SELECT delivery_status FROM collaboration_slack_delivery_intents").get())
      .toEqual({ delivery_status: "unknown" });
  });
});
