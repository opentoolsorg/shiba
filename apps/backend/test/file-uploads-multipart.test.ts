import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { completeMultipartUpload, createMultipartUploadSession, uploadPart } from "../src/files/files-uploads.js";

function r2Fixture() {
  const parts = new Map<number, Uint8Array>();
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    bucket: {
      async createMultipartUpload(key: string) {
        const uploadId = "upload-fixture";
        const api = {
          key,
          uploadId,
          uploadPart: async (partNumber: number, body: ArrayBuffer | Uint8Array) => {
            const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
            parts.set(partNumber, bytes);
            return { etag: `"etag-${partNumber}"`, partNumber };
          },
          complete: async (uploadedParts: Array<{ partNumber: number; etag: string }>) => {
            const merged = uploadedParts.flatMap((part) => [...(parts.get(part.partNumber) ?? [])]);
            objects.set(key, Uint8Array.from(merged));
            return { key, size: merged.length };
          },
        };
        return api;
      },
      resumeMultipartUpload(key: string, uploadId: string) {
        return {
          key,
          uploadId,
          uploadPart: async (partNumber: number, body: ArrayBuffer | Uint8Array) => {
            const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
            parts.set(partNumber, bytes);
            return { etag: `"etag-${partNumber}"`, partNumber };
          },
          complete: async (uploadedParts: Array<{ partNumber: number; etag: string }>) => {
            const merged = uploadedParts.flatMap((part) => [...(parts.get(part.partNumber) ?? [])]);
            objects.set(key, Uint8Array.from(merged));
            return { key, size: merged.length };
          },
        };
      },
      async get(key: string) {
        const bytes = objects.get(key);
        return bytes ? { arrayBuffer: async () => bytes.buffer, size: bytes.byteLength } : null;
      },
      async head(key: string) {
        const bytes = objects.get(key);
        return bytes ? { size: bytes.byteLength } : null;
      },
      async put(key: string, value: Uint8Array) { objects.set(key, value); return { key }; },
    } as unknown as R2Bucket,
  };
}

describe("multipart file uploads", () => {
  it("completes a session and stores bytes in FILES", async () => {
    const { database, sqlite } = customAgentD1();
    const migration = readFileSync(new URL("../migrations/0050_files_notes.sql", import.meta.url), "utf8");
    const migration2 = readFileSync(new URL("../migrations/0051_knowledge_indexes.sql", import.meta.url), "utf8");
    sqlite.exec(migration);
    sqlite.exec(migration2);
    const storage = r2Fixture();
    const env = {
      AGENT_AUDIT: database,
      FILES: storage.bucket,
      AI: {
        run: vi.fn(async (_model: string, input: { text?: string[] }) => ({
          data: (input.text ?? []).map((text) => text.split("").map((c) => c.charCodeAt(0) % 7)),
        })),
      },
      MEMORY_VECTORS: { upsert: vi.fn(async () => {}), query: vi.fn(async () => ({ matches: [] })) },
    } as unknown as Env;
    const session = await createMultipartUploadSession(env, {
      workspaceId: "ws_test", scope: "personal", name: "brief.md", mime: "text/markdown", createdBy: "alice@example.test",
    });
    await uploadPart(env, session.sessionId, 1, new TextEncoder().encode("# Probe\n"));
    const result = await completeMultipartUpload(env, session.sessionId, [{ partNumber: 1, etag: '"etag-1"' }], "alice@example.test");
    expect(result.file.name).toBe("brief.md");
    expect(result.file.ingestion.state).toBe("pending");
    expect(storage.objects.size).toBeGreaterThan(0);
  });
});