import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { handleKnowledgeOutputs } from "../src/knowledge/knowledge-outputs-routes.js";
import { insertFileRecord } from "../src/files/files-store.js";
import { MAX_DOCUMENT_BYTES, saveGeneratedDocument, unsafePageMarkup } from "../src/tools/document-gen.js";

vi.mock("../src/request-auth.js", async (original) => ({ ...await original<typeof import("../src/request-auth.js")>(), resolveRequestIdentity: async (request: Request) => ({ authorized: request.headers.has("x-test-user"), userId: request.headers.get("x-test-user") }) }));
vi.mock("../src/org-request-auth.js", () => ({ resolveOrgForApiRequest: async () => ({ orgId: "team:ws", workspace: { workspaceId: "ws" } }) }));

const databases: Array<{ close(): void }> = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const { database, sqlite } = customAgentD1({ bare: true });
  databases.push(sqlite);
  for (const name of ["0050_files_notes.sql", "0062_media_generations.sql"]) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  sqlite.exec("CREATE TABLE run_output_archive_reservations (id TEXT, run_id TEXT, created_at INTEGER, owner_id TEXT, state TEXT, expires_at INTEGER)");
  const objects = new Map<string, Uint8Array>();
  const put = vi.fn(async (key: string, bytes: Uint8Array) => { objects.set(key, bytes); return {}; });
  const remove = vi.fn(async (key: string) => { objects.delete(key); });
  const env = { FILES: { put, delete: remove }, AGENT_AUDIT: database } as unknown as Env;
  return { env, sqlite, objects, put, remove };
}
const context = { runId: "chat-1", userId: "alice", workspaceId: "ws" };
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const list = (env: Env, query: string, user = "alice") => handleKnowledgeOutputs(new Request(`https://app.test/api/outputs${query}`, { headers: { "x-test-user": user } }), env)
  .then(async (response) => (await response!.json()) as { items: Array<{ id: string; title: string; mime: string; documentKind?: string }> });

describe("generated reports", () => {
  it("saves the Markdown with an escaped source list as a private file and returns no storage key or body", async () => {
    const { env, sqlite, objects } = fixture();
    const result = await saveGeneratedDocument(env, "report", {
      title: "Q3 market brief",
      markdown: "# Q3 market brief\n\nDemand grew [1]. <script>alert(1)</script>",
      sources: [{ title: "Survey [draft]", url: "https://example.test/survey?q=1" }, { title: "Interview notes" }],
    }, context);
    expect(result).toMatchObject({ ok: true, kind: "report", title: "Q3 market brief", mime: "text/markdown", sourceCount: 2, artifactId: expect.stringMatching(/^file_[a-f0-9]{24}$/) });
    expect(JSON.stringify(result)).not.toMatch(/generated-documents|Demand grew/);
    const row = sqlite.prepare("SELECT name, mime, scope, created_by, ingestion_state, r2_key, size FROM files").get() as Record<string, unknown>;
    expect(row).toMatchObject({ name: "Q3 market brief.md", mime: "text/markdown", scope: "personal", created_by: "alice", ingestion_state: "done" });
    expect(String(row.r2_key)).toMatch(/^generated-documents\/ws\/[0-9a-f-]+\.md$/);
    const saved = text(objects.get(String(row.r2_key)));
    expect(saved).toContain("Demand grew [1].");
    expect(saved).toContain("## Sources\n\n1. [Survey \\[draft\\]](https://example.test/survey?q=1)\n2. Interview notes\n");
    expect(row.size).toBe(new TextEncoder().encode(saved).byteLength);
  });

  it.each([
    [{ title: "", markdown: "x" }, "title"],
    [{ title: "Two\nlines", markdown: "x" }, "one-line"],
    [{ title: "Brief", markdown: "x", sources: [{ title: "Bad", url: "javascript:alert(1)" }] }, "http or https"],
    [{ title: "Brief", markdown: "x", sources: [{ title: "Creds", url: "https://user:pw@example.test" }] }, "http or https"],
    [{ title: "Brief", markdown: "x", extra: true }, ""],
  ])("refuses invalid input before storage: %j", async (input, message) => {
    const { env, put } = fixture();
    const result = await saveGeneratedDocument(env, "report", input, context);
    expect(result.ok).toBe(false);
    if (message) expect(JSON.stringify(result)).toMatch(new RegExp(message, "i"));
    expect(put).not.toHaveBeenCalled();
  });

  it("counts the final UTF-8 bytes against the limit", async () => {
    const { env, put } = fixture();
    const result = await saveGeneratedDocument(env, "report", { title: "Long", markdown: "é".repeat(MAX_DOCUMENT_BYTES / 2 + 1) }, context);
    expect(result).toEqual({ ok: false, error: "Keep the report under 128 KB." });
    expect(put).not.toHaveBeenCalled();
  });

  it("needs a signed-in user and storage", async () => {
    const { env, put } = fixture();
    expect(await saveGeneratedDocument(env, "report", { title: "Brief", markdown: "x" }, { runId: "r" })).toMatchObject({ ok: false });
    expect(await saveGeneratedDocument({ AGENT_AUDIT: env.AGENT_AUDIT } as Env, "report", { title: "Brief", markdown: "x" }, context)).toMatchObject({ ok: false });
    expect(put).not.toHaveBeenCalled();
  });

  it("removes the stored bytes when the file record cannot be written", async () => {
    const { env, sqlite, objects, remove } = fixture();
    sqlite.exec("CREATE TRIGGER fail_files BEFORE INSERT ON files BEGIN SELECT RAISE(FAIL, 'nope'); END");
    expect(await saveGeneratedDocument(env, "report", { title: "Brief", markdown: "x" }, context)).toEqual({ ok: false, error: "Your report could not be saved. Please try again." });
    expect(remove).toHaveBeenCalledOnce();
    expect(objects.size).toBe(0);
  });
});

