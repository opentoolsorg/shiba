import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { createArtifactDownloadUrl, handleArtifactDownload, verifyArtifactDownloadToken } from "../src/artifact-download.js";
import {
  MAX_WORKSPACE_ARTIFACT_BYTES,
  persistWorkspaceArchive,
  workspaceArtifactArchive,
  type CapturedFile,
} from "../src/run-deliverables.js";

const NOW = Date.parse("2026-11-03T18:00:00Z");
const signing = { ARTIFACT_SIGNING_KEY: "test-artifact-signing-key-32-bytes-long", WORKER_HOSTNAME: "shiba.test" };
const identity = { ownerId: "owner", runId: "agent-tool:approved", sandboxId: "sandbox" };
const file = (path: string, content: string | null, encoding: "utf8" | "base64" = "utf8"): CapturedFile => ({ path, content, encoding });

function storage() {
  type Stored = { bytes: Uint8Array<ArrayBuffer>; metadata: Record<string, string>; checksum: ArrayBuffer };
  const objects = new Map<string, Stored>();
  const put = vi.fn(async (key: string, body: ReadableStream, options: R2PutOptions) => {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    objects.set(key, { bytes, metadata: options.customMetadata ?? {}, checksum: await crypto.subtle.digest("SHA-256", bytes) });
    return { key };
  });
  const get = vi.fn(async (key: string) => {
    const stored = objects.get(key);
    return stored ? {
      size: stored.bytes.byteLength,
      body: new Response(stored.bytes).body,
      checksums: { sha256: stored.checksum },
      customMetadata: stored.metadata,
    } : null;
  });
  const env = { ...signing, ARTIFACTS: { put, get } } as unknown as Env;
  return { env, objects, put, get };
}

afterEach(() => vi.useRealTimers());

