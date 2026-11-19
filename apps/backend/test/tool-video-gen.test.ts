import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { getFile, insertFileRecord } from "../src/files/files-store.js";
import { createChatAgentMediaTools } from "../src/tools/chat-agent-tools.js";
import { registerAgentMediaMcpTools } from "../src/tools/register-mcp.js";
import {
  generateVideo, GoogleVideoBackend, videoCapability, videoCapabilityForUser, videoInputSchema,
  type VideoGenerationBackend,
} from "../src/tools/video-gen.js";
import { readUserProviderSecret } from "../src/user-provider-keys.js";

vi.mock("../src/files/files-store.js", () => ({ getFile: vi.fn(), insertFileRecord: vi.fn() }));
vi.mock("../src/user-provider-keys.js", () => ({ readUserProviderSecret: vi.fn() }));

const context = { runId: "chat-1", userId: "owner@example.com", workspaceId: "self-hosted" };
const input = { prompt: "A dog running on a beach", duration: 8, aspectRatio: "16:9" as const };
const artifactId = "file_0123456789abcdef01234567";
const mp4 = new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109]);

function fixture() {
  const put = vi.fn(async (_key: string, _bytes: Uint8Array, _metadata: unknown) => ({}));
  const remove = vi.fn(async (_key: string) => {});
  const run = vi.fn(async () => ({}));
  const first = vi.fn(async () => ({ r2_key: "files/source.png" }));
  const bind = vi.fn(() => ({ run, first }));
  const prepare = vi.fn(() => ({ bind }));
  const env = {
    SHIBA_VIDEO_GENERATION: "1", SHIBA_VIDEO_BACKEND: "google",
    ARTIFACTS: { put, delete: remove }, AGENT_AUDIT: { prepare },
    AGENT_TOKENS: {}, MODEL_CREDENTIAL_KEY: "test-storage-key",
  } as unknown as Env;
  const backend = {
    start: vi.fn(async () => "job_1"),
    poll: vi.fn<VideoGenerationBackend["poll"]>().mockResolvedValue({ status: "completed", mp4 }),
  };
  return { env, put, remove, backend, prepare, bind, run };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(insertFileRecord).mockResolvedValue({ id: artifactId } as never);
  vi.mocked(readUserProviderSecret).mockResolvedValue("personal-test-key");
});

describe("video capability and registration", () => {
  it.each([
    [{ SHIBA_VIDEO_GENERATION: undefined }, "disabled"],
    [{ SHIBA_VIDEO_BACKEND: undefined }, "backend"],
    [{ ARTIFACTS: undefined }, "storage"],
  ])("omits the paid tool when unavailable: %j", (changes, reason) => {
    const { env } = fixture();
    Object.assign(env, changes);
    expect(videoCapability(env)).toMatchObject({ enabled: false, reason: expect.stringContaining(reason as string) });
    expect(createChatAgentMediaTools(env, { runId: context.runId, userId: context.userId })).not.toHaveProperty("generate_video");
    const names: string[] = [];
    registerAgentMediaMcpTools({ registerTool: (name: string) => names.push(name) } as never, env);
    expect(names).not.toContain("generate_video");
  });

  it("registers video with human confirmation and never spends through MCP", async () => {
    const { env } = fixture();
    const tools = createChatAgentMediaTools(env, { runId: context.runId, userId: context.userId });
    expect(tools.generate_video).toBeDefined();
    expect(tools.generate_video?.needsApproval).toBe(true);
    const handlers = new Map<string, (args: Record<string, unknown>, ctx: unknown) => unknown>();
    registerAgentMediaMcpTools({ registerTool: (name: string, _scope: string, handler: (args: Record<string, unknown>, ctx: unknown) => unknown) => handlers.set(name, handler) } as never, env);
    expect(handlers.has("generate_video")).toBe(true);
    const handler = handlers.get("generate_video");
    if (!handler) throw new Error("Video tool missing.");
    const result = await handler({ ...input, approved: true }, { principal: { principal: "agent", orgId: "self-hosted" } });
    expect(JSON.stringify(result)).toMatch(/approv|confirm/i);
    expect(readUserProviderSecret).not.toHaveBeenCalled();
  });

  it("reports a disconnected personal provider without throwing", async () => {
    const { env } = fixture();
    vi.mocked(readUserProviderSecret).mockResolvedValue(null);
    expect(await videoCapabilityForUser(env, context.userId)).toMatchObject({ enabled: false, reason: expect.stringContaining("Connect a Google") });
    vi.mocked(readUserProviderSecret).mockRejectedValue(new Error("storage failed"));
    expect(await videoCapabilityForUser(env, context.userId)).toMatchObject({ enabled: false });
  });
});

