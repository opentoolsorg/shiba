import { createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { channelOutputAdapter } from "../src/channel-output-delivery.js";
import type { Env } from "../src/env.js";
import { handleSlackInteract } from "../src/slack-approval.js";
import { clearSeenSlackEvents, handleSlackEvents } from "../src/slack-events.js";
import { handleSlackEvent } from "../src/slack-mention.js";
import { deliverSlackThreadReply, SEND_SLACK_REPLY_ACTION } from "../src/slack-reply-review.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const signingSecret = "local-test-signing-secret";
const destination = { teamId: "TLOCAL", channelId: "COUTSIDE", threadTs: "1758217392.000100" };

function signed(path: string, body: string, secret = signingSecret) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
  return new Request(`https://shiba.example/api/slack/${path}`, {
    method: "POST", body, headers: { "x-slack-request-timestamp": ts, "x-slack-signature": `v0=${sig}` },
  });
}

function fixture() {
  const { database, sqlite } = customAgentD1();
  const env = { AGENT_AUDIT: database, SLACK_SIGNING_SECRET: signingSecret,
    SLACK_BOT_TOKEN: "local-test-bot", SLACK_APPROVERS: "UREMOTE, UREVIEW, UOTHER" } as unknown as Env;
  const post = vi.fn(async (body: Record<string, unknown>) =>
    Response.json({ ok: true, channel: body.channel, ts: "1758217393.000200" }));
  const state = { external: true as boolean | undefined, pending: false, reviewerTeam: "TLOCAL" };
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const body = JSON.parse(typeof init?.body === "string" && init.body.startsWith("{") ? init.body : "{}");
    switch (url.pathname) {
      case "/api/conversations.info": {
        // The channel under review stays external; the reviewer's DM is not shared.
        const id = url.searchParams.get("channel");
        return Response.json({ ok: true, channel: {
          id, is_ext_shared: id === "DREVIEW" ? false : state.external, is_pending_ext_shared: state.pending,
        } });
      }
      case "/api/conversations.replies": return Response.json({ ok: true, messages: [] });
      case "/api/auth.test": return Response.json({ ok: true, team_id: "TLOCAL", user_id: "UBOT", bot_id: "BBOT" });
      case "/api/users.info": {
        const id = url.searchParams.get("user");
        return Response.json({ ok: true, user: { id, team_id: id === "UREMOTE" ? "TFOREIGN" : state.reviewerTeam, deleted: false, is_bot: false } });
      }
      case "/api/conversations.open": {
        expect(body.users).toBe("UREVIEW");
        return Response.json({ ok: true, channel: { id: "DREVIEW" } });
      }
      case "/api/chat.postMessage": return post(body);
      default: throw new Error(`Unexpected mock Slack request: ${url.pathname}`);
    }
  }));
  const respond = vi.fn(async (_url: string, _text: string) => {});
  const dispatchApprove = vi.fn(async () => ({ result: "approved" }));
  const click = (id: unknown, user = "UREVIEW", dm = "DREVIEW", team = "TLOCAL", secret?: string) =>
    handleSlackInteract(signed("interact", new URLSearchParams({ payload: JSON.stringify({
      type: "block_actions", user: { id: user }, team: { id: team }, channel: { id: dm },
      response_url: "https://hooks.slack.com/actions/TLOCAL/TEST",
      actions: [{ action_id: SEND_SLACK_REPLY_ACTION, value: id }],
      message: { text: "Client-supplied text must never be sent." },
    }) }).toString(), secret), env, { respond, dispatchApprove });
  const row = () => sqlite.prepare("SELECT * FROM slack_reply_drafts").get() as Record<string, string | number> | undefined;
  return { env, sqlite, post, state, click, row, respond, dispatchApprove };
}

afterEach(() => {
  clearSeenSlackEvents();
  vi.unstubAllGlobals();
});

