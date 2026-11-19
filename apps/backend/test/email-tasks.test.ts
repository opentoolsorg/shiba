import { describe, expect, it, vi } from "vitest";
import type { OrchestratorStub } from "../src/chat-lane.js";
import {
  buildEmailEnvelope,
  createEmailAdapter,
  emailChannel,
  emailTransport,
  type EmailEnvelope,
} from "../src/channels/email/index.js";
import { handleEmailTaskRequest } from "../src/email-tasks.js";
import type { Env } from "../src/env.js";
import { ChannelUnsupportedError, type ChannelPostInput } from "../src/ports/channel/index.js";

const REPO = "https://github.com/owner/repo";
const APPROVAL_ID = "a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6";
const MAILBOX = "dev@shiba.example";
const PASS =
  "mx.cloudflare.net; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com";

function envelope(over: Partial<EmailEnvelope> = {}): EmailEnvelope {
  return {
    v: 1,
    messageId: "<m1@example.com>",
    from: "alice@example.com",
    to: MAILBOX,
    subject: `Fix the login redirect in ${REPO}`,
    text: "The callback drops the next= parameter.",
    autoSubmitted: false,
    ...over,
  };
}

function env(over: Record<string, unknown> = {}): Env {
  return {
    EMAIL_TASK_SENDERS: " Alice@Example.com , bob@corp.example",
    EMAIL_TASK_EMPLOYEES: JSON.stringify({ [MAILBOX]: "engineering" }),
    ...over,
  } as unknown as Env;
}

function headers(authResults: string | string[] = PASS): Headers {
  const h = new Headers();
  for (const value of [authResults].flat()) h.append("Authentication-Results", value);
  return h;
}

function harness() {
  const runBodies: Record<string, unknown>[] = [];
  const posts: ChannelPostInput[] = [];
  const stub: OrchestratorStub = {
    fetch: async (request: Request) => {
      runBodies.push((await request.json()) as Record<string, unknown>);
      return Response.json({ ok: true, approvalId: APPROVAL_ID, route: "opencode · github.com" });
    },
  };
  const adapter = {
    post: vi.fn(async (input: ChannelPostInput) => {
      posts.push(input);
      return { placeId: input.placeId, messageId: "<reply@shiba.example>" };
    }),
  };
  const postSlack = vi.fn(async () => undefined);
  return {
    runBodies,
    posts,
    postSlack,
    deps: {
      resolveOrchestrator: vi.fn(async () => stub),
      adapter: adapter as never,
      postSlack,
    },
  };
}

