import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSlackEvent, isSlackAcknowledgmentOnly, type SlackMentionDeps } from "../src/slack-mention.js";
import { addSlackReaction, deleteSlackMessage } from "../src/slack.js";
import * as employees from "../src/chat-employee.js";
import type { Env } from "../src/env.js";
import type { SlackContinuationTarget } from "../src/slack-thread.js";
import type { SlackEventCallbackBody } from "../src/slack-events.js";

const target: SlackContinuationTarget = {
  repoUrl: "https://github.com/owner/prior", baseBranch: "develop", publishPullRequest: false,
  harness: "codex", customAgentId: "employee-1", customAgentVersion: 3, orgId: "team:one",
  runtime: "local", targetMachineId: "machine-1", employeeToolPolicyVersion: 3,
};
const env = { SLACK_BOT_TOKEN: "fixture-token", SLACK_CHANNEL_REPOS: JSON.stringify({ C1: "https://github.com/other/repo" }) } as Env;

function reply(text = "Please fix the remaining tests", overrides: Record<string, unknown> = {}): SlackEventCallbackBody {
  return { type: "event_callback", event_id: "Ev1", team_id: "T1", event: {
    type: "message", channel: "C1", user: "U1", ts: "1700.0002", thread_ts: "1700.0001", text, ...overrides,
  } };
}

