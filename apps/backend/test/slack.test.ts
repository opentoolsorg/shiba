import { describe, expect, it, vi } from "vitest";
import { verifySlackCanvasIntake } from "../src/slack-canvas.js";
import { handleSlackCommand, parseSlackCommand } from "../src/slack-routes.js";
import { postSlackMessageWithReceipt, createSlackRunProgress, SlackPostRejectedError, verifySlackBotInstallation, verifySlackRequest } from "../src/slack.js";

const SECRET = "test-signing-secret-abc123";

async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  );
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `v0=${hex}`;
}

function headers(timestamp: string, signature: string): Headers {
  return new Headers({
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
  });
}

describe("verifySlackRequest", () => {
  it("verifies valid Slack signature", async () => {
    const body = "token=abc&team_id=T123&command=%2Fshiba&text=fix+this";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await sign(SECRET, timestamp, body);
    await expect(verifySlackRequest(body, headers(timestamp, signature), SECRET)).resolves.toBe(true);
  });

  it("rejects a tampered body", async () => {
    const body = "command=%2Fshiba&text=fix+this";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await sign(SECRET, timestamp, body);
    await expect(
      verifySlackRequest(`${body}&tampered=true`, headers(timestamp, signature), SECRET),
    ).resolves.toBe(false);
  });

  it("rejects a 6-minute-old timestamp (replay protection)", async () => {
    const body = "command=%2Fshiba&text=fix+this";
    const timestamp = String(Math.floor(Date.now() / 1000) - 360);
    const signature = await sign(SECRET, timestamp, body);
    await expect(verifySlackRequest(body, headers(timestamp, signature), SECRET)).resolves.toBe(false);
  });

  it("rejects missing headers and missing secret", async () => {
    const body = "command=%2Fshiba&text=fix+this";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await sign(SECRET, timestamp, body);
    await expect(verifySlackRequest(body, new Headers(), SECRET)).resolves.toBe(false);
    await expect(verifySlackRequest(body, headers(timestamp, signature), "")).resolves.toBe(false);
  });
});

