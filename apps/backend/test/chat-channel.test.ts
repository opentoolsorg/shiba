import { describe, expect, it } from "vitest";
import { SlackChatChannel, type SlackChannelDeps } from "../src/adapters/chat-channel/slack/index.js";
import { chatChannelContract, type ChatChannelContractFixture } from "../src/ports/chat-channel/contract.js";
import { ChatChannelRegistry, createChatChannelRegistry } from "../src/ports/chat-channel/registry.js";
import type { ChannelErrorKind, ChannelMessageRef, ChannelThreadRef } from "../src/ports/chat-channel/types.js";
import { SlackPostRejectedError } from "../src/slack.js";

const secret = "chat-channel-test-signing-secret";
const thread: ChannelThreadRef = { channel: "slack", tenantId: "T1", conversationId: "C1", threadId: "1700000000.000001" };

async function signed(body: string, contentType = "application/json", signingSecret = secret): Promise<Request> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
  return new Request("https://example.com/api/slack/events", {
    method: "POST",
    headers: { "content-type": contentType, "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("")}` },
    body,
  });
}

const mention = JSON.stringify({ type: "event_callback", event_id: "Ev1", team_id: "T1", event: { type: "app_mention", channel: "C1", user: "user-1", text: "Please fix this", ts: "1700000000.000002", thread_ts: thread.threadId } });

function fixture(): ChatChannelContractFixture {
  const posts: ChatChannelContractFixture["posts"] = [];
  const updates: ChatChannelContractFixture["updates"] = [];
  let blocks: unknown[] = [];
  let failure: Error | undefined;
  const deps: SlackChannelDeps = {
    post: async (_token, input) => {
      if (failure) throw failure;
      posts.push({ conversationId: input.channel, threadId: input.threadTs, text: input.text });
      blocks = input.blocks ?? [];
      return { channel: input.channel, ts: "1700000000.000003" };
    },
    update: async (_token, input) => {
      updates.push({ conversationId: input.channel, messageId: input.ts, text: input.text, buttonsRemoved: Array.isArray(input.blocks) && input.blocks.length === 0 });
    },
  };
  return {
    channel: new SlackChatChannel({ SLACK_BOT_TOKEN: "test-token", SLACK_SIGNING_SECRET: secret }, deps),
    thread,
    expectedMention: { type: "mention", id: "Ev1", thread, userId: "user-1", text: "Please fix this", messageId: "1700000000.000002" },
    mentionRequest: () => signed(mention),
    badSignatureRequest: () => signed(mention, "application/json", "incorrect-test-secret"),
    actionRequest: (message, action) => actionRequest(message, action, blocks),
    posts,
    updates,
    failPost: (kind, outcomeKnown) => {
      const codes: Record<ChannelErrorKind, string> = { not_installed: "app_uninstalled", not_in_channel: "not_in_channel", rate_limited: "ratelimited", auth_expired: "token_expired", invalid_request: "invalid_arguments" };
      failure = new SlackPostRejectedError(codes[kind], outcomeKnown);
    },
  };
}

async function actionRequest(message: ChannelMessageRef, action: "approve" | "deny", blocks: unknown[], conversationId = thread.conversationId): Promise<Request> {
  const card = blocks.find((block): block is { type: string; elements: { action_id: string; value: string }[] } => typeof block === "object" && block !== null && (block as { type?: string }).type === "actions");
  const button = card?.elements.find((element) => element.action_id === (action === "approve" ? "approve" : "reject"));
  if (!button) throw new Error("The posted approval card has no matching action button.");
  const payload = JSON.stringify({ type: "block_actions", team: { id: thread.tenantId }, channel: { id: conversationId }, user: { id: "user-1" }, message: { ts: message.id, thread_ts: thread.threadId, blocks }, response_url: "https://hooks.slack.com/actions/T1/B1/test", actions: [button] });
  return signed(new URLSearchParams({ payload }).toString(), "application/x-www-form-urlencoded");
}

chatChannelContract("Slack", fixture);

