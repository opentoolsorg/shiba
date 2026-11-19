import { createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
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
    SLACK_BOT_TOKEN: "local-test-bot", SLACK_APPROVERS: "UREMOTE, UREVIEW, UOTHER" } as Env;
  const post = vi.fn(async (body: Record<string, unknown>) =>
    Response.json({ ok: true, channel: body.channel, ts: "1758217393.000200" }));
  const postPrivate = vi.fn(async (_body: Record<string, unknown>) => Response.json({ ok: true }));
  const state = { external: true as boolean | undefined, pending: false, reviewerTeam: "TLOCAL" };
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const body = JSON.parse(typeof init?.body === "string" && init.body.startsWith("{") ? init.body : "{}");
    switch (url.pathname) {
      case "/api/conversations.info": return Response.json({ ok: true, channel: {
        id: url.searchParams.get("channel"), is_ext_shared: state.external, is_pending_ext_shared: state.pending,
      } });
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
      case "/api/chat.postEphemeral": return postPrivate(body);
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
  const row = () => sqlite.prepare("SELECT * FROM slack_reply_drafts").get();
  return { env, sqlite, post, postPrivate, state, click, row, respond, dispatchApprove };
}

afterEach(() => {
  clearSeenSlackEvents();
  vi.unstubAllGlobals();
});

it("reviews a signed external mention in an internal DM, then sends the frozen reply once", async () => {
  const f = fixture();
  const work: Promise<unknown>[] = [];
  const queueRun = vi.fn();
  const incoming = signed("events", JSON.stringify({ type: "event_callback", event_id: "EvTEST",
    team_id: destination.teamId, is_ext_shared_channel: true, event: {
      type: "app_mention", user: "UREMOTE", channel: destination.channelId, ts: destination.threadTs, text: "<@UBOT> Help",
    } }));
  const ack = await handleSlackEvents(incoming, f.env, {
    waitUntil: (promise: Promise<unknown>) => work.push(promise),
  } as unknown as ExecutionContext, { onEvent: (body, env) => handleSlackEvent(body, env, { queueRun }) });
  expect(ack?.status).toBe(200);
  await Promise.all(work);
  expect(queueRun).not.toHaveBeenCalled();
  expect(f.post).toHaveBeenCalledOnce();
  const card = f.post.mock.calls[0]?.[0];
  const draft = f.row();
  expect(card).toMatchObject({ channel: "DREVIEW", blocks: [{}, { text: { type: "plain_text", text: draft?.body } }, {
    elements: [{ action_id: SEND_SLACK_REPLY_ACTION, value: draft?.id }],
  }] });
  expect(draft).toMatchObject({ reviewer_id: "UREVIEW", channel_id: "COUTSIDE", status: "draft", approved_at: null });
  const id = draft?.id;
  expect((await f.click(id, "UREVIEW", "DREVIEW", "TLOCAL", "wrong"))?.status).toBe(401);
  await Promise.all([f.click(id, "UREMOTE"), f.click(id, "UOTHER"), f.click(id, "UREVIEW", "DBAD"), f.click(id, "UREVIEW", "DREVIEW", "TBAD")]);
  expect(f.post).toHaveBeenCalledOnce();
  await Promise.all([f.click(id), f.click(id), f.click(id)]);
  expect(f.post).toHaveBeenCalledTimes(2);
  expect(f.post.mock.calls[1]?.[0]).toMatchObject({
    channel: destination.channelId, thread_ts: destination.threadTs, text: draft?.body,
    mrkdwn: false, unfurl_links: false, client_msg_id: id,
  });
  expect(f.row()).toMatchObject({ status: "sent", receipt_ts: "1758217393.000200", approved_at: expect.any(Number) });
  expect(f.dispatchApprove).not.toHaveBeenCalled();
});

it("preserves internal delivery and does not post if Slack cannot classify the channel", async () => {
  const f = fixture();
  f.state.external = false;
  await deliverSlackThreadReply(f.env, destination, "internal", { text: "Internal reply" });
  expect(f.post.mock.calls[0]?.[0]).toMatchObject({ channel: destination.channelId, text: "Internal reply" });
  f.state.external = undefined;
  await expect(deliverSlackThreadReply(f.env, destination, "unknown", { text: "Private text" })).rejects.toThrow("audience");
  expect(f.post).toHaveBeenCalledOnce();
  expect(f.row()).toBeUndefined();
});

it("does not reissue a draft or retry an unconfirmed send and rechecks reviewer authority", async () => {
  const f = fixture();
  f.state.external = false;
  f.state.pending = true;
  await deliverSlackThreadReply(f.env, destination, "result", { text: "Approved text must be exact." });
  await deliverSlackThreadReply(f.env, destination, "result", { text: "A different body cannot replace the draft." });
  expect(f.post).toHaveBeenCalledOnce();
  const id = f.row()?.id;
  f.state.reviewerTeam = "TFOREIGN";
  await f.click(id);
  expect(f.post).toHaveBeenCalledOnce();
  f.state.reviewerTeam = destination.teamId;
  f.post.mockRejectedValueOnce(new Error("transport disconnected after sending"));
  await f.click(id);
  await f.click(id);
  expect(f.post).toHaveBeenCalledTimes(2);
  expect(f.row()).toMatchObject({ status: "unknown", receipt_ts: null, approved_at: expect.any(Number) });
});

it("keeps execution approval cards private and refuses expired reply drafts", async () => {
  const f = fixture();
  const blocks = [{ type: "section", text: { type: "plain_text", text: "Approve this task separately" } }];
  await deliverSlackThreadReply(f.env, destination, "approval", { text: "Approval required", blocks });
  expect(f.post).not.toHaveBeenCalled();
  expect(f.postPrivate).toHaveBeenCalledExactlyOnceWith({
    channel: destination.channelId, thread_ts: destination.threadTs, user: "UREVIEW",
    text: "Approval required", blocks,
  });
  expect(f.row()).toBeUndefined();
  await deliverSlackThreadReply(f.env, destination, "result", { text: "This draft will expire." });
  f.sqlite.exec("UPDATE slack_reply_drafts SET expires_at=0");
  await f.click(f.row()?.id);
  expect(f.post).toHaveBeenCalledOnce();
  expect(f.dispatchApprove).not.toHaveBeenCalled();
});