describe("verified Slack installation lookup", () => {
  it("uses the configured bot token against auth.test and returns Slack's workspace identity", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://slack.com/api/auth.test");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer xoxb-mock-only");
      return new Response(JSON.stringify({ ok: true, team_id: "T123", user_id: "W123", bot_id: "B123" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(verifySlackBotInstallation("xoxb-mock-only")).resolves.toEqual({
        teamId: "T123", userId: "W123", botId: "B123",
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a user-token identity without Slack's bot_id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: true, team_id: "T123", user_id: "U123",
    }), { status: 200 })));
    try {
      await expect(verifySlackBotInstallation("xoxp-mock-only")).rejects.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("posts through the existing Slack transport with a stable dedupe key and returns the receipt", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://slack.com/api/chat.postMessage");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer xoxb-mock-only");
      expect(JSON.parse(String(init?.body))).toEqual({
        channel: "C123", thread_ts: "1710000000.000100", client_msg_id: "00000000-0000-4000-8000-000000000001",
        text: "Approved room message", username: "Shiba Lead", icon_emoji: ":dog:",
      });
      return new Response(JSON.stringify({ ok: true, channel: "C123", ts: "1710000009.000900" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(postSlackMessageWithReceipt("xoxb-mock-only", {
        channel: "C123", threadTs: "1710000000.000100", text: "Approved room message",
        clientMsgId: "00000000-0000-4000-8000-000000000001",
      })).resolves.toEqual({ channel: "C123", ts: "1710000009.000900" });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Slack post outcome classification", () => {
  it.each(["{\"ok\":true,", ""])("treats unreadable HTTP 200 response %j as unknown", async (body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
    try {
      await expect(postSlackMessageWithReceipt("xoxb-mock-only", {
        channel: "C123", threadTs: "1710000000.000100", text: "Approved content",
      })).rejects.toThrow(/unknown/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("classifies a valid Slack ok:false response as an explicit known rejection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), { status: 200 })));
    try {
      let caught: unknown;
      try {
        await postSlackMessageWithReceipt("xoxb-mock-only", { channel: "C123", text: "Approved content" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SlackPostRejectedError);
      expect(caught).toMatchObject({ outcomeKnown: true, message: "not_in_channel" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("slack slash command", () => {
  const ROUTE_SECRET = "test-route-signing-secret";

  async function signedCommandRequest(
    params: Record<string, string>,
    secret = ROUTE_SECRET,
  ): Promise<Request> {
    const body = new URLSearchParams({ team_id: "T123", channel_id: "C456", ...params }).toString();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await sign(secret, timestamp, body);
    return new Request("https://example.com/api/slack/command", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...Object.fromEntries(headers(timestamp, signature)),
      },
      body,
    });
  }

  function routeEnv(overrides: Record<string, unknown> = {}) {
    return { SLACK_SIGNING_SECRET: ROUTE_SECRET, CodingOrchestrator: {}, ...overrides } as never;
  }

  it("routes slash command to orchestrator and returns Task queued", async () => {
    const request = await signedCommandRequest({
      command: "/shiba",
      text: "https://github.com/owner/repo Fix the login bug",
      user_id: "U123",
      channel_id: "C456",
    });
    const fetchMock = vi.fn(
      async (_req: Request) => new Response(JSON.stringify({ ok: true, approvalId: "a-77" }), { status: 200 }),
    );
    const response = await handleSlackCommand(request, routeEnv(), {
      orchestratorStub: { fetch: fetchMock },
    });
    expect(response).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    const forwarded = fetchMock.mock.calls[0]?.[0] as unknown as Request;
    const payload = (await forwarded.json()) as { repoUrl: string; task: string; threadKey: string };
    expect(payload.repoUrl).toBe("https://github.com/owner/repo");
    expect(payload.threadKey).toBe("slack-command:T123:C456");
    expect(payload.task).toContain("Fix the login bug");
    expect(response!.status).toBe(200);
    // The queued reply carries the approval card so a human can act on it.
    const body = (await response!.json()) as { text?: string; blocks?: { type: string; elements?: unknown[] }[] };
    expect(body.text).toContain("Task queued");
    const actions = body.blocks?.find((b) => b.type === "actions");
    expect(JSON.stringify(actions)).toContain("a-77");
    expect(JSON.stringify(actions)).toContain("slack-command:T123:C456");
  });

  it("seals configured canvas origin only after verifying the Slack command", async () => {
    const key = "canvas-intake-signing-key-at-least-32-chars";
    const configured = routeEnv({ INTERNAL_SIGNING_KEY: key, WORKER_HOSTNAME: "shiba.test", SLACK_CANVAS_OWNERS: JSON.stringify([
      { teamId: "T123", channelId: "C456", ownerId: "owner@example.test" },
    ]) });
    const fetchMock = vi.fn(async (request: Request) => {
      expect(await verifySlackCanvasIntake(request, key, "default")).toBe("slack-command:T123:C456");
      expect(await request.json()).toMatchObject({ threadKey: "slack-command:T123:C456", task: "Fix it" });
      return Response.json({ approvalId: "canvas-approval" });
    });
    const request = await signedCommandRequest({ command: "/shiba", text: "https://github.com/o/r Fix it" });
    const response = await handleSlackCommand(request, configured, { orchestratorStub: { fetch: fetchMock } });
    expect(response?.status).toBe(200);
    expect(JSON.stringify(await response?.json())).toContain("Live Web Canvas");
    expect(fetchMock).toHaveBeenCalledOnce();
    const forged = await signedCommandRequest({ command: "/shiba", text: "https://github.com/o/r Fix it" }, "wrong-secret");
    expect((await handleSlackCommand(forged, configured, { orchestratorStub: { fetch: fetchMock } }))?.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps canvas disabled for an unconfigured origin while preserving Slack intake", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request.headers.get("X-Shiba-Slack-Canvas-Origin")).toBeNull();
      return Response.json({ approvalId: "normal-approval" });
    });
    const response = await handleSlackCommand(await signedCommandRequest({ command: "/shiba", text: "https://github.com/o/r Fix it" }), routeEnv({ WORKER_HOSTNAME: "shiba.test" }), { orchestratorStub: { fetch: fetchMock } });
    expect(response?.status).toBe(200);
    const rendered = JSON.stringify(await response?.json());
    expect(rendered).not.toContain("Live Web Canvas");
    expect(rendered).toContain("Open Shiba");
  });

  it("preserves the queued approval and reports when private completion storage fails", async () => {
    const storage = { get: vi.fn(async () => null), put: vi.fn(async () => { throw new Error("Storage unavailable."); }) };
    const fetchMock = vi.fn(async () => Response.json({ approvalId: "saved-approval", approvalInputHash: "a".repeat(64) }));
    const response = await handleSlackCommand(await signedCommandRequest({ command: "/shiba", user_id: "U123", text: "https://github.com/o/r Fix it" }), routeEnv({ ATTACHMENTS: storage, SLACK_BOT_TOKEN: "xoxb-test" }), { orchestratorStub: { fetch: fetchMock } });
    const body = await response?.json() as { text?: string; blocks?: unknown[] };
    expect(body.text).toContain("safely queued for approval (saved-approval)");
    expect(body.text).toContain("completion delivery could not be prepared");
    expect(body.text).toContain("Storage unavailable");
    expect(body.blocks).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    { team_id: "", channel_id: "C456" },
    { team_id: "T123", channel_id: "" },
    { team_id: "T123:other", channel_id: "C456" },
    { team_id: "T123", channel_id: "C456\nother" },
  ])("refuses a signed command with an invalid origin %j without queueing", async (origin) => {
    const request = await signedCommandRequest({ command: "/shiba", text: "https://github.com/owner/repo Fix it", ...origin });
    const fetchMock = vi.fn(async () => Response.json({ approvalId: "never" }));
    const response = await handleSlackCommand(request, routeEnv(), { orchestratorStub: { fetch: fetchMock } });
    expect(response?.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid Slack signature with 401 and queues nothing", async () => {
    const request = await signedCommandRequest(
      { command: "/shiba", text: "https://github.com/owner/repo Fix it" },
      "wrong-secret",
    );
    const fetchMock = vi.fn(
      async (_req: Request) => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const response = await handleSlackCommand(request, routeEnv(), {
      orchestratorStub: { fetch: fetchMock },
    });
    expect(response?.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 200 with an ephemeral usage message when no GitHub URL is present", async () => {
    const request = await signedCommandRequest({
      command: "/shiba",
      text: "fix it please",
    });
    const fetchMock = vi.fn(
      async (_req: Request) => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const response = await handleSlackCommand(request, routeEnv(), {
      orchestratorStub: { fetch: fetchMock },
    });
    // A 400 renders Slack's generic "failed"; a 200 ephemeral carries the hint.
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as { response_type?: string; text?: string };
    expect(body.response_type).toBe("ephemeral");
    expect(body.text).toContain("Usage:");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("acks fast and delivers the card via response_url when ctx is provided", async () => {
    const responseUrl = "https://hooks.slack.com/commands/T1/123/token";
    const request = await signedCommandRequest({
      command: "/shiba",
      text: "https://github.com/owner/repo Fix the login bug",
      user_id: "U123",
      channel_id: "C456",
      response_url: responseUrl,
    });
    let releaseQueue!: (r: Response) => void;
    const fetchMock = vi.fn(
      async (_req: Request) =>
        new Promise<Response>((resolve) => {
          releaseQueue = resolve;
        }),
    );
    const respond = vi.fn(async (_url: string, _body: Record<string, unknown>): Promise<void> => {});
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) };
    const response = await handleSlackCommand(request, routeEnv(), {
      orchestratorStub: { fetch: fetchMock },
      respond,
    }, ctx);
    // The ack goes out before the orchestrator answers — under the 3s window.
    expect(response?.status).toBe(200);
    const ack = (await response!.json()) as { response_type?: string; text?: string };
    expect(ack.response_type).toBe("ephemeral");
    expect(respond).not.toHaveBeenCalled();
    releaseQueue(new Response(JSON.stringify({ ok: true, approvalId: "a-88" }), { status: 200 }));
    await Promise.all(pending);
    expect(respond).toHaveBeenCalledOnce();
    const [url, card] = respond.mock.calls[0] as [string, { text?: string; blocks?: unknown[] }];
    expect(url).toBe(responseUrl);
    expect(card.text).toContain("Task queued");
    expect(JSON.stringify(card.blocks)).toContain("a-88");
  });

  it("queues with mention-lane parity: publishPullRequest on, channel/user carried", async () => {
    const request = await signedCommandRequest({
      command: "/shiba",
      text: "https://github.com/owner/repo Fix it",
      user_id: "U123",
      channel_id: "C456",
    });
    const fetchMock = vi.fn(
      async (_req: Request) => new Response(JSON.stringify({ ok: true, approvalId: "a-1" }), { status: 200 }),
    );
    await handleSlackCommand(request, routeEnv(), { orchestratorStub: { fetch: fetchMock } });
    const forwarded = fetchMock.mock.calls[0]?.[0] as unknown as Request;
    const payload = (await forwarded.json()) as Record<string, unknown>;
    expect(payload.publishPullRequest).toBe(true);
    expect(payload.source).toBe("slack");
    expect(payload.channel_id).toBe("C456");
    expect(payload.user_id).toBe("U123");
  });

  it("reports a queue failure via response_url instead of a 502", async () => {
    const responseUrl = "https://hooks.slack.com/commands/T1/123/token";
    const request = await signedCommandRequest({
      command: "/shiba",
      text: "https://github.com/owner/repo Fix it",
      response_url: responseUrl,
    });
    const fetchMock = vi.fn(async (_req: Request) =>
      Response.json({ error: "publishPullRequest was requested but GITHUB_TOKEN is not configured." }, { status: 400 }),
    );
    const respond = vi.fn(async (_url: string, _body: Record<string, unknown>): Promise<void> => {});
    const pending: Promise<unknown>[] = [];
    const response = await handleSlackCommand(request, routeEnv(), {
      orchestratorStub: { fetch: fetchMock },
      respond,
    }, { waitUntil: (p) => pending.push(p) });
    expect(response?.status).toBe(200);
    await Promise.all(pending);
    expect(respond).toHaveBeenCalledOnce();
    const [, card] = respond.mock.calls[0] as [string, { text?: string }];
    expect(card.text).toMatch(/failed to queue/i);
    // The orchestrator's reason reaches the user — retrying won't fix a config error.
    expect(card.text).toContain("GITHUB_TOKEN");
  });

  it("without ctx, awaits the queue and returns the card inline even with a response_url", async () => {
    const request = await signedCommandRequest({
      command: "/shiba",
      text: "https://github.com/owner/repo Fix it",
      response_url: "https://hooks.slack.com/commands/T1/123/token",
    });
    const fetchMock = vi.fn(
      async (_req: Request) => new Response(JSON.stringify({ ok: true, approvalId: "a-2" }), { status: 200 }),
    );
    const respond = vi.fn(async (_url: string, _body: Record<string, unknown>): Promise<void> => {});
    const response = await handleSlackCommand(request, routeEnv(), {
      orchestratorStub: { fetch: fetchMock },
      respond,
    });
    const body = (await response!.json()) as { text?: string; blocks?: unknown[] };
    expect(body.text).toContain("Task queued");
    expect(JSON.stringify(body.blocks)).toContain("a-2");
    expect(respond).not.toHaveBeenCalled();
  });

  it("ignores non-slash-command paths", async () => {
    const request = new Request("https://example.com/api/runs", { method: "GET" });
    const response = await handleSlackCommand(request, routeEnv(), {
      orchestratorStub: { fetch: vi.fn() },
    });
    expect(response).toBeNull();
  });
});


describe("Slack in-thread progress cards", () => {
  it("posts one Fixer card and updates that receipt in place", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({ ok: true, channel: "C1", ts: "123.456" });
    }));
    try {
      const reporter = createSlackRunProgress("xoxb-test", { channelId: "C1", threadTs: "100.200" });
      await reporter.onEvent({ phase: "clone", message: "cloning" });
      await reporter.onEvent({ phase: "code", message: "working" });
      await reporter.onEvent({ phase: "collect", message: "complete" });
      await reporter.finish("completed");
      await reporter.finish("completed");
      await reporter.onEvent({ phase: "code", message: "late update" });
      expect(calls.map((call) => call.url)).toEqual(["https://slack.com/api/chat.postMessage", "https://slack.com/api/chat.update", "https://slack.com/api/chat.update", "https://slack.com/api/chat.update"]);
      expect(calls[0]?.body).toMatchObject({ username: "Shiba Fixer", icon_emoji: ":hammer_and_wrench:", thread_ts: "100.200" });
      expect(calls[1]?.body).toMatchObject({ channel: "C1", ts: "123.456" });
      expect(JSON.stringify(calls[2]?.body.blocks)).toContain("☑ Prepare workspace");
      expect(JSON.stringify(calls[3]?.body.blocks)).toContain("Run completed");
      expect(JSON.stringify(calls[3]?.body.blocks)).toContain("☑ Collect deliverables");
      expect(JSON.stringify(calls[3]?.body.blocks)).not.toContain("(running)");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not repost a status card after delivery becomes uncertain", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("connection lost after write"); });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const reporter = createSlackRunProgress("xoxb-test", { channelId: "C1", threadTs: "100.200" });
      await reporter.onEvent({ phase: "clone", message: "cloning" });
      await reporter.onEvent({ phase: "code", message: "working" });
      await reporter.onEvent({ phase: "collect", message: "complete" });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});


describe("ephemeral Slack slash command", () => {
  it("parses an explicit workspace without requiring a repository", () => {
    expect(parseSlackCommand("workspace:research-1 Summarize the market")).toEqual({ repoUrl: "", task: "Summarize the market", workspaceTarget: { type: "ephemeral", workspaceId: "research-1" } });
    expect(() => parseSlackCommand("workspace:research-1")).toThrow("Describe the task");
    expect(() => parseSlackCommand("workspace:bad/path Summarize the market")).toThrow("Usage");
  });
});
