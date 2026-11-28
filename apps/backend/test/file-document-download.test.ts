import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleFiles } from "../src/files/files-routes.js";

const artifactId = "file_0123456789abcdef01234567";
const owner = "owner@example.test";
const html = "<!doctype html><h1>Launch</h1>";

function fixture(row: { name: string; mime: string; r2_key: string }) {
  const get = vi.fn(async () => ({ body: new TextEncoder().encode(html) }));
  const stored = {
    id: artifactId, workspace_id: "self-hosted", scope: "personal", created_by: owner,
    size: html.length, sha256: "a".repeat(64), version: 1, created_at: 100, updated_at: 100, archived_at: null, ingestion_state: "done", ...row,
  };
  const env = { REQUIRE_ACCESS: true, AGENT_AUDIT: { prepare: () => ({ bind: () => ({ first: async () => stored }) }) }, FILES: { get } } as unknown as Env;
  const request = (suffix: string, userId: string | null = owner) => new Request(`https://shiba.test/api/files/${artifactId}/${suffix}`, {
    headers: userId ? { "CF-Access-Authenticated-User-Email": userId } : {},
  });
  return { env, get, request, stored };
}
const generatedPage = { name: "Launch “v2”.html", mime: "text/html", r2_key: "generated-documents/self-hosted/a.html" };

describe("generated page preview", () => {
  it("serves the page inline only under a script-free CSP sandbox", async () => {
    const { env, request } = fixture(generatedPage);
    const response = await handleFiles(request("preview"), env);
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe(html);
    expect(Object.fromEntries(response!.headers)).toMatchObject({
      "content-type": "text/html; charset=utf-8",
      "content-disposition": "inline",
      "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "private, no-store",
    });
  });

  it.each([
    ["an uploaded HTML file", { name: "site.html", mime: "text/html", r2_key: "files/self-hosted/site.html" }],
    ["a generated report", { name: "Brief.md", mime: "text/markdown", r2_key: "generated-documents/self-hosted/a.md" }],
  ])("refuses to preview %s", async (_label, row) => {
    const { env, get, request } = fixture(row);
    expect((await handleFiles(request("preview"), env))?.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });


  it("does not reopen an archived generated page", async () => {
    const { env, get, request, stored } = fixture(generatedPage);
    (stored as { archived_at: number | null }).archived_at = 200;
    expect((await handleFiles(request("preview"), env))?.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it("checks the reader before touching R2", async () => {
    const { env, get, request } = fixture(generatedPage);
    expect((await handleFiles(request("preview", "other@example.test"), env))?.status).toBe(404);
    expect((await handleFiles(request("preview", null), env))?.status).toBe(401);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("markup downloads", () => {
  it.each([
    [generatedPage],
    [{ name: "site.html", mime: "text/html", r2_key: "files/self-hosted/site.html" }],
    [{ name: "logo.svg", mime: "image/svg+xml", r2_key: "files/self-hosted/logo.svg" }],
    [{ name: "Brief.md", mime: "text/markdown", r2_key: "generated-documents/self-hosted/a.md" }],
  ])("downloads %j as a sandboxed attachment", async (row) => {
    const { env, request } = fixture(row);
    const response = await handleFiles(request("download"), env);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-disposition")).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
    expect(response?.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'; base-uri 'none'; form-action 'none'");
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("encodes a non-ASCII title without breaking the header", async () => {
    const { env, request } = fixture(generatedPage);
    const disposition = (await handleFiles(request("download"), env))?.headers.get("content-disposition");
    expect(disposition).toBe("attachment; filename=\"Launch _v2_.html\"; filename*=UTF-8''Launch%20%E2%80%9Cv2%E2%80%9D.html");
  });
});