describe("video job lifecycle", () => {
  it("starts once, polls, and stores MP4 bytes and a private file record", async () => {
    const { env, put, backend } = fixture();
    backend.poll.mockResolvedValueOnce({ status: "pending" }).mockResolvedValueOnce({ status: "completed", mp4 });
    const wait = vi.fn(async () => {});
    const result = await generateVideo(env, input, context, { backend, wait });
    expect(backend.start).toHaveBeenCalledExactlyOnceWith(input, undefined);
    expect(backend.poll).toHaveBeenCalledTimes(2);
    expect(backend.poll).toHaveBeenCalledWith("job_1");
    expect(wait).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^outputs\/videos\/.+\.mp4$/), mp4, {
      httpMetadata: { contentType: "video/mp4" },
      customMetadata: { kind: "output", runId: context.runId, ownerId: context.userId },
    });
    expect(insertFileRecord).toHaveBeenCalledWith(env, expect.objectContaining({
      scope: "personal", createdBy: context.userId, workspaceId: context.workspaceId,
      mime: "video/mp4", size: mp4.byteLength, sha256: expect.stringMatching(/^[a-f0-9]{64}$/), ingestionState: "done",
    }));
    expect(result).toMatchObject({ ok: true, artifactId, mime: "video/mp4", downloadPath: `/api/files/${artifactId}/download`, bytes: mp4.byteLength });
  });

  it.each([0, 2, 9, 100, 3.5, Number.NaN])("rejects duration %s before starting a paid job", async (duration) => {
    const { env, backend, put } = fixture();
    expect(videoInputSchema.safeParse({ ...input, duration }).success).toBe(false);
    const result = await generateVideo(env, { ...input, duration }, context, { backend });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("3 to 8") });
    expect(backend.start).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("returns a plain failure without storing bytes", async () => {
    const { env, backend, put } = fixture();
    backend.poll.mockResolvedValue({ status: "failed" });
    const result = await generateVideo(env, input, context, { backend, wait: async () => {} });
    expect(result).toEqual({ ok: false, error: "Video generation failed. Try another prompt." });
    expect(put).not.toHaveBeenCalled();
  });

  it("bounds polling and warns that a timed out job may still be billed", async () => {
    const { env, backend, put } = fixture();
    backend.poll.mockResolvedValue({ status: "pending" });
    const result = await generateVideo(env, input, context, { backend, wait: async () => {}, maxPolls: 3 });
    expect(backend.start).toHaveBeenCalledOnce();
    expect(backend.poll).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("timed out") });
    expect(result.error).toContain("charge");
    expect(put).not.toHaveBeenCalled();
  });

  it("does not expose provider exception details or retry creation", async () => {
    const { env, backend, put } = fixture();
    backend.start.mockRejectedValue(new Error("credential=private-test-value"));
    const result = await generateVideo(env, input, context, { backend, wait: async () => {} });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("may have charged") });
    expect(JSON.stringify(result)).not.toContain("private-test-value");
    expect(backend.start).toHaveBeenCalledOnce();
    expect(put).not.toHaveBeenCalled();
  });

  it("reports a provider key storage outage before starting a paid request", async () => {
    const { env, put } = fixture();
    vi.mocked(readUserProviderSecret).mockRejectedValue(new Error("private storage diagnostics"));
    const result = await generateVideo(env, input, context);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("unavailable") });
    expect(JSON.stringify(result)).not.toContain("private storage diagnostics");
    expect(put).not.toHaveBeenCalled();
  });

  it("warns about possible charges after a poll request fails", async () => {
    const { env, backend, put } = fixture();
    backend.poll.mockRejectedValue(new Error("private provider diagnostics"));
    const result = await generateVideo(env, input, context, { backend, wait: async () => {} });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("may have charged") });
    expect(result.error).toContain("check your account before retrying");
    expect(JSON.stringify(result)).not.toContain("private provider diagnostics");
    expect(backend.start).toHaveBeenCalledOnce();
    expect(put).not.toHaveBeenCalled();
  });

  it("removes the R2 object if file registration fails", async () => {
    const { env, backend, put, remove } = fixture();
    vi.mocked(insertFileRecord).mockRejectedValue(new Error("database failed"));
    expect(await generateVideo(env, input, context, { backend, wait: async () => {} })).toMatchObject({ ok: false });
    expect(remove).toHaveBeenCalledExactlyOnceWith(put.mock.calls[0]?.[0]);
  });

  it("rejects non-MP4 output", async () => {
    const { env, backend, put } = fixture();
    backend.poll.mockResolvedValue({ status: "completed", mp4: new TextEncoder().encode("not a real mp4 video") });
    expect(await generateVideo(env, input, context, { backend, wait: async () => {} })).toMatchObject({ ok: false, error: expect.stringContaining("invalid MP4") });
    expect(put).not.toHaveBeenCalled();
  });

  it("refuses another user's source image before starting a job", async () => {
    const { env, backend } = fixture();
    vi.mocked(getFile).mockResolvedValue({ id: artifactId, workspaceId: context.workspaceId, createdBy: "other@example.com", mime: "image/png", size: 10 } as never);
    const result = await generateVideo(env, { ...input, sourceImageArtifactId: artifactId }, context, { backend });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("your PNG or JPEG") });
    expect(backend.start).not.toHaveBeenCalled();
  });

  it("passes an owned image as bytes rather than accepting an arbitrary URL", async () => {
    const { env, backend } = fixture();
    vi.mocked(getFile).mockResolvedValue({ id: artifactId, workspaceId: context.workspaceId, createdBy: context.userId, mime: "image/png", size: 3 } as never);
    Object.assign(env, { FILES: { get: vi.fn(async (key: string) => key === "files/source.png" ? { size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } : null) } });
    const result = await generateVideo(env, { ...input, sourceImageArtifactId: artifactId }, context, { backend, wait: async () => {} });
    expect(result.ok).toBe(true);
    expect(backend.start).toHaveBeenCalledWith({ ...input, sourceImageArtifactId: artifactId }, { data: "AQID", mime: "image/png" });
  });
});