describe("ephemeral workspace artifact archives", () => {
  it("round trips binary and empty files while excluding all captures outside out", () => {
    const binary = Uint8Array.of(0, 255, 128, 13, 10);
    const archive = workspaceArtifactArchive([
      file("out/empty.txt", ""), file("out/image.bin", Buffer.from(binary).toString("base64"), "base64"),
      file("out/research/report.md", "# Report\n"), file(".env", "NEVER_ARCHIVE_THIS"), file("private.txt", "NEVER_ARCHIVE_THIS"),
    ]);
    const decoded = unzipSync(archive.bytes);
    expect(archive.fileCount).toBe(3);
    expect(Object.keys(decoded)).toEqual(["empty.txt", "image.bin", "research/report.md"]);
    expect(decoded["empty.txt"]).toEqual(new Uint8Array());
    expect(decoded["image.bin"]).toEqual(binary);
    expect(new TextDecoder().decode(decoded["research/report.md"])).toBe("# Report\n");
    expect(new TextDecoder().decode(archive.bytes)).not.toContain("NEVER_ARCHIVE_THIS");
  });

  it("creates a valid empty ZIP when no output files exist", () => {
    const archive = workspaceArtifactArchive([]);
    expect(archive.bytes.byteLength).toBe(22);
    expect(unzipSync(archive.bytes)).toEqual({});
  });

  it("produces stable archives independently of capture order", () => {
    const files = [file("out/z.csv", "a,b\n"), file("out/a.md", "Report")];
    expect(workspaceArtifactArchive(files).bytes).toEqual(workspaceArtifactArchive([...files].reverse()).bytes);
  });

  it.each(["out/../secret.txt", "out/.env", "out/x/.private", "out/a\\b.bin", "out/a//b.txt", "out/trailing .txt "])("rejects unsafe archive path %j", (path) => {
    expect(() => workspaceArtifactArchive([file(path, "secret")])).toThrow("path is unsafe");
  });

  it("fails complete capture, canonical byte transport, file count and size boundaries", () => {
    expect(() => workspaceArtifactArchive([file("out/incomplete.bin", null)])).toThrow("not captured completely");
    expect(() => workspaceArtifactArchive([file("out/bad.bin", "abc", "base64")])).toThrow("malformed");
    expect(() => workspaceArtifactArchive([file("out/bad.bin", "YR==", "base64")])).toThrow("noncanonical");
    expect(() => workspaceArtifactArchive([file("out/unicode.txt", "\ud800")])).toThrow("invalid Unicode");
    expect(() => workspaceArtifactArchive([file("out/a.txt", "a"), file("out/A.txt", "a")])).toThrow("unique");
    expect(() => workspaceArtifactArchive(Array.from({ length: 65 }, (_, index) => file(`out/${index}.txt`, "")))).toThrow("file count");
    expect(() => workspaceArtifactArchive([file("out/large.bin", "x".repeat(MAX_WORKSPACE_ARTIFACT_BYTES + 1))])).toThrow("byte limit");
    expect(() => workspaceArtifactArchive(Array.from({ length: 9 }, (_, index) => file(`out/${index}.bin`, "x".repeat(MAX_WORKSPACE_ARTIFACT_BYTES))))).toThrow("total limit");
  });

  it("streams a private archive into R2 and serves it with a seven day capability", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const s = storage();
    const bundle = await persistWorkspaceArchive(s.env, identity, [file("out/empty.csv", "")], NOW);
    expect(bundle.expiresAt).toBe(NOW + 604_800_000);
    expect(bundle.fileCount).toBe(1);
    expect(bundle.sha256).toBe(createHash("sha256").update([...s.objects.values()][0]!.bytes).digest("hex"));
    expect(s.put.mock.calls[0]?.[1]).toBeInstanceOf(ReadableStream);
    const response = await handleArtifactDownload(new Request(bundle.downloadUrl), s.env);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-disposition")).toBe('attachment; filename="artifacts.zip"');
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(unzipSync(new Uint8Array(await response!.arrayBuffer()))["empty.csv"]).toEqual(new Uint8Array());
    vi.setSystemTime(bundle.expiresAt);
    expect((await handleArtifactDownload(new Request(bundle.downloadUrl), s.env))?.status).toBe(403);
    expect(s.get).toHaveBeenCalledTimes(1);
  });

  it("binds archives to the owner, run and sandbox independently", async () => {
    const s = storage();
    for (const changed of [identity, { ...identity, ownerId: "other" }, { ...identity, runId: "other" }, { ...identity, sandboxId: "other" }]) {
      await persistWorkspaceArchive(s.env, changed, [file("out/report.txt", "same content")], NOW);
    }
    expect(s.objects.size).toBe(4);
  });

  it("rejects unsigned, tampered, duplicated and cross-key capabilities before storage reads", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const s = storage();
    const bundle = await persistWorkspaceArchive(s.env, identity, [], NOW);
    const original = new URL(bundle.downloadUrl);
    const token = original.searchParams.get("token")!;
    const [payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    const altered = Buffer.from(JSON.stringify({ ...claims, scope: "b".repeat(64) })).toString("base64url");
    for (const candidate of ["", "garbage", `${altered}.${signature}`, `${payload}.${signature!.slice(0, -1)}x`]) {
      const url = new URL(original); url.searchParams.set("token", candidate);
      expect((await handleArtifactDownload(new Request(url), s.env))?.status).toBe(403);
    }
    const duplicate = new URL(original); duplicate.searchParams.append("token", token);
    expect((await handleArtifactDownload(new Request(duplicate), s.env))?.status).toBe(403);
    expect(await verifyArtifactDownloadToken({ ...signing, ARTIFACT_SIGNING_KEY: "other-artifact-signing-key-32-bytes-long" }, token, NOW)).toBeNull();
    expect(s.get).not.toHaveBeenCalled();
  });

  it("rejects future or overlong expiry claims and missing signing configuration", async () => {
    const claims = { version: 1 as const, scope: "a".repeat(64), sha256: "b".repeat(64), bytes: 22, fileCount: 0, issuedAt: NOW, expiresAt: NOW + 604_800_000 };
    await expect(createArtifactDownloadUrl(signing, { ...claims, expiresAt: claims.expiresAt + 1 })).rejects.toThrow("claims");
    const url = new URL(await createArtifactDownloadUrl(signing, { ...claims, issuedAt: NOW + 1 }));
    expect(await verifyArtifactDownloadToken(signing, url.searchParams.get("token")!, NOW)).toBeNull();
    const s = storage();
    await expect(persistWorkspaceArchive({ ...s.env, ARTIFACT_SIGNING_KEY: "" }, identity, [], NOW)).rejects.toThrow("signing requires");
    await expect(persistWorkspaceArchive({ ...s.env, WORKER_HOSTNAME: "http://insecure.test" }, identity, [], NOW)).rejects.toThrow("HTTPS");
    expect(s.put).not.toHaveBeenCalled();
  });

  it("fails closed on missing storage and tampered object checksum", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const s = storage();
    await expect(persistWorkspaceArchive({ ...s.env, ARTIFACTS: undefined }, identity, [], NOW)).rejects.toThrow("not configured");
    const bundle = await persistWorkspaceArchive(s.env, identity, [], NOW);
    const stored = [...s.objects.values()][0]!;
    stored.checksum = new Uint8Array(32).buffer;
    expect((await handleArtifactDownload(new Request(bundle.downloadUrl), s.env))?.status).toBe(409);
    s.objects.clear();
    expect((await handleArtifactDownload(new Request(bundle.downloadUrl), s.env))?.status).toBe(404);
    expect(await handleArtifactDownload(new Request("https://shiba.test/api/runs"), s.env)).toBeNull();
    expect((await handleArtifactDownload(new Request(bundle.downloadUrl, { method: "POST" }), s.env))?.status).toBe(405);
  });
});
