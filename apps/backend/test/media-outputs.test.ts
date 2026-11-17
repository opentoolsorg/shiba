import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { generateImage } from "../src/tools/image-gen.js";
import { FLUX_MODEL, imageDimensions, imageModels } from "../src/tools/image-models.js";
import { handleKnowledgeOutputs } from "../src/knowledge/knowledge-outputs-routes.js";
import { generateVideo, GoogleVideoBackend, videoInputSchema, videoModes } from "../src/tools/video-gen.js";
import { insertFileRecord } from "../src/files/files-store.js";

vi.mock("../src/request-auth.js", async (original) => ({ ...await original<typeof import("../src/request-auth.js")>(), resolveRequestIdentity: async (request: Request) => ({ authorized: request.headers.has("x-test-user"), userId: request.headers.get("x-test-user") }) }));
vi.mock("../src/org-request-auth.js", () => ({ resolveOrgForApiRequest: async () => ({ orgId: "team:ws", workspace: { workspaceId: "ws" } }) }));
const databases: Array<{ close(): void }> = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const { database, sqlite } = customAgentD1({ bare: true });
  databases.push(sqlite);
  for (const name of ["0050_files_notes.sql", "0062_media_generations.sql"]) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  sqlite.exec("CREATE TABLE run_output_archive_reservations (id TEXT, run_id TEXT, created_at INTEGER, owner_id TEXT, state TEXT, expires_at INTEGER)");
  const run = vi.fn(async (_model: string, _input: unknown): Promise<unknown> => ({ image: btoa("image bytes") }));
  const put = vi.fn(async () => ({}));
  const remove = vi.fn(async () => {});
  const env = { AI: { run }, FILES: { put, delete: remove }, AGENT_AUDIT: database } as unknown as Env;
  return { env, sqlite, run, put, remove };
}
const context = { userId: "alice", workspaceId: "ws", runId: "chat-1" };
function request(path: string, body?: unknown, user = "alice") {
  return new Request(`https://app.test/api/outputs${path}`, { method: body === undefined ? "GET" : "POST", headers: user ? { "x-test-user": user, "Content-Type": "application/json" } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

describe("image catalog and storage", () => {
  it.each(Object.entries(imageDimensions))("sends actual dimensions for %s and registers file provenance", async (aspectRatio, dimensions) => {
    const { env, run, sqlite } = fixture();
    const result = await generateImage(env, { ...context, prompt: "A coastal town", aspectRatio, model: imageModels[1].id });
    expect(result).toMatchObject({ ok: true, artifactId: expect.stringMatching(/^file_/), downloadPath: expect.stringContaining("/download") });
    expect(run).toHaveBeenCalledWith(imageModels[1].id, { prompt: "A coastal town", ...dimensions });
    expect(sqlite.prepare("SELECT scope, ingestion_state, created_by FROM files").get()).toMatchObject({ scope: "personal", ingestion_state: "done", created_by: "alice" });
    expect(sqlite.prepare("SELECT model, aspect_ratio, width, height, source_file_ids FROM media_generations").get()).toMatchObject({ model: imageModels[1].id, aspect_ratio: aspectRatio, ...dimensions, source_file_ids: "[]" });
  });
  it("defaults squares to schnell without dimensions and maps legacy shapes", async () => {
    const { env, run } = fixture();
    await generateImage(env, { ...context, prompt: "Square" });
    expect(run).toHaveBeenLastCalledWith(FLUX_MODEL, { prompt: "Square" });
    await generateImage(env, { ...context, prompt: "Wide", aspect: "landscape" });
    expect(run).toHaveBeenLastCalledWith(imageModels[1].id, { prompt: "Wide", ...imageDimensions["16:9"] });
  });
  it.each([{ prompt: "" }, { prompt: "x", aspectRatio: "2:1" }, { prompt: "x", model: "missing" }, { prompt: "x", model: FLUX_MODEL, aspectRatio: "16:9" }])("rejects invalid input before inference: %j", async (input) => {
    const { env, run, put } = fixture();
    expect(await generateImage(env, { ...context, ...input })).toMatchObject({ ok: false });
    expect(run).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
  });
  it.each(["stream", "array", "buffer"])("accepts %s image responses", async (format) => {
    const { env, run } = fixture();
    const bytes = new Uint8Array([1, 2, 3]);
    run.mockResolvedValueOnce(format === "stream" ? new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) : format === "buffer" ? bytes.buffer : bytes);
    expect(await generateImage(env, { ...context, prompt: "Picture", model: imageModels[2].id })).toMatchObject({ ok: true, bytes: 3 });
  });
  it("rejects an empty response and cleans up failed provenance registration", async () => {
    const { env, run, sqlite, remove } = fixture();
    run.mockResolvedValueOnce({});
    expect(await generateImage(env, { ...context, prompt: "Picture" })).toMatchObject({ ok: false });
    sqlite.exec("CREATE TRIGGER fail_media BEFORE INSERT ON media_generations BEGIN SELECT RAISE(FAIL, 'no metadata'); END");
    expect(await generateImage(env, { ...context, prompt: "Picture" })).toMatchObject({ ok: false });
    expect(remove).toHaveBeenCalledOnce();
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM files").get()).toMatchObject({ n: 0 });
  });
});

describe("Outputs routes", () => {
  it("requires identity and rejects invalid filters and invalid image requests", async () => {
    const { env } = fixture();
    expect((await handleKnowledgeOutputs(request("", undefined, ""), env))?.status).toBe(401);
    expect((await handleKnowledgeOutputs(request("?type=bogus"), env))?.status).toBe(400);
    expect((await handleKnowledgeOutputs(request("/images", { prompt: "" }), env))?.status).toBe(400);
  });
  it("creates an image and lists metadata only to its owner with type filters", async () => {
    const { env } = fixture();
    expect((await handleKnowledgeOutputs(request("/images", { prompt: "A town", aspectRatio: "16:9" }), env))?.status).toBe(201);
    const list = await (await handleKnowledgeOutputs(request("?type=image"), env))!.json() as { items: Array<{ media?: unknown }> };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.media).toMatchObject({ kind: "image", mode: "text-to-image", label: "Lucid Origin", prompt: "A town", aspectRatio: "16:9", width: 1024, height: 576, sourceIds: [] });
    for (const path of ["?type=video", "?type=archive"]) expect(await (await handleKnowledgeOutputs(request(path), env))!.json() as { items: unknown[] }).toEqual({ items: [] });
    expect(((await (await handleKnowledgeOutputs(request("?type=output"), env))!.json()) as { items: unknown[] }).items).toHaveLength(1);
    expect(await (await handleKnowledgeOutputs(request("", undefined, "bob"), env))!.json()).toEqual({ items: [] });
  });
  it("lists video options only when enabled and returns image styles", async () => {
    const { env } = fixture();
    const body = await (await handleKnowledgeOutputs(request("/media-options"), env))!.json() as { imageModels: unknown[]; imageAspectRatios: string[]; video: unknown };
    expect(body.imageModels).toHaveLength(4);
    expect(body.imageAspectRatios).toEqual(Object.keys(imageDimensions));
    expect(body.video).toEqual({ enabled: false, modes: [], aspectRatios: [] });
  });
});

describe("video modes", () => {
  const image = "file_0123456789abcdef01234567";
  const video = "file_abcdef0123456789abcdef01";
  const sources = { "text-to-video": {}, "image-to-video": { sourceImageArtifactId: image }, "reference-to-video": { referenceImageArtifactIds: [image] }, "motion-control": { sourceImageArtifactId: image, referenceVideoArtifactId: video }, "video-editing": { sourceVideoArtifactId: video } };
  it.each(videoModes)("validates sources for %s", (mode) => {
    expect(videoInputSchema.safeParse({ prompt: "Make a clip", mode, ...sources[mode], aspectRatio: "1:1" }).success).toBe(true);
    if (mode !== "text-to-video") expect(videoInputSchema.safeParse({ prompt: "Make a clip", mode }).success).toBe(false);
    expect(videoInputSchema.safeParse({ prompt: "Make a clip", mode, ...sources[mode], ...(mode === "video-editing" ? { sourceImageArtifactId: image } : { sourceVideoArtifactId: video }) }).success).toBe(false);
  });
  it.each([{ ids: [] }, { ids: [image, image, image, image] }])("rejects an invalid reference count", ({ ids }) => {
    expect(videoInputSchema.safeParse({ prompt: "Clip", mode: "reference-to-video", referenceImageArtifactIds: ids }).success).toBe(false);
  });
  it.each(videoModes)("sends content parts for %s", async (mode) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "job_1" }));
    const backend = new GoogleVideoBackend("test-key", fetcher);
    const input = videoInputSchema.parse({ prompt: "Make a clip", mode, ...sources[mode] });
    const source = { data: "AQID", mime: "image/png" };
    const hasImage = mode === "image-to-video" || mode === "motion-control";
    const hasVideo = mode === "motion-control" || mode === "video-editing";
    await backend.start(input, hasImage ? source : undefined, { ...(mode === "reference-to-video" ? { references: [source, source] } : {}), ...(hasVideo ? { video: { data: "BAUG", mime: "video/mp4" } } : {}) });
    const sent = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    if (mode === "text-to-video") expect(sent.input).toBe("Make a clip");
    else {
      expect(sent.input.filter((part: { type: string }) => part.type === "image")).toHaveLength(mode === "reference-to-video" ? 2 : hasImage ? 1 : 0);
      expect(sent.input.filter((part: { type: string }) => part.type === "video")).toHaveLength(hasVideo ? 1 : 0);
      expect(sent.input.at(-1)).toMatchObject({ type: "text", text: expect.stringContaining("Make a clip") });
    }
  });
  it("loads a generated video source from ARTIFACTS when FILES is also bound", async () => {
    const { database, sqlite } = customAgentD1({ bare: true });
    databases.push(sqlite);
    for (const name of ["0050_files_notes.sql", "0062_media_generations.sql"]) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    const sourceBytes = new Uint8Array([1, 2, 3, 4]);
    const sourceKey = "outputs/videos/source.mp4";
    const filesGet = vi.fn(async () => null);
    const artifactsGet = vi.fn(async (key: string) => key === sourceKey
      ? { size: sourceBytes.byteLength, arrayBuffer: async () => sourceBytes.buffer }
      : null);
    const artifactsPut = vi.fn(async () => ({}));
    const env = {
      SHIBA_VIDEO_GENERATION: "1",
      SHIBA_VIDEO_BACKEND: "google",
      AGENT_AUDIT: database,
      AGENT_TOKENS: {},
      MODEL_CREDENTIAL_KEY: {},
      FILES: { get: filesGet },
      ARTIFACTS: { get: artifactsGet, put: artifactsPut },
    } as unknown as Env;
    const file = await insertFileRecord(env, { workspaceId: "ws", scope: "personal", name: "source.mp4", mime: "video/mp4", size: sourceBytes.byteLength, r2Key: sourceKey, sha256: "x", createdBy: "alice", ingestionState: "done" });
    let sentVideo: string | undefined;
    const backend = {
      supportedModes: videoModes,
      start: vi.fn(async (_input: unknown, _image: unknown, sources?: { video?: { data: string } }) => {
        sentVideo = sources?.video?.data;
        return "job";
      }),
      poll: vi.fn(async () => ({ status: "completed" as const, mp4: new Uint8Array([0, 0, 0, 0, 102, 116, 121, 112, 1, 2, 3, 4]) })),
    };
    const result = await generateVideo(env, { prompt: "Edit it", mode: "video-editing", sourceVideoArtifactId: file.id, duration: 3, aspectRatio: "16:9" }, { runId: "run", userId: "alice", workspaceId: "ws" }, { backend, wait: async () => {}, maxPolls: 1 });
    expect(result).toMatchObject({ ok: true, artifactId: expect.stringMatching(/^file_/) });
    expect(sentVideo).toBe(btoa(String.fromCharCode(...sourceBytes)));
    expect(backend.start).toHaveBeenCalledOnce();
    expect(artifactsPut).toHaveBeenCalledOnce();
  });

});
