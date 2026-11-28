import { beforeEach, describe, expect, it, vi } from "vitest";
import { postTeamsPublicationApproval } from "../src/channels/teams/connection.js";
import { teamsTransport } from "../src/channels/teams/index.js";
import type { OrchestratorStub } from "../src/chat-lane.js";
import type { Env } from "../src/env.js";
import type { ChannelAdapter, ChannelEditInput, ChannelPostInput, ChannelTransport } from "../src/ports/channel/index.js";
import { clearSeenTeamsActivities, handleTeamsMessages, TEAMS_MESSAGES_PATH, type TeamsDeps } from "../src/teams.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const APPROVAL_ID = "11111111-2222-4333-8444-555555555555";
const CONVERSATION = "19:abc@thread.tacv2";
const REPO = "https://github.com/acme/app";
const APP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const WORKSPACE = "ws_cccccccccccccccccccccccc";
let env: Env;
let fixture: ReturnType<typeof customAgentD1>;

const acceptAll: ChannelTransport = { ...teamsTransport, verify: async () => ({ ok: true }) };

function activity(extra: Record<string, unknown>) {
  return {
    type: "message",
    id: "act-1",
    serviceUrl: "https://smba.trafficmanager.net/teams/",
    channelId: "msteams",
    from: { id: "29:ana", aadObjectId: "aad-ana", name: "Ana" },
    conversation: { id: CONVERSATION, conversationType: "channel", tenantId: TENANT },
    recipient: { id: "28:bot", name: "Shiba" },
    ...extra,
  };
}

const mention = (text: string) => ({
  text: `<at>Shiba</at> ${text}`,
  entities: [{ type: "mention", text: "<at>Shiba</at>", mentioned: { id: "28:bot" } }],
});

function makeDeps(overrides: Partial<TeamsDeps> = {}) {
  const posts: ChannelPostInput[] = [];
  const edits: ChannelEditInput[] = [];
  const adapter = {
    channel: "teams",
    capabilities: new Set(["post", "edit"]),
    post: vi.fn(async (input: ChannelPostInput) => {
      posts.push(input);
      return { placeId: input.placeId, messageId: "act-2" };
    }),
    edit: vi.fn(async (input: ChannelEditInput) => {
      edits.push(input);
    }),
  } as unknown as ChannelAdapter;
  const runBodies: Record<string, unknown>[] = [];
  const approvalBodies: Record<string, unknown>[] = [];
  const stub: OrchestratorStub = {
    fetch: async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      if (request.url.endsWith("/api/runs")) {
        runBodies.push(body);
        return Response.json({ ok: true, approvalId: APPROVAL_ID });
      }
      approvalBodies.push(body);
      return Response.json({ result: (body.approved as boolean) ? "approved" : "rejected" });
    },
  };
  const resolveOrchestrator = vi.fn(async () => stub);
  return {
    posts,
    edits,
    runBodies,
    approvalBodies,
    resolveOrchestrator,
    deps: { adapter, transport: acceptAll, resolveOrchestrator, ...overrides } satisfies TeamsDeps,
  };
}

const post = (body: unknown, path = TEAMS_MESSAGES_PATH) =>
  new Request(`https://shiba.example${path}`, { method: "POST", body: JSON.stringify(body) });

