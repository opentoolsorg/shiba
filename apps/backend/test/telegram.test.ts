import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSeenTelegramUpdates,
  handleTelegramWebhook,
  postTelegramPublicationApproval,
  TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
  TELEGRAM_SECRET_HEADER,
  TELEGRAM_WEBHOOK_PATH,
  telegramDecisionData,
  type TelegramDeps,
} from "../src/telegram.js";
import type { OrchestratorStub } from "../src/chat-lane.js";
import type { ChannelAdapter, ChannelPostInput } from "../src/ports/channel/index.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const REPO = "https://github.com/owner/repo";
const APPROVAL_ID = "a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6";
const SECRET = "hook-secret";
const CHAT_ID = -100123;

type BotCall = { method: string; body: Record<string, unknown> };

function env(overrides: Record<string, unknown> = {}) {
  return {
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    ...overrides,
  } as never;
}

function webhookRequest(update: unknown, secret: string | null = SECRET) {
  return new Request(`https://worker.test${TELEGRAM_WEBHOOK_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret === null ? {} : { [TELEGRAM_SECRET_HEADER]: secret }),
    },
    body: typeof update === "string" ? update : JSON.stringify(update),
  });
}

function messageUpdate(text: string, overrides: Record<string, unknown> = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: CHAT_ID },
      from: { id: 42, username: "alice" },
      text,
      ...overrides,
    },
  };
}

function callbackUpdate(data: string, userId = 42) {
  return {
    update_id: 2,
    callback_query: {
      id: "cbq-1",
      from: { id: userId, username: "alice" },
      data,
      message: { message_id: 10, chat: { id: CHAT_ID }, text: "Approval requested" },
    },
  };
}

function makeDeps(overrides: Partial<TelegramDeps> = {}) {
  const calls: BotCall[] = [];
  const call = vi.fn(async (method: string, body: Record<string, unknown>) => {
    calls.push({ method, body });
    return { ok: true };
  });
  const runBodies: Record<string, unknown>[] = [];
  const approvalBodies: Record<string, unknown>[] = [];
  const stub: OrchestratorStub = {
    fetch: async (request: Request) => {
      const url = request.url;
      const body = (await request.json()) as Record<string, unknown>;
      if (url.endsWith("/api/runs")) {
        runBodies.push(body);
        return Response.json({ ok: true, approvalId: APPROVAL_ID });
      }
      approvalBodies.push(body);
      return Response.json({ result: (body.approved as boolean) ? "approved" : "rejected" });
    },
  };
  const resolveOrchestrator = vi.fn(async () => stub);
  return {
    calls,
    runBodies,
    approvalBodies,
    resolveOrchestrator,
    deps: { call, resolveOrchestrator, ...overrides } satisfies TelegramDeps,
  };
}

describe("handleTelegramWebhook routing and auth", () => {
  beforeEach(() => {
    clearSeenTelegramUpdates();
  });

  it("returns null for a different path so other routes can handle it", async () => {
    const request = new Request("https://worker.test/api/other", { method: "POST", body: "{}" });
    expect(await handleTelegramWebhook(request, env())).toBeNull();
  });

  it("returns null for a GET on the webhook path", async () => {
    const request = new Request(`https://worker.test${TELEGRAM_WEBHOOK_PATH}`, { method: "GET" });
    expect(await handleTelegramWebhook(request, env())).toBeNull();
  });

  it("503s when the bot token is missing", async () => {
    const response = await handleTelegramWebhook(webhookRequest(messageUpdate("/start")), env({ TELEGRAM_BOT_TOKEN: "" }));
    expect(response?.status).toBe(503);
  });

  it("503s when the webhook secret is missing", async () => {
    const response = await handleTelegramWebhook(
      webhookRequest(messageUpdate("/start")),
      env({ TELEGRAM_WEBHOOK_SECRET: undefined }),
    );
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ error: expect.stringContaining("TELEGRAM_WEBHOOK_SECRET") });
  });

  it("401s when the secret header is wrong", async () => {
    const { deps, calls } = makeDeps();
    const response = await handleTelegramWebhook(webhookRequest(messageUpdate("/start"), "wrong-secret"), env(), undefined, deps);
    expect(response?.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("401s when the secret header is absent", async () => {
    const response = await handleTelegramWebhook(webhookRequest(messageUpdate("/start"), null), env());
    expect(response?.status).toBe(401);
  });

  it("400s when the body is not JSON", async () => {
    const request = new Request(`https://worker.test${TELEGRAM_WEBHOOK_PATH}`, {
      method: "POST",
      headers: { [TELEGRAM_SECRET_HEADER]: SECRET },
      body: "not json{{",
    });
    const response = await handleTelegramWebhook(request, env());
    expect(response?.status).toBe(400);
  });

  it("acks updates without an update_id", async () => {
    const { deps, calls } = makeDeps();
    const response = await handleTelegramWebhook(webhookRequest({ message: {} }), env(), undefined, deps);
    expect(response?.status).toBe(200);
    expect(calls).toHaveLength(0);
  });
});

describe("handleTelegramWebhook messages", () => {
  it("queues a Sales report without a repo in the requesting topic and shows the files before approval", async () => {
    const { database } = customAgentD1();
    const runtime = env({ AGENT_AUDIT: database });
    const employee = await createCustomAgent(runtime, "self-hosted", "sales-report", {
      name: "Sales report", harness: "opencode", instructions: "Reconcile supplied figures.",
      expectedDeliverables: ["report.pdf", "sales.xlsx"],
    });
    const { deps, runBodies, calls } = makeDeps();
    const response = await handleTelegramWebhook(webhookRequest(messageUpdate("/shiba employee:sales-report Compare Q1 and Q2.", { message_thread_id: 71 })), runtime, undefined, deps);
    expect(response?.status).toBe(200);
    expect(runBodies).toEqual([expect.objectContaining({
      threadKey: `telegram:${CHAT_ID}:71`, customAgentId: employee.id, repoUrl: "", publishPullRequest: false,
      executionTarget: { kind: "artifact-workspace", workspaceName: "sales-report-workspace", expectedDeliverables: ["report.pdf", "sales.xlsx"] },
    })]);
    expect(calls[0]?.body).toMatchObject({ message_thread_id: 71, text: expect.stringContaining("report.pdf, sales.xlsx") });
  });
  beforeEach(() => {
    clearSeenTelegramUpdates();
  });

  it("replies to /start with usage and the approval note", async () => {
    const { deps, calls } = makeDeps();
    const response = await handleTelegramWebhook(webhookRequest(messageUpdate("/start")), env(), undefined, deps);
    expect(response?.status).toBe(200);
    expect(calls[0]!.method).toBe("sendMessage");
    expect(String(calls[0]!.body.text)).toContain("/shiba");
    expect(String(calls[0]!.body.text)).toContain("Approve");
  });

  it("acks non-command text without any bot API call", async () => {
    const { deps, calls } = makeDeps();
    const response = await handleTelegramWebhook(webhookRequest(messageUpdate("hello world")), env(), undefined, deps);
    expect(response?.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("does not treat /shibabot as the command", async () => {
    const { deps, calls } = makeDeps();
    await handleTelegramWebhook(webhookRequest(messageUpdate("/shibabot fix it")), env(), undefined, deps);
    expect(calls).toHaveLength(0);
  });

  it("queues a run and sends the approval card on /shiba", async () => {
    const { deps, calls, runBodies, resolveOrchestrator } = makeDeps();
    const response = await handleTelegramWebhook(
      webhookRequest(messageUpdate(`/shiba ${REPO} fix the login bug`)),
      env(),
      undefined,
      deps,
    );
    expect(response?.status).toBe(200);
    expect(resolveOrchestrator).toHaveBeenCalledWith(`telegram:${CHAT_ID}`);
    expect(runBodies[0]).toMatchObject({
      repoUrl: REPO,
      task: "fix the login bug",
      threadKey: `telegram:${CHAT_ID}`,
      source: "telegram",
      user_id: "42",
      publishPullRequest: true,
    });
    const card = calls.find((c) => c.body.reply_markup !== undefined);
    expect(card?.body.text).toBe(`Approval requested\nRepo: ${REPO}\nTask: fix the login bug\nPublication requested. A separate approval is required after the changes are ready.\napproval ${APPROVAL_ID}`);
    const keyboard = (card!.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
    expect(keyboard[0]!.map((b) => b.callback_data)).toEqual([
      `approve:${APPROVAL_ID}`,
      `reject:${APPROVAL_ID}`,
    ]);
  });

  it("supports the /shiba@BotName form", async () => {
    const { deps, runBodies } = makeDeps();
    await handleTelegramWebhook(
      webhookRequest(messageUpdate(`/shiba@ShibaBot ${REPO} fix it`)),
      env(),
      undefined,
      deps,
    );
    expect(runBodies[0]).toMatchObject({ repoUrl: REPO, task: "fix it" });
  });

  it("uses TELEGRAM_CHAT_REPOS when the command has no URL", async () => {
    const { deps, runBodies } = makeDeps();
    await handleTelegramWebhook(
      webhookRequest(messageUpdate("/shiba fix this")),
      env({ TELEGRAM_CHAT_REPOS: JSON.stringify({ [CHAT_ID]: REPO }) }),
      undefined,
      deps,
    );
    expect(runBodies[0]?.repoUrl).toBe(REPO);
  });

  it("replies with usage when the repo cannot be resolved", async () => {
    const { deps, calls, runBodies } = makeDeps();
    await handleTelegramWebhook(webhookRequest(messageUpdate("/shiba fix this")), env(), undefined, deps);
    expect(runBodies).toHaveLength(0);
    expect(String(calls[0]!.body.text)).toContain("No repository");
    expect(String(calls[0]!.body.text)).toContain("TELEGRAM_CHAT_REPOS");
  });

  it("replies with the error when queueing fails", async () => {
    const { deps, calls } = makeDeps({
      resolveOrchestrator: async () => ({
        fetch: async () => Response.json({ error: "GITHUB_TOKEN is not set" }, { status: 500 }),
      }),
    });
    await handleTelegramWebhook(
      webhookRequest(messageUpdate(`/shiba ${REPO} fix it`)),
      env(),
      undefined,
      deps,
    );
    expect(String(calls[0]!.body.text)).toContain("Failed to queue the task");
    expect(String(calls[0]!.body.text)).toContain("GITHUB_TOKEN is not set");
  });

  it("ignores messages missing chat or message ids", async () => {
    const { deps, calls } = makeDeps();
    await handleTelegramWebhook(
      webhookRequest(messageUpdate("/start", { message_id: "not-a-number" })),
      env(),
      undefined,
      deps,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("postTelegramPublicationApproval", () => {
  function capturePosts() {
    const posts: ChannelPostInput[] = [];
    const adapter = {
      post: vi.fn(async (input: ChannelPostInput) => {
        posts.push(input);
        return {
          placeId: input.placeId,
          messageId: `publication-message-${posts.length}`,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        };
      }),
    } as unknown as ChannelAdapter;
    return { posts, adapter };
  }

  it("posts compact publication buttons inside Telegram's callback budget to the source topic", async () => {
    const approvalId = `pr-publish:agent-tool:${APPROVAL_ID}`;
    const { posts, adapter } = capturePosts();
    const posted = await postTelegramPublicationApproval(
      env(),
      `telegram:${CHAT_ID}:71`,
      "External Action: Publish the frozen snapshot.",
      approvalId,
      { adapter },
    );
    expect(posted).toBe(true);
    expect(posts[0]).toMatchObject({
      placeId: String(CHAT_ID),
      threadId: "71",
      text: "External Action: Publish the frozen snapshot.",
    });
    const keyboard = (posts[0]?.native?.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
    const callbackData = keyboard[0]!.map((button) => button.callback_data);
    expect(callbackData).toEqual([`a:${approvalId}`, `r:${approvalId}`]);
    for (const data of callbackData) {
      expect(new TextEncoder().encode(data).byteLength).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_LIMIT_BYTES);
    }
  });

  it("uses the legacy spelling when an initial approval already fits", () => {
    expect(telegramDecisionData(true, APPROVAL_ID)).toBe(`approve:${APPROVAL_ID}`);
    expect(telegramDecisionData(false, APPROVAL_ID)).toBe(`reject:${APPROVAL_ID}`);
  });

  it("fails closed with an explicit no-button notice when even the compact pointer cannot fit", async () => {
    const approvalId = `pr-publish:agent-tool:${APPROVAL_ID}${"x".repeat(20)}`;
    const { posts, adapter } = capturePosts();
    const posted = await postTelegramPublicationApproval(
      env(),
      `telegram:${CHAT_ID}`,
      "External Action: Publish the frozen snapshot.",
      approvalId,
      { adapter },
    );
    expect(posted).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.native).toBeUndefined();
    expect(posts[0]?.text).toContain("Telegram cannot carry this exact approval pointer in a button");
    expect(posts[0]?.text).toContain("No Telegram approval action was enabled");
    expect(posts[0]?.text.length).toBeLessThanOrEqual(4000);
  });
});

describe("handleTelegramWebhook callbacks", () => {
  beforeEach(() => {
    clearSeenTelegramUpdates();
  });

  it("approves a pending run for a listed approver and retires the buttons", async () => {
    const { deps, calls, approvalBodies } = makeDeps();
    const response = await handleTelegramWebhook(
      webhookRequest(callbackUpdate(`approve:${APPROVAL_ID}`)),
      env({ TELEGRAM_APPROVERS: "7, 42" }),
      undefined,
      deps,
    );
    expect(response?.status).toBe(200);
    expect(approvalBodies[0]).toEqual({
      threadKey: `telegram:${CHAT_ID}`,
      approvalId: APPROVAL_ID,
      approved: true,
      decidedBy: "telegram:42",
      source: "telegram",
    });
    const answered = calls.find((c) => c.method === "answerCallbackQuery");
    expect(answered?.body.text).toBe("Approved — run starting.");
    const edit = calls.find((c) => c.method === "editMessageText");
    expect(edit?.body.text).toContain("Approved by @alice — run starting.");
    expect(edit?.body).not.toHaveProperty("reply_markup");
  });

  it("resolves a compact publication callback to the full approval pointer", async () => {
    const approvalId = `pr-publish:agent-tool:${APPROVAL_ID}`;
    const { deps, approvalBodies } = makeDeps();
    const response = await handleTelegramWebhook(
      webhookRequest(callbackUpdate(`a:${approvalId}`)),
      env({ TELEGRAM_APPROVERS: "42" }),
      undefined,
      deps,
    );
    expect(response?.status).toBe(200);
    expect(approvalBodies[0]).toEqual({
      threadKey: `telegram:${CHAT_ID}`,
      approvalId,
      approved: true,
      decidedBy: "telegram:42",
      source: "telegram",
    });
  });

  it("rejects a pending run for a listed approver", async () => {
    const { deps, calls, approvalBodies } = makeDeps();
    await handleTelegramWebhook(
      webhookRequest(callbackUpdate(`reject:${APPROVAL_ID}`)),
      env({ TELEGRAM_APPROVERS: "42" }),
      undefined,
      deps,
    );
    expect(approvalBodies[0]).toMatchObject({ approved: false });
    const answered = calls.find((c) => c.method === "answerCallbackQuery");
    expect(answered?.body.text).toBe("Rejected — no run started.");
    const edit = calls.find((c) => c.method === "editMessageText");
    expect(edit?.body.text).toContain("Rejected by @alice — no run started.");
  });

  it("alerts a user who is not on the approver list", async () => {
    const { deps, calls, approvalBodies } = makeDeps();
    await handleTelegramWebhook(
      webhookRequest(callbackUpdate(`approve:${APPROVAL_ID}`, 99)),
      env({ TELEGRAM_APPROVERS: "42" }),
      undefined,
      deps,
    );
    expect(approvalBodies).toHaveLength(0);
    const answered = calls.find((c) => c.method === "answerCallbackQuery");
    expect(answered?.body).toMatchObject({ text: "You are not on the approver list.", show_alert: true });
  });

  it("alerts everyone when the approver list is empty", async () => {
    const { deps, calls, approvalBodies } = makeDeps();
    await handleTelegramWebhook(webhookRequest(callbackUpdate(`approve:${APPROVAL_ID}`)), env(), undefined, deps);
    expect(approvalBodies).toHaveLength(0);
    const answered = calls.find((c) => c.method === "answerCallbackQuery");
    expect(answered?.body.text).toBe("You are not on the approver list.");
  });

  it("alerts on callback data that is not a decision pointer", async () => {
    const { deps, calls, approvalBodies } = makeDeps();
    await handleTelegramWebhook(
      webhookRequest(callbackUpdate("totally-unrelated")),
      env({ TELEGRAM_APPROVERS: "42" }),
      undefined,
      deps,
    );
    expect(approvalBodies).toHaveLength(0);
    const answered = calls.find((c) => c.method === "answerCallbackQuery");
    expect(answered?.body).toMatchObject({ text: "This button is not a Shiba approval.", show_alert: true });
  });

  it("reports an already-resolved pointer instead of editing the card", async () => {
    const { deps, calls } = makeDeps({
      resolveOrchestrator: async () => ({
        fetch: async () => Response.json({ result: "unknown" }),
      }),
    });
    await handleTelegramWebhook(
      webhookRequest(callbackUpdate(`approve:${APPROVAL_ID}`)),
      env({ TELEGRAM_APPROVERS: "42" }),
      undefined,
      deps,
    );
    const answered = calls.find((c) => c.method === "answerCallbackQuery");
    expect(String(answered?.body.text)).toContain("already resolved or expired");
    expect(calls.some((c) => c.method === "editMessageText")).toBe(false);
  });

  it("still answers the callback when the card edit fails", async () => {
    const calls: BotCall[] = [];
    const deps: TelegramDeps = {
      call: async (method: string, body: Record<string, unknown>) => {
        calls.push({ method, body });
        if (method === "editMessageText") throw new Error("message is not modified");
        return { ok: true };
      },
      resolveOrchestrator: async () => ({
        fetch: async () => Response.json({ result: "approved" }),
      }),
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await handleTelegramWebhook(
        webhookRequest(callbackUpdate(`approve:${APPROVAL_ID}`)),
        env({ TELEGRAM_APPROVERS: "42" }),
        undefined,
        deps,
      );
      expect(response?.status).toBe(200);
      const answered = calls.find((c) => c.method === "answerCallbackQuery");
      expect(answered?.body.text).toBe("Approved — run starting.");
      expect(error).toHaveBeenCalledOnce();
      const record = JSON.parse(String(error.mock.calls[0]?.[0])) as { msg?: string; detail?: string };
      expect(record.msg).toBe("Telegram approval card update failed");
      expect(record.detail).toEqual(expect.any(String));
    } finally {
      error.mockRestore();
    }
  });
});

describe("handleTelegramWebhook dedupe", () => {
  beforeEach(() => {
    clearSeenTelegramUpdates();
  });

  it("acks a redelivered update_id without re-running the handler", async () => {
    const { deps, calls } = makeDeps();
    const update = messageUpdate("/start");
    const first = await handleTelegramWebhook(webhookRequest(update), env(), undefined, deps);
    const second = await handleTelegramWebhook(webhookRequest(update), env(), undefined, deps);
    expect(first?.status).toBe(200);
    expect(second?.status).toBe(200);
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
  });

  it("asks the dedupe dep and skips already-recorded updates", async () => {
    const { deps, calls } = makeDeps({ dedupe: async () => true });
    const response = await handleTelegramWebhook(webhookRequest(messageUpdate("/start")), env(), undefined, deps);
    expect(response?.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("processes the update when the dedupe dep records a new id", async () => {
    const dedupe = vi.fn(async () => false);
    const { deps, calls } = makeDeps({ dedupe });
    await handleTelegramWebhook(webhookRequest(messageUpdate("/start")), env(), undefined, deps);
    expect(dedupe).toHaveBeenCalledWith("1");
    expect(calls.some((c) => c.method === "sendMessage")).toBe(true);
  });

  it("acks anyway when the dedupe backend is down", async () => {
    const { deps, calls } = makeDeps({
      dedupe: async () => {
        throw new Error("kv down");
      },
    });
    const response = await handleTelegramWebhook(webhookRequest(messageUpdate("/start")), env(), undefined, deps);
    expect(response?.status).toBe(200);
    expect(calls.some((c) => c.method === "sendMessage")).toBe(true);
  });
});
