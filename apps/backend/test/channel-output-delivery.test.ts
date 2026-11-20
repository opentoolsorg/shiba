import { describe, expect, it, vi } from "vitest";
import type { DelegatedRun } from "@shiba/shared";
import { channelOutputAdapter, deliverCompletedRunOutputs } from "../src/channel-output-delivery.js";
import type { Env } from "../src/env.js";
import type { ChannelAdapter, ChannelPostInput, ChannelUploadInput } from "../src/ports/channel/index.js";
import { deliverableStorageKey } from "../src/run-deliverables.js";
import { createTelegramAdapter, telegramTransport } from "../src/channels/telegram/index.js";
import { generateSlackMedia, postSlackMediaResult, requestSlackMedia, type SlackMediaWorkflowInput } from "../src/slack-media-output.js";

const SHA = "a".repeat(64);
const originalRun = {
  runId: "run-001", sandboxId: "box-001", status: "completed",
  approval: { approvalId: "ap-001", decidedBy: "slack:human" },
  deliverables: [{ path: "reports/report.pdf", bytes: 5, sha256: SHA, mediaType: "application/pdf" }],
} as unknown as DelegatedRun;

function fixture(channel: ChannelAdapter["channel"] = "slack") {
  const objects = new Map<string, string>();
  const key = deliverableStorageKey(originalRun.sandboxId, SHA, 0);
  objects.set(key, "%PDF-");
  const env = {
    WORKER_HOSTNAME: "shiba.example",
    ATTACHMENTS: {
      put: vi.fn(async (key: string, value: string, options?: R2PutOptions) => {
        if (options?.onlyIf && objects.has(key)) return null;
        objects.set(key, value);
        return { key };
      }),
      get: vi.fn(async (key: string) => {
        const value = objects.get(key);
        return value ? { size: value.length, arrayBuffer: () => Promise.resolve(new TextEncoder().encode(value).buffer) } : null;
      }),
    },
  } as unknown as Env;
  const adapter = {
    channel,
    upload: vi.fn(async ({ placeId, threadId }: ChannelUploadInput) => ({ placeId, threadId, messageId: "posted-file" })),
    post: vi.fn(async ({ placeId, threadId }: ChannelPostInput) => ({ placeId, threadId, messageId: "posted-text" })),
  };
  return { env, adapter, objects, resolve: vi.fn(async () => adapter) };
}

describe("completed run delivery", () => {
  it.each([
    ["slack", "slack:T123:C456:1710000000.000100", "C456", "1710000000.000100"],
    ["discord", "discord:456", "456", undefined],
    ["telegram", "telegram:-100456:7", "-100456", "7"],
  ] as const)("uploads captured bytes and records the %s thread receipt exactly once", async (channel, origin, placeId, threadId) => {
    const { env, resolve, adapter, objects } = fixture(channel);
    await Promise.all([
      deliverCompletedRunOutputs(env, origin, originalRun, undefined, resolve),
      deliverCompletedRunOutputs(env, origin, originalRun, undefined, resolve),
    ]);
    await deliverCompletedRunOutputs(env, origin, originalRun, undefined, resolve);
    expect(adapter.upload).toHaveBeenCalledOnce();
    expect(adapter.upload.mock.calls[0]?.[0]).toEqual({
      placeId, ...(threadId ? { threadId } : {}), filename: "report.pdf", contentType: "application/pdf",
      data: new TextEncoder().encode("%PDF-"), comment: "Output: report.pdf\nOpen in Shiba: https://shiba.example/work/",
    });
    expect(JSON.stringify([...objects.values()])).toContain("posted-file");
    expect(adapter.post).not.toHaveBeenCalled();
  });

  it("skips files over the channel limit before reading and reports only in the originating topic", async () => {
    const { env, resolve, adapter } = fixture("telegram");
    const run = { ...originalRun, deliverables: originalRun.deliverables!.map((file) => ({ ...file, bytes: 33 * 1024 * 1024 })) };
    await deliverCompletedRunOutputs(env, "telegram:-100456:7", run, undefined, resolve);
    expect(env.ATTACHMENTS.get).not.toHaveBeenCalled();
    expect(adapter.upload).not.toHaveBeenCalled();
    expect(adapter.post).toHaveBeenCalledExactlyOnceWith({ placeId: "-100456", threadId: "7", text: expect.stringContaining("too large") });
  });

  it("reports uncertain outcomes without transport errors and never re-uploads", async () => {
    const { env, resolve, adapter } = fixture("discord");
    adapter.upload.mockRejectedValueOnce(new Error("internal bearer value"));
    await deliverCompletedRunOutputs(env, "discord:456", originalRun, undefined, resolve);
    await deliverCompletedRunOutputs(env, "discord:456", originalRun, undefined, resolve);
    expect(adapter.upload).toHaveBeenCalledOnce();
    expect(adapter.post).toHaveBeenCalledExactlyOnceWith({
      placeId: "456", text: "Shiba could not confirm that report.pdf was attached. Open in Shiba: https://shiba.example/work/",
    });
  });

  it("never delivers for a dashboard, private slash, pending, wrong adapter or disabled run", async () => {
    const { env, resolve, adapter } = fixture();
    await deliverCompletedRunOutputs(env, "discord:456", originalRun, undefined, resolve);
    expect(resolve).toHaveBeenCalledOnce();
    await deliverCompletedRunOutputs(env, "default", originalRun, undefined, resolve);
    await deliverCompletedRunOutputs(env, "slack-command:T123:C456", originalRun, undefined, resolve);
    await deliverCompletedRunOutputs(env, "slack:T123:C456:1710000000.000100", { ...originalRun, status: "running" }, undefined, resolve);
    await deliverCompletedRunOutputs({ ...env, SHIBA_CHANNEL_OUTPUT_DELIVERY: "0" }, "slack:T123:C456:1710000000.000100", originalRun, undefined, resolve);
    expect(resolve).toHaveBeenCalledOnce();
    expect(adapter.upload).not.toHaveBeenCalled();
    expect(adapter.post).not.toHaveBeenCalled();
  });

  it("queries media for the exact run, owner and workspace and uses the output gallery link", async () => {
    const { env, resolve, adapter } = fixture();
    const bind = vi.fn(() => ({ all: async () => ({ results: [{ id: "file-image", name: "Generated image.png", mime: "image/png", size: 3, r2_key: "generated-image" }] }) }));
    const outputBucket = { get: vi.fn(async () => ({ size: 3, arrayBuffer: async () => Uint8Array.of(1, 2, 3).buffer })) };
    const run = { ...originalRun, orgId: "team:workspace-example", deliverables: [] };
    const runtime = { ...env, AGENT_AUDIT: { prepare: () => ({ bind }) }, FILES: outputBucket } as unknown as Env;
    await deliverCompletedRunOutputs(runtime, "slack:T123:C456:1710000000.000100", run, "person", resolve);
    expect(bind).toHaveBeenCalledExactlyOnceWith(run.runId, "person", "workspace-example");
    expect(outputBucket.get).toHaveBeenCalledExactlyOnceWith("generated-image");
    expect(adapter.upload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      filename: "Generated image.png", comment: expect.stringContaining("https://shiba.example/outputs/"),
    }));
  });

  it("refuses the Slack credential when it belongs to another team", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, team_id: "T_OTHER", user_id: "U1", bot_id: "B1" }));
    try {
      const adapter = await channelOutputAdapter({ SLACK_BOT_TOKEN: "fake" } as Env, {
        channel: "slack", teamId: "T123", placeId: "C456", threadId: "1710000000.000100",
      });
      expect(adapter).toBeNull();
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      fetch.mockRestore();
    }
  });
});