describe("generated pages", () => {
  it("saves a static page with a restrictive policy and returns its preview path", async () => {
    const { env, sqlite, objects } = fixture();
    const html = "<!doctype html><html><head><title>Launch</title><style>body{color:#123}</style></head><body><h1>Launch</h1><img src=\"data:image/png;base64,AAAA\" alt=\"\"><a href=\"https://example.test\">More</a></body></html>";
    const result = await saveGeneratedDocument(env, "page", { title: "Launch page", html }, context);
    expect(result).toMatchObject({ ok: true, kind: "page", mime: "text/html", previewPath: expect.stringMatching(/^\/api\/files\/file_[a-f0-9]{24}\/preview$/) });
    const row = sqlite.prepare("SELECT name, mime, r2_key FROM files").get() as { name: string; mime: string; r2_key: string };
    expect(row).toMatchObject({ name: "Launch page.html", mime: "text/html" });
    expect(text(objects.get(row.r2_key))).toContain("<head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'\"><title>");
  });

  it.each([
    ["<p>hi</p><script>alert(1)</script>", "script"],
    ["<SCRIPT src=x></SCRIPT>", "script"],
    ["<body onload=\"steal()\">", "event handler"],
    ["<a href=\"javascript:alert(1)\">x</a>", "javascript:"],
    ["<img src=\"https://tracker.test/p.gif\">", "external sources"],
    ["<img srcset=\"https://tracker.test/p.gif 2x\">", "external sources"],
    ["<style>@import url(https://x.test/a.css);</style>", "@import"],
    ["<div style=\"background:url(https://x.test/a.png)\"></div>", "url()"],
    ["<meta http-equiv=\"refresh\" content=\"0;url=https://x.test\">", "meta"],
    ["<form action=\"https://x.test\"><input name=a></form>", "form"],
    ["<iframe src=\"https://x.test\"></iframe>", "embed"],
    ["<base href=\"https://x.test/\">", "base"],
  ])("refuses active or remote markup before storage: %s", async (html, label) => {
    expect(unsafePageMarkup(html)).toContain(label);
    const { env, put } = fixture();
    expect(await saveGeneratedDocument(env, "page", { title: "Page", html }, context)).toMatchObject({ ok: false, error: expect.stringContaining("Make the page static") });
    expect(put).not.toHaveBeenCalled();
  });
});

describe("Outputs lists generated documents", () => {
  it("shows only the caller's generated reports and pages under Documents, never ordinary uploads", async () => {
    const { env } = fixture();
    const report = await saveGeneratedDocument(env, "report", { title: "Brief", markdown: "x" }, context);
    const page = await saveGeneratedDocument(env, "page", { title: "Landing", html: "<h1>Hi</h1>" }, context);
    await saveGeneratedDocument(env, "report", { title: "Bob's brief", markdown: "x" }, { ...context, userId: "bob" });
    for (const [name, mime] of [["notes.md", "text/markdown"], ["site.html", "text/html"]] as const) {
      await insertFileRecord(env, { workspaceId: "ws", scope: "personal", name, mime, size: 1, r2Key: `files/ws/${name}`, sha256: "a".repeat(64), createdBy: "alice", ingestionState: "done" });
    }
    await insertFileRecord(env, { workspaceId: "ws", scope: "personal", name: "fake.md", mime: "text/markdown", size: 1, r2Key: "files/ws/generated-documents/fake.md", sha256: "a".repeat(64), createdBy: "alice", ingestionState: "done" });
    const ids = (items: Array<{ id: string }>) => items.map((item) => item.id).sort();
    const documents = await list(env, "?type=document");
    expect(ids(documents.items)).toEqual([report, page].map((item) => (item as { artifactId: string }).artifactId).sort());
    expect(documents.items.map((item) => [item.title, item.documentKind]).sort()).toEqual([["Brief.md", "report"], ["Landing.html", "page"]]);
    expect(ids((await list(env, "")).items)).toEqual(ids(documents.items));
    expect((await list(env, "?type=image")).items).toEqual([]);
    expect((await list(env, "?type=document", "bob")).items.map((item) => item.title)).toEqual(["Bob's brief.md"]);
  });
});