describe("Google video adapter", () => {
  it("uses the personal key for creation and polling, then decodes MP4 content", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "job_1" }))
      .mockResolvedValueOnce(Response.json({ status: "in_progress" }))
      .mockResolvedValueOnce(Response.json({ status: "completed", steps: [{ type: "model_output", content: [{ type: "video", mime_type: "video/mp4", data: btoa(String.fromCharCode(...mp4)) }] }] }));
    const adapter = new GoogleVideoBackend("personal-test-key", request);
    expect(await adapter.start(input, { data: "AQID", mime: "image/png" })).toBe("job_1");
    expect(await adapter.poll("job_1")).toEqual({ status: "pending" });
    expect(await adapter.poll("job_1")).toEqual({ status: "completed", mp4 });
    const firstCall = request.mock.calls[0];
    if (!firstCall) throw new Error("Provider request missing.");
    const [url, init] = firstCall;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(init?.headers).toMatchObject({ "x-goog-api-key": "personal-test-key", "Api-Revision": "2026-05-20" });
    expect(JSON.parse(String(init?.body))).toMatchObject({ background: true, response_format: { type: "video", duration: "8s", aspect_ratio: "16:9" }, input: [{ type: "image", data: "AQID", mime_type: "image/png" }, { type: "text", text: input.prompt }] });
    expect(request.mock.calls[1]?.[0]).toBe(`${url}/job_1`);
    expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({ "x-goog-api-key": "personal-test-key" });
  });

  it.each(["failed", "cancelled", "requires_action"])('treats provider status "%s" as failed', async (status) => {
    const adapter = new GoogleVideoBackend("personal-test-key", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status })));
    expect(await adapter.poll("job_1")).toEqual({ status: "failed" });
  });

  it("rejects an HTTP error with a plain message", async () => {
    const adapter = new GoogleVideoBackend("personal-test-key", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: "private details" } }, { status: 403 })));
    await expect(adapter.start(input)).rejects.toThrow("Video provider request failed.");
  });
});