describe("Telegram topic routing", () => {
  it("preserves the same authenticated topic on the message, approval callback and upload", async () => {
    const chat = { id: -100456 };
    const message = { message_id: 11, message_thread_id: 7, chat };
    const key = "telegram:-100456:7";
    expect(telegramTransport.parse(JSON.stringify({ update_id: 1, message }))?.conversationKey).toBe(key);
    expect(telegramTransport.parse(JSON.stringify({ update_id: 2, callback_query: { message } }))?.conversationKey).toBe(key);
    const send = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      expect(form.get("chat_id")).toBe("-100456");
      expect(form.get("message_thread_id")).toBe("7");
      return Response.json({ ok: true, result: { message_id: 12, message_thread_id: 7 } });
    });
    const adapter = createTelegramAdapter({ token: "fixture", fetch: send as typeof fetch });
    expect(await adapter.upload({ placeId: "-100456", threadId: "7", filename: "report.pdf", data: Uint8Array.of(1), contentType: "application/pdf" }))
      .toEqual({ placeId: "-100456", threadId: "7", messageId: "12" });
  });
});

describe("Slack conversation image generation", () => {
  it("queues one workflow for a replayed event and sends generated bytes back to its originating thread", async () => {
    const { env } = fixture();
    const bytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
    const images = new Map<string, Uint8Array<ArrayBuffer>>();
    env.AI = { run: async () => bytes } as unknown as Ai;
    env.FILES = {
      async put(key: string, value: Uint8Array<ArrayBuffer>) { images.set(key, value); return { key }; },
      async get(key: string) {
        const file = images.get(key);
        return file ? { size: file.byteLength, arrayBuffer: async () => file.buffer } : null;
      },
    } as unknown as R2Bucket;
    env.SLACK_BOT_TOKEN = "fixture";
    const create = vi.fn(async (_input: { id: string; params: SlackMediaWorkflowInput }) => ({}));
    env.SLACK_MEDIA_WORKFLOW = { create } as unknown as Workflow<SlackMediaWorkflowInput>;
    const send = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url = String(request);
      if (url.endsWith("/auth.test")) return Response.json({ ok: true, team_id: "T123", user_id: "UB1", bot_id: "B1" });
      if (url.includes("/files.getUploadURLExternal")) {
        const params = new URL(url).searchParams;
        expect(params.get("filename")).toBe("Generated image.png");
        expect(params.get("length")).toBe(String(bytes.byteLength));
        return Response.json({ ok: true, upload_url: "https://files.slack.com/upload/v1/fixture", file_id: "F123" });
      }
      if (url === "https://files.slack.com/upload/v1/fixture") {
        expect(init?.body).toEqual(bytes);
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        return new Response("OK");
      }
      if (url.endsWith("/files.completeUploadExternal")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          channel_id: "C456", thread_ts: "1710000000.000100", files: [{ id: "F123", title: "Generated image.png" }],
          initial_comment: expect.stringContaining("https://shiba.example/outputs/"),
        });
        return Response.json({ ok: true });
      }
      throw new Error("Unexpected Slack request");
    });
    try {
      const event = { id: "EvImage", threadName: "slack:T123:C456:1710000000.000100", slackUserId: "U1", text: "generate image A mountain" };
      await expect(requestSlackMedia(env, event)).resolves.toBe(true);
      await requestSlackMedia(env, event);
      expect(create).toHaveBeenCalledOnce();
      const input = create.mock.calls[0]![0].params;
      const generated = await generateSlackMedia(env, input);
      expect(generated.ok).toBe(true);
      await postSlackMediaResult(env, input, generated);
      await postSlackMediaResult(env, input, generated);
      expect(send.mock.calls.filter(([url]) => String(url).endsWith("/files.completeUploadExternal"))).toHaveLength(1);
    } finally {
      send.mockRestore();
    }
  });
});