describe("email channel transport", () => {
  it("is registered on the channel port as a post-only channel", () => {
    const adapter = emailChannel.createAdapter({
      SEND_EMAIL: { send: vi.fn() },
    } as unknown as Env)!;
    expect([...adapter.capabilities]).toEqual(["post"]);
    expect(emailChannel.createAdapter({} as Env)).toBeNull();
  });

  it("is off until EMAIL_TASK_SENDERS is set", async () => {
    expect(
      await emailTransport.verify(JSON.stringify(envelope()), headers(), {} as Env),
    ).toMatchObject({ ok: false, status: 503 });
  });

  it("trusts only the first Authentication-Results header from mx.cloudflare.net", async () => {
    const body = JSON.stringify(envelope());
    expect(await emailTransport.verify(body, headers(), env())).toEqual({ ok: true });
    expect(await emailTransport.verify(body, new Headers(), env())).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(
      await emailTransport.verify(
        body,
        headers("mx.cloudflare.net; spf=pass; dkim=fail; dmarc=fail"),
        env(),
      ),
    ).toMatchObject({ ok: false, status: 401 });
    expect(
      await emailTransport.verify(
        body,
        headers("mx.cloudflare.net; spf=fail; dkim=fail; dmarc=pass"),
        env(),
      ),
    ).toMatchObject({ ok: false, status: 401 });
    // A sender-supplied header after Cloudflare's cannot upgrade the verdict.
    expect(
      await emailTransport.verify(
        body,
        headers([
          "mx.cloudflare.net; spf=none; dkim=none; dmarc=none",
          "mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass",
        ]),
        env(),
      ),
    ).toMatchObject({ ok: false, status: 401 });
    expect(
      await emailTransport.verify(body, headers("evil.example; dmarc=pass"), env()),
    ).toMatchObject({ ok: false, status: 401 });
  });

  it("refuses a verdict for a different From domain", async () => {
    const body = JSON.stringify(envelope({ from: "alice@other.example" }));
    expect(await emailTransport.verify(body, headers(), env())).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("parses mail into a message, never an action, with quoted history removed", () => {
    const event = emailTransport.parse(
      JSON.stringify(
        envelope({
          subject: "Re: Fwd: Ship the fix",
          text: "Please also add a test.\n\nOn Mon, Bob wrote:\n> old text\n",
          references: ["<root@example.com>"],
        }),
      ),
    );
    expect(event).toMatchObject({
      kind: "message",
      channel: "email",
      placeId: "alice@example.com",
      authorId: "alice@example.com",
      conversationKey: "email:alice@example.com",
      threadId: "<root@example.com>",
      text: "Ship the fix\n\nPlease also add a test.",
      isBot: false,
    });
    for (const raw of ["", "not json", "{}", "[]", "null"])
      expect(emailTransport.parse(raw)).toBeNull();
  });

  it("marks automated mail and builds envelopes only from a header From with a Message-ID", () => {
    const auto = buildEmailEnvelope({
      messageId: "m2@example.com",
      from: "Alice@Example.com",
      to: MAILBOX,
      headers: new Headers({ "Auto-Submitted": "auto-replied" }),
    });
    expect(auto).toMatchObject({
      messageId: "<m2@example.com>",
      from: "alice@example.com",
      autoSubmitted: true,
    });
    expect(
      buildEmailEnvelope({ to: MAILBOX, from: "alice@example.com", headers: new Headers() }),
    ).toBeNull();
    expect(
      buildEmailEnvelope({ to: MAILBOX, messageId: "<m3@x>", headers: new Headers() }),
    ).toBeNull();
  });
});

describe("email channel adapter", () => {
  it("sends a threaded, auto-replied message as the mailbox", async () => {
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: "x" }));
    const adapter = createEmailAdapter({ send } as unknown as SendEmail);
    const ref = await adapter.post({
      placeId: "alice@example.com",
      replyToMessageId: "<m1@example.com>",
      text: "hi",
      native: { from: MAILBOX, subject: "Re: hi" },
    });
    expect(ref.placeId).toBe("alice@example.com");
    expect(ref.messageId).toBe("x");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: MAILBOX,
        to: "alice@example.com",
        subject: "Re: hi",
        text: "hi",
        headers: expect.objectContaining({
          "In-Reply-To": "<m1@example.com>",
          "Auto-Submitted": "auto-replied",
        }),
      }),
    );
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty("headers.Message-ID");
    await expect(
      adapter.post({
        placeId: "alice@example.com",
        text: "x",
        native: { from: MAILBOX, subject: "a\r\nBcc: x@y.z" },
      }),
    ).rejects.toThrow(/single line/);
    await expect(adapter.edit({ ref, text: "x" })).rejects.toBeInstanceOf(ChannelUnsupportedError);
  });
});