it("holds an external mention for review in an internal DM, then sends the frozen text once", async () => {
  const f = fixture();
  const work: Promise<unknown>[] = [];
  const queueRun = vi.fn();
  const ack = await handleSlackEvents(signed("events", JSON.stringify({ type: "event_callback", event_id: "EvTEST",
    team_id: destination.teamId, is_ext_shared_channel: true, event: {
      type: "app_mention", user: "UREMOTE", channel: destination.channelId, ts: destination.threadTs, text: "<@UBOT> Help",
    } })), f.env, { waitUntil: (promise: Promise<unknown>) => work.push(promise) } as unknown as ExecutionContext,
  { onEvent: (body, env) => handleSlackEvent(body, env, { queueRun }) });
  expect(ack?.status).toBe(200);
  await Promise.all(work);
  // The mention is a task request for an external author: it must not queue a run.
  expect(queueRun).not.toHaveBeenCalled();
  expect(f.post).toHaveBeenCalledOnce();
  // Nothing was posted into the shared channel; the only write is the reviewer's DM.
  expect(f.post.mock.calls[0]?.[0]).toMatchObject({ channel: "DREVIEW" });
  const draft = f.row()!;
  expect(draft).toMatchObject({ reviewer_id: "UREVIEW", channel_id: "COUTSIDE", status: "draft", approved_at: null });
  const id = draft.id;
  expect((await f.click(id, "UREVIEW", "DREVIEW", "TLOCAL", "wrong"))?.status).toBe(401);
  await Promise.all([f.click(id, "UREMOTE"), f.click(id, "UOTHER"), f.click(id, "UREVIEW", "DBAD"), f.click(id, "UREVIEW", "DREVIEW", "TBAD")]);
  expect(f.post).toHaveBeenCalledOnce();
  await Promise.all([f.click(id), f.click(id), f.click(id)]);
  expect(f.post).toHaveBeenCalledTimes(2);
  expect(f.post.mock.calls[1]?.[0]).toMatchObject({
    channel: destination.channelId, thread_ts: destination.threadTs, text: draft.body,
    mrkdwn: false, unfurl_links: false, client_msg_id: id,
  });
  expect(f.row()).toMatchObject({ status: "sent", receipt_ts: "1758217393.000200", approved_at: expect.any(Number) });
  expect(f.dispatchApprove).not.toHaveBeenCalled();
});

it("posts internal channels as before and holds an unclassifiable channel without posting", async () => {
  const f = fixture();
  f.state.external = false;
  await deliverSlackThreadReply(f.env, destination, "internal", { text: "Internal reply" });
  expect(f.post.mock.calls[0]?.[0]).toMatchObject({ channel: destination.channelId, text: "Internal reply" });
  f.state.external = undefined;
  await deliverSlackThreadReply(f.env, destination, "unknown", { text: "Private text" });
  // The reply never reaches the channel; the reviewer is told what to grant.
  expect(f.post).toHaveBeenCalledTimes(2);
  expect(f.post.mock.calls[1]?.[0]).toMatchObject({ channel: "DREVIEW" });
  expect(f.post.mock.calls.map(([body]) => body.channel)).toEqual([destination.channelId, "DREVIEW"]);
  expect(String(f.post.mock.calls[1]?.[0]?.text)).toContain("channels:read");
  expect(f.row()).toBeUndefined();
});

it("delivers approval cards privately and never reissues or retries a draft", async () => {
  const f = fixture();
  const blocks = [{ type: "section", text: { type: "plain_text", text: "Approve this task separately" } }];
  await deliverSlackThreadReply(f.env, destination, "approval", { text: "Approval required", native: { blocks } });
  expect(f.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ channel: "DREVIEW", text: "Approval required", blocks }));
  expect(f.row()).toBeUndefined();

  f.state.external = false;
  f.state.pending = true;
  await deliverSlackThreadReply(f.env, destination, "result", { text: "Approved text must be exact." });
  await deliverSlackThreadReply(f.env, destination, "result", { text: "A different body cannot replace the draft." });
  expect(f.post).toHaveBeenCalledTimes(2);
  const id = f.row()?.id;
  f.state.reviewerTeam = "TFOREIGN";
  await f.click(id);
  expect(f.post).toHaveBeenCalledTimes(2);
  f.state.reviewerTeam = destination.teamId;
  f.sqlite.exec("UPDATE slack_reply_drafts SET expires_at=0");
  await f.click(id);
  expect(f.post).toHaveBeenCalledTimes(2);
  expect(f.row()).toMatchObject({ status: "draft", approved_at: null });
  expect(f.dispatchApprove).not.toHaveBeenCalled();
});

it("records an unconfirmed send and never retries it", async () => {
  const f = fixture();
  await deliverSlackThreadReply(f.env, destination, "result", { text: "Approved text must be exact." });
  const id = f.row()?.id;
  f.post.mockRejectedValueOnce(new Error("transport disconnected after sending"));
  await f.click(id);
  await f.click(id);
  expect(f.post).toHaveBeenCalledTimes(2);
  expect(f.row()).toMatchObject({ status: "unknown", receipt_ts: null, approved_at: expect.any(Number) });
});

it("keeps attachments out of channels shared outside the workspace", async () => {
  const f = fixture();
  const output = { channel: "slack" as const, placeId: destination.channelId, threadId: destination.threadTs, teamId: destination.teamId };
  expect(await channelOutputAdapter(f.env, output)).toBeNull();
  f.state.external = false;
  const adapter = await channelOutputAdapter(f.env, output);
  expect(adapter?.channel).toBe("slack");
});