function deps(continuation: SlackContinuationTarget | null = target) {
  return {
    bufferMessage: vi.fn<NonNullable<SlackMentionDeps["bufferMessage"]>>(async () => ({ buffered: false, continuation })),
    queueRun: vi.fn<NonNullable<SlackMentionDeps["queueRun"]>>(async () => ({ approvalId: "approval-1" })),
    fetchThread: vi.fn<NonNullable<SlackMentionDeps["fetchThread"]>>(async () => []), postMessage: vi.fn(async () => {}),
    postMessageWithReceipt: vi.fn(async () => ({ channel: "C1", ts: "1700.0003" })),
    updateMessage: vi.fn<NonNullable<SlackMentionDeps["updateMessage"]>>(async () => {}),
    deleteMessage: vi.fn(async () => {}), addReaction: vi.fn(async () => {}),
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("legacy Slack thread continuations", () => {
  it("does not turn an excluded aside into historical continuation work", async () => {
    const d = deps();
    await handleSlackEvent(reply("aside please do not run this"), env, d);
    expect(d.bufferMessage).not.toHaveBeenCalled();
    expect(d.queueRun).not.toHaveBeenCalled();
    expect(d.postMessageWithReceipt).not.toHaveBeenCalled();
    expect(d.addReaction).not.toHaveBeenCalled();
  });

  it.each(["Please fix the remaining tests", "thanks"])("ignores muted continuations without posting or reacting: %s", async (text) => {
    const d = deps();
    d.fetchThread.mockResolvedValue([
      { user: "U1", text: "Historical task", ts: 1699 },
      { user: "U1", text: "mute", ts: 1700 },
    ]);
    await handleSlackEvent(reply(text), env, d);
    expect(d.queueRun).not.toHaveBeenCalled();
    expect(d.postMessageWithReceipt).not.toHaveBeenCalled();
    expect(d.postMessage).not.toHaveBeenCalled();
    expect(d.updateMessage).not.toHaveBeenCalled();
    expect(d.deleteMessage).not.toHaveBeenCalled();
    expect(d.addReaction).not.toHaveBeenCalled();
  });

  it("resumes ordinary continuations after unmute, and still permits authenticated mentions while muted", async () => {
    for (const type of ["message", "app_mention"]) {
      const d = deps();
      d.fetchThread.mockResolvedValue([
        { user: "U1", text: "mute", ts: 1698 },
        ...(type === "message" ? [{ user: "U1", text: "unmute", ts: 1699 }] : []),
      ]);
      await handleSlackEvent(reply("Please include tests", { type }), env, d);
      expect(d.queueRun).toHaveBeenCalledOnce();
      expect(d.postMessageWithReceipt).toHaveBeenCalledOnce();
    }
  });

  it.each(["message", "app_mention"])("inherits the last target for %s without resolving employee or repository from text", async (type) => {
    const resolve = vi.spyOn(employees, "resolveChatEmployeeFromText").mockRejectedValue(new Error("must not resolve"));
    const d = deps();
    await handleSlackEvent(reply("<@BOT> ask AnotherEmployee workspace:other https://github.com/other/new to fix tests", { type }), env, d);
    expect(resolve).not.toHaveBeenCalled();
    expect(d.queueRun).toHaveBeenCalledWith(expect.objectContaining({ ...target, threadKey: "slack:T1:C1:1700.0001" }));
    expect(d.postMessageWithReceipt).toHaveBeenCalledBefore(d.queueRun);
    expect(d.updateMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "C1", ts: "1700.0003", blocks: expect.any(Array) }));
    expect(d.postMessage).not.toHaveBeenCalled();
  });

  it("retains artifact workspace identity instead of accepting a new workspace in reply text", async () => {
    const executionTarget = { kind: "artifact-workspace" as const, workspaceId: "prior-workspace", expectedDeliverables: [] };
    const d = deps({ ...target, repoUrl: "", executionTarget });
    await handleSlackEvent(reply("Continue workspace:other"), env, d);
    expect(d.queueRun).toHaveBeenCalledWith(expect.objectContaining({ repoUrl: "", executionTarget, publishPullRequest: false }));
    expect(d.queueRun.mock.calls[0]?.[0].workspaceTarget).toBeUndefined();
  });

  it("ignores unengaged replies, top-level chatter and bot/self events", async () => {
    const d = deps(null);
    await handleSlackEvent(reply(), env, d);
    expect(d.postMessageWithReceipt).not.toHaveBeenCalled();
    d.bufferMessage.mockClear();
    for (const event of [reply("hello", { thread_ts: undefined }), reply("fix", { bot_id: "B1" }), reply("fix", { type: "app_mention", bot_id: "B1" }), reply("fix", { type: "app_mention", subtype: "bot_message" }), { ...reply("fix", { type: "app_mention" }), authorizations: [{ is_bot: true, user_id: "U1" }] }]) {
      await handleSlackEvent(event, env, d);
    }
    expect(d.bufferMessage).not.toHaveBeenCalled();
    expect(d.queueRun).not.toHaveBeenCalled();
  });

  it.each(["thanks", "<@BOT> THANK YOU!!!", "ty", "Ok.", "okay", "got it", "cool", "great", "perfect", "sounds good", "👍", ":+1:", "🙏", "Okay, thanks!"])("deletes interim status and reacts without queueing for %s", async (text) => {
    const d = deps();
    await handleSlackEvent(reply(text), env, d);
    expect(d.bufferMessage).toHaveBeenCalledWith(expect.objectContaining({ lookupOnly: true }));
    expect(d.postMessageWithReceipt).toHaveBeenCalledBefore(d.deleteMessage);
    expect(d.deleteMessage).toHaveBeenCalledWith({ channel: "C1", ts: "1700.0003" });
    expect(d.addReaction).toHaveBeenCalledWith({ channel: "C1", timestamp: "1700.0002", name: "white_check_mark" });
    expect(d.queueRun).not.toHaveBeenCalled();
    expect(d.fetchThread).toHaveBeenCalledOnce();
  });

  it.each(["", "<@BOT>", "thanks?", "okay？", "¿thanks", "ok‽", "thanks❓", "great, fix it", "thanks can you deploy", "not okay", "sounds good but please change tests"])("does not classify questions, requests or empty text as acknowledgments: %s", (text) => {
    expect(isSlackAcknowledgmentOnly(text)).toBe(false);
  });

  it("handles mentions inside existing threads without queueing acknowledgments", async () => {
    const d = deps();
    await handleSlackEvent(reply("<@BOT> thanks!", { type: "app_mention" }), env, d);
    expect(d.addReaction).toHaveBeenCalledOnce();
    expect(d.queueRun).not.toHaveBeenCalled();
  });

  it("falls back to posting the approval card when an interim update fails", async () => {
    const d = deps();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    d.updateMessage.mockRejectedValue(new Error("Slack offline"));
    await handleSlackEvent(reply(), env, d);
    expect(d.queueRun).toHaveBeenCalledOnce();
    expect(d.postMessage).toHaveBeenCalledWith(expect.objectContaining({ blocks: expect.any(Array) }));
    expect(log).toHaveBeenCalledWith("Slack interim update failed", "Error: Slack offline");
  });

  it.each(["post", "delete", "reaction"])("fails open on acknowledgment %s errors without queueing", async (failure) => {
    const d = deps();
    vi.spyOn(console, "error").mockImplementation(() => {});
    if (failure === "post") d.postMessageWithReceipt.mockRejectedValue(new Error("offline"));
    if (failure === "delete") d.deleteMessage.mockRejectedValue(new Error("offline"));
    if (failure === "reaction") d.addReaction.mockRejectedValue(new Error("offline"));
    await expect(handleSlackEvent(reply("thanks"), env, d)).resolves.toBeUndefined();
    expect(d.addReaction).toHaveBeenCalledOnce();
    expect(d.queueRun).not.toHaveBeenCalled();
  });

  it("still queues and posts a card if the interim post fails", async () => {
    const d = deps();
    vi.spyOn(console, "error").mockImplementation(() => {});
    d.postMessageWithReceipt.mockRejectedValue(new Error("offline"));
    await handleSlackEvent(reply(), env, d);
    expect(d.queueRun).toHaveBeenCalledOnce();
    expect(d.postMessage).toHaveBeenCalledWith(expect.objectContaining({ blocks: expect.any(Array) }));
  });
});

describe("Slack delete and reaction writes", () => {
  it.each([
    ["chat.delete", () => deleteSlackMessage("test-token", { channel: "C1", ts: "1.2" }), { channel: "C1", ts: "1.2" }],
    ["reactions.add", () => addSlackReaction("test-token", { channel: "C1", timestamp: "1.2", name: "white_check_mark" }), { channel: "C1", timestamp: "1.2", name: "white_check_mark" }],
  ] as const)("posts %s with a bounded authenticated request and rejects API/transport failures", async (method, send, expected) => {
    const fetcher = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    await send();
    expect(fetcher).toHaveBeenCalledWith(`https://slack.com/api/${method}`, expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal), headers: expect.objectContaining({ Authorization: "Bearer test-token" }), body: JSON.stringify(expected) }));
    for (const response of [Response.json({ ok: false, error: "missing_scope" }), Response.json({ ok: true }, { status: 503 }), new Response("invalid")]) {
      fetcher.mockResolvedValueOnce(response);
      await expect(send()).rejects.toThrow();
    }
    fetcher.mockRejectedValueOnce(new Error("offline"));
    await expect(send()).rejects.toThrow("offline");
  });
});