describe("handleTeamsMessages", () => {
  beforeEach(() => {
    clearSeenTeamsActivities();
    fixture = customAgentD1();
    fixture.sqlite.prepare("INSERT INTO teams_connections VALUES (?, ?, ?, 'fixture-generation')").run(WORKSPACE, APP, TENANT);
    env = { AGENT_AUDIT: fixture.database, TEAMS_APP_ID: APP, TEAMS_APP_PASSWORD: "pw", TEAMS_APP_TENANT_ID: TENANT, TEAMS_WORKSPACE_ID: WORKSPACE, TEAMS_APPROVERS: "aad-ana" } as Env;
  });

  it("ignores other paths and methods", async () => {
    expect(await handleTeamsMessages(post({}, "/api/other"), env)).toBeNull();
    expect(await handleTeamsMessages(new Request(`https://shiba.example${TEAMS_MESSAGES_PATH}`), env)).toBeNull();
  });

  it("refuses unauthenticated activities with the real transport", async () => {
    const response = await handleTeamsMessages(post(activity(mention(`${REPO} fix it`))), env);
    expect(response?.status).toBe(401);
    expect((await handleTeamsMessages(post(activity({})), {} as Env))?.status).toBe(503);
  });

  it("queues on the conversation orchestrator and replies with an approval card", async () => {
    const { deps, posts, runBodies, resolveOrchestrator } = makeDeps();
    const response = await handleTeamsMessages(post(activity(mention(`${REPO} fix the build`))), env, undefined, deps);
    expect(response?.status).toBe(200);
    expect(resolveOrchestrator).toHaveBeenCalledWith(expect.stringMatching(/^teams:task-[0-9a-f]{64}$/));
    expect(runBodies[0]).toMatchObject({ repoUrl: REPO, task: "fix the build", source: "teams", publishPullRequest: true });
    const card = posts[0]!;
    expect(card.replyToMessageId).toBe("act-1");
    const native = card.native as { attachments: Array<{ content: { body: Array<{ text: string }>; actions: Array<{ title: string; data: { shiba: string } }> } }> };
    expect(native.attachments[0]?.content.body[0]?.text).toContain("Publication requested. A separate approval is required after the changes are ready.");
    const actions = native.attachments[0]?.content.actions ?? [];
    expect(actions.map((a) => [a.title, a.data.shiba])).toEqual([["Approve", `approve:${APPROVAL_ID}`], ["Reject", `reject:${APPROVAL_ID}`]]);
  });

  it("ignores channel chatter that does not address the bot", async () => {
    const { deps, posts, runBodies } = makeDeps();
    await handleTeamsMessages(post(activity({ text: `${REPO} fix it` })), env, undefined, deps);
    expect(posts).toEqual([]);
    expect(runBodies).toEqual([]);
  });

  it("dedupes redelivered activities", async () => {
    const { deps, runBodies } = makeDeps();
    const body = activity(mention(`${REPO} fix it`));
    await handleTeamsMessages(post(body), env, undefined, deps);
    await handleTeamsMessages(post(body), env, undefined, deps);
    expect(runBodies).toHaveLength(1);
  });

  it("lets an approver decide and updates the card", async () => {
    const { deps, approvalBodies, edits } = makeDeps();
    await handleTeamsMessages(post(activity(mention(`${REPO} fix it`))), env, undefined, deps);
    await handleTeamsMessages(post(activity({ id: "act-3", replyToId: "act-2", value: { shiba: `approve:${APPROVAL_ID}`, card: "Approval requested" } })), env, undefined, deps);
    expect(approvalBodies[0]).toMatchObject({ approvalId: APPROVAL_ID, approved: true, decidedBy: "teams:aad-ana" });
    expect(edits[0]).toMatchObject({ ref: { placeId: CONVERSATION, messageId: "act-2" } });
    expect(edits[0]!.text).toContain("Approved by Ana");
  });

  it("posts a publication approval and repoints the conversation approval pointer", async () => {
    const posts: ChannelPostInput[] = [];
    const adapter = {
      channel: "teams",
      capabilities: new Set(["post"]),
      post: vi.fn(async (input: ChannelPostInput) => {
        posts.push(input);
        return { placeId: input.placeId, messageId: "publication-card-1" };
      }),
    } as unknown as ChannelAdapter;
    const threadKey = "teams:task-publication-fixture";
    fixture.sqlite.prepare(`INSERT INTO teams_task_replies
      (thread_key,generation,conversation_id,activity_id,service_url,bot_id,recipient_id,approval_id,card_activity_id)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(threadKey, "fixture-generation", CONVERSATION, "source-activity", "https://smba.trafficmanager.net/teams/", "28:bot", "29:ana", "initial-approval", "initial-card");

    const posted = await postTeamsPublicationApproval(env, threadKey, "Publish pull request: fix the build", "pr-publish:run-1", { adapter });

    expect(posted).toBe(true);
    expect(posts[0]).toMatchObject({ placeId: CONVERSATION, replyToMessageId: "source-activity", text: "" });
    const native = posts[0]!.native as { attachments: Array<{ content: { actions: Array<{ title: string; data: { shiba: string } }> } }> };
    expect(native.attachments[0]?.content.actions.map((action) => [action.title, action.data.shiba])).toEqual([
      ["Approve", "approve:pr-publish:run-1"],
      ["Reject", "reject:pr-publish:run-1"],
    ]);
    const row = fixture.sqlite.prepare("SELECT approval_id, card_activity_id FROM teams_task_replies WHERE thread_key=?").get(threadKey) as { approval_id: string; card_activity_id: string };
    expect(row).toEqual({ approval_id: "pr-publish:run-1", card_activity_id: "publication-card-1" });
  });

  it("refuses a decision from someone off the approver list", async () => {
    const { deps, approvalBodies, posts } = makeDeps();
    await handleTeamsMessages(post(activity({
      id: "act-4",
      from: { id: "29:eve", aadObjectId: "aad-eve" },
      value: { shiba: `approve:${APPROVAL_ID}` },
    })), env, undefined, deps);
    expect(approvalBodies).toEqual([]);
    expect(posts[0]!.text).toBe("You are not on the approver list.");
  });
});