describe("Slack ChatChannel boundaries", () => {
  it("does not confuse a missing installation with a missing channel membership", async () => {
    const missing = new SlackChatChannel({});
    const joined = fixture();
    joined.failPost("not_in_channel", true);
    const a = await missing.postMessage({ thread, text: "Hello" }).catch((error: Error) => error);
    const b = await joined.channel.postMessage({ thread, text: "Hello" }).catch((error: Error) => error);
    expect(a).toMatchObject({ kind: "not_installed" });
    expect(b).toMatchObject({ kind: "not_in_channel" });
    expect((a as Error).message).not.toEqual((b as Error).message);
  });

  it("rejects a correctly signed approval copied into another channel", async () => {
    let blocks: unknown[] = [];
    const channel = new SlackChatChannel({ SLACK_BOT_TOKEN: "test-token", SLACK_SIGNING_SECRET: secret }, {
      post: async (_token, input) => { blocks = input.blocks ?? []; return { channel: "C1", ts: "1700000000.000003" }; },
    });
    const message = await channel.postApprovalRequest({ thread, threadKey: "slack:T1:C1:1700000000.000001", approvalId: "approval-1", repoUrl: "https://github.com/example/repo", task: "Fix" });
    await expect(channel.parse(await actionRequest(message, "approve", blocks, "C2"))).rejects.toMatchObject({ kind: "invalid_request" });
  });

  it("rejects malformed signed data and ignores unsupported event types", async () => {
    const { channel } = fixture();
    await expect(channel.parse(await signed("{"))).rejects.toMatchObject({ kind: "invalid_request" });
    await expect(channel.parse(await signed(JSON.stringify({ type: "event_callback", team_id: "T1", event_id: "Ev2", event: { type: "reaction_added" } })))).resolves.toEqual([]);
    await expect(channel.parse(await signed(JSON.stringify({ type: "event_callback", team_id: "T1", event_id: "Ev3", event: { type: "app_uninstalled" } })))).resolves.toEqual([{ type: "uninstall", channel: "slack", tenantId: "T1" }]);
  });

  it("ignores a signed mention with a numeric thread timestamp", async () => {
    const body = JSON.parse(mention);
    body.event.thread_ts = 1700000000.000001;
    await expect(fixture().channel.parse(await signed(JSON.stringify(body)))).resolves.toEqual([]);
  });

  const malformedActionScopes: [string, Record<string, unknown>][] = [
    ["numeric team", { team: { id: 123 } }],
    ["missing team", { team: {} }],
    ["numeric channel", { channel: { id: 123 } }],
    ["missing channel", { channel: {} }],
    ["numeric thread", { message: { thread_ts: 1700000000.000001 } }],
    ["missing thread", { message: {} }],
    ["invalid thread", { message: { thread_ts: "invalid" } }],
  ];
  for (const [label, scope] of malformedActionScopes) {
    it(`rejects a signed action with a ${label} scope`, async () => {
      const payload = {
        type: "block_actions", team: { id: "T1" }, channel: { id: "C1" },
        user: { id: "user-1" }, message: { thread_ts: thread.threadId },
        response_url: "https://hooks.slack.com/actions/T1/B1/test",
        actions: [{ action_id: "approve", value: JSON.stringify({ threadKey: "default", approvalId: "approval-1" }) }],
        ...scope,
      };
      const request = await signed(new URLSearchParams({ payload: JSON.stringify(payload) }).toString(), "application/x-www-form-urlencoded");
      await expect(fixture().channel.parse(request)).rejects.toMatchObject({ kind: "invalid_request" });
    });
  }

  it("advertises unavailable operations and fails them explicitly", async () => {
    const { channel } = fixture();
    expect(channel.capabilities).toMatchObject({ threads: true, edits: true, buttons: true, files: false, typing: false });
    await expect(channel.postFile({ thread, name: "test.txt", content: new Blob(["test"]) })).rejects.toMatchObject({ kind: "invalid_request" });
    await expect(channel.setTyping(thread)).rejects.toMatchObject({ kind: "invalid_request" });
    await expect(channel.resolveUser("user-1")).resolves.toBeNull();
  });
});

describe("ChatChannel registry", () => {
  it("lists only configured adapters and keeps missing ids absent", () => {
    expect(createChatChannelRegistry({}).listEnabled()).toEqual([]);
    expect(createChatChannelRegistry({ SLACK_SIGNING_SECRET: secret }).get("slack")).toBeUndefined();
    const registry = createChatChannelRegistry({ SLACK_BOT_TOKEN: "test-token" });
    expect(registry.listEnabled().map((channel) => channel.id)).toEqual(["slack"]);
    expect(registry.get("teams")).toBeUndefined();
    expect(registry.get("slack")).not.toBe(registry.get("slack"));
  });

  it("rejects duplicate registrations", () => {
    const registration = { id: "slack", enabled: () => true, create: () => fixture().channel };
    const registry = new ChatChannelRegistry().register(registration);
    expect(() => registry.register(registration)).toThrow("Duplicate chat channel: slack");
  });
});