describe("email task lane", () => {
  it("queues a pending approval on the shared orchestrator and replies that email cannot approve", async () => {
    const h = harness();
    const result = await handleEmailTaskRequest(
      env({
        WORKER_HOSTNAME: "shiba.example",
        SLACK_APPROVALS_CHANNEL: "C1",
        SLACK_BOT_TOKEN: "xoxb-test",
      }),
      { rawBody: JSON.stringify(envelope()), headers: headers() },
      h.deps,
    );
    expect(result).toEqual({ status: "queued", approvalId: APPROVAL_ID });
    expect(h.runBodies).toHaveLength(1);
    expect(h.runBodies[0]).toMatchObject({
      repoUrl: REPO,
      task: "Fix the login redirect in The callback drops the next= parameter.",
      threadKey: "default",
      source: "email",
      user_id: "alice@example.com",
      customAgentId: "engineering",
      publishPullRequest: false,
    });
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toMatchObject({
      placeId: "alice@example.com",
      replyToMessageId: "<m1@example.com>",
      native: { from: MAILBOX },
    });
    expect(h.posts[0]!.text).toContain(`Approval: ${APPROVAL_ID}`);
    expect(h.posts[0]!.text).toContain("Open Shiba: https://shiba.example/app/");
    expect(h.posts[0]!.text).toContain(
      "Replying to this email cannot approve or reject the request.",
    );
    expect(h.postSlack).toHaveBeenCalledTimes(1);
    const slack = (
      h.postSlack.mock.calls[0] as unknown as [string, { channel: string; blocks: unknown[] }]
    )[1];
    expect(slack.channel).toBe("C1");
    expect(JSON.stringify(slack.blocks)).toContain(
      JSON.stringify(JSON.stringify({ threadKey: "default", approvalId: APPROVAL_ID })).slice(
        1,
        -1,
      ),
    );
  });

  it("refuses an emailed decision without queueing or deciding anything", async () => {
    for (const text of ["Approve", "yes!", "LGTM\n\nOn Tue, Shiba wrote:\n> Approval: x"]) {
      const h = harness();
      const result = await handleEmailTaskRequest(
        env(),
        {
          rawBody: JSON.stringify(envelope({ subject: "Re: Your request", text })),
          headers: headers(),
        },
        h.deps,
      );
      expect(result.status).toBe("refused");
      expect(h.runBodies).toEqual([]);
      expect(h.posts[0]!.text).toContain("Email replies cannot approve or reject Shiba work.");
    }
  });

  it("stays silent for unlisted, unauthenticated, or automated senders and ordinary mailboxes", async () => {
    const cases: Array<[Record<string, unknown>, Partial<EmailEnvelope>, Headers]> = [
      [{}, { from: "mallory@example.com" }, headers()],
      [{}, {}, headers("mx.cloudflare.net; spf=pass; dmarc=fail")],
      [{}, { autoSubmitted: true }, headers()],
      [{ EMAIL_TASK_SENDERS: "" }, {}, headers()],
      [{}, { to: "ordinary@shiba.example" }, headers()],
    ];
    for (const [over, mail, h2] of cases) {
      const h = harness();
      const result = await handleEmailTaskRequest(
        env(over),
        { rawBody: JSON.stringify(envelope(mail)), headers: h2 },
        h.deps,
      );
      expect(result.status).toBe("ignored");
      expect(h.runBodies).toEqual([]);
      expect(h.posts).toEqual([]);
    }
  });

  it("uses the mailbox repo map when the mail names no repository, else explains the usage", async () => {
    const h = harness();
    const noRepo = await handleEmailTaskRequest(
      env(),
      {
        rawBody: JSON.stringify(envelope({ subject: "Bump the timeout", text: "" })),
        headers: headers(),
      },
      h.deps,
    );
    expect(noRepo.status).toBe("refused");
    expect(h.runBodies).toEqual([]);
    expect(h.posts[0]!.text).toContain("EMAIL_TASK_REPOS");

    const mapped = harness();
    const result = await handleEmailTaskRequest(
      env({ EMAIL_TASK_REPOS: JSON.stringify({ [MAILBOX]: REPO }) }),
      {
        rawBody: JSON.stringify(
          envelope({ from: "bob@corp.example", subject: "Bump the timeout", text: "" }),
        ),
        headers: headers(
          "mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass header.from=corp.example",
        ),
      },
      mapped.deps,
    );
    expect(result.status).toBe("queued");
    expect(mapped.runBodies[0]).toMatchObject({ repoUrl: REPO, task: "Bump the timeout" });
  });

  it("refuses oversized requests rather than queueing a truncated task", async () => {
    const h = harness();
    const result = await handleEmailTaskRequest(
      env(),
      {
        rawBody: JSON.stringify(envelope({ text: "x".repeat(4001) })),
        headers: headers(),
      },
      h.deps,
    );
    expect(result.status).toBe("refused");
    expect(h.runBodies).toEqual([]);
    expect(h.posts[0]?.text).toContain("4,000 characters");
  });

  it("does not requeue the old subject when a reply only quotes history", async () => {
    const h = harness();
    const result = await handleEmailTaskRequest(
      env(),
      {
        rawBody: JSON.stringify(
          envelope({
            inReplyTo: "<old@example.com>",
            text: "On Thu, Alice wrote:\n> Former task",
          }),
        ),
        headers: headers(),
      },
      h.deps,
    );
    expect(result.status).toBe("ignored");
    expect(h.runBodies).toEqual([]);
    expect(h.posts).toEqual([]);
  });
});
