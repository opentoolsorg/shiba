import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleFiles } from "../src/files/files-routes.js";

const artifactId = "file_0123456789abcdef01234567";
const storageKey = "outputs/videos/48b46a64-4793-4a30-90f6-1abdb98b6da1.mp4";
const owner = "owner@example.test";
const bytes = new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109]);

function fixture() {
  const getArtifact = vi.fn(async () => ({ body: bytes }));
  const getGeneralFile = vi.fn(async () => { throw new Error("Generated video must use ARTIFACTS."); });
  const row = {
    id: artifactId, workspace_id: "self-hosted", scope: "personal", created_by: owner,
    name: "Generated video.mp4", mime: "video/mp4", size: bytes.byteLength,
    r2_key: storageKey, sha256: "a".repeat(64), version: 1,
    created_at: 100, updated_at: 100, archived_at: null, ingestion_state: "ready",
  };
  const env = {
    REQUIRE_ACCESS: true,
    AGENT_AUDIT: { prepare: () => ({ bind: () => ({ first: async () => row }) }) },
    ARTIFACTS: { get: getArtifact }, FILES: { get: getGeneralFile },
  } as unknown as Env;
  const request = (userId = owner) => new Request(`https://shiba.test/api/files/${artifactId}/download`, {
    headers: { "CF-Access-Authenticated-User-Email": userId },
  });
  return { env, getArtifact, getGeneralFile, request };
}

describe("private generated video download", () => {
  it("serves the stored MP4 from ARTIFACTS through the authenticated file route", async () => {
    const { env, getArtifact, getGeneralFile, request } = fixture();
    const response = await handleFiles(request(), env);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("video/mp4");
    expect(response?.headers.get("content-disposition")).toContain("inline");
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response?.arrayBuffer() ?? new ArrayBuffer(0))).toEqual(bytes);
    expect(getArtifact).toHaveBeenCalledExactlyOnceWith(storageKey);
    expect(getGeneralFile).not.toHaveBeenCalled();
  });

  it("refuses a different signed-in user before reading R2", async () => {
    const { env, getArtifact, request } = fixture();
    const response = await handleFiles(request("other@example.test"), env);
    expect(response?.status).toBe(404);
    expect(getArtifact).not.toHaveBeenCalled();
  });

  it("requires authentication before reading file metadata or R2", async () => {
    const { env, getArtifact } = fixture();
    const response = await handleFiles(new Request(`https://shiba.test/api/files/${artifactId}/download`), env);
    expect(response?.status).toBe(401);
    expect(getArtifact).not.toHaveBeenCalled();
  });
});
