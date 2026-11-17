import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { createNote } from "../src/notes/notes-store.js";
import { handleNotes } from "../src/notes/notes-routes.js";
import { buildNoteChatContext } from "../src/notes/note-chat-context.js";
import { listNoteChat } from "../src/notes/note-chat-store.js";

const state = vi.hoisted(() => ({ userId: "alice", generate: vi.fn() }));
vi.mock("ai", () => ({ generateText: state.generate }));
vi.mock("workers-ai-provider", () => ({ createWorkersAI: () => () => ({}) }));
vi.mock("../src/request-auth.js", () => ({
  resolveRequestIdentity: async () => ({ authorized: true, userId: state.userId }),
  requireSameOriginBrowserMutation: (request: Request) => request.headers.get("Origin") === "https://shiba.test" ? null : new Response("Forbidden", { status: 403 }),
}));
vi.mock("../src/org-request-auth.js", () => ({ resolveOrgForApiRequest: async () => ({ workspace: { workspaceId: "ws_chat" } }) }));

function setup() {
  const { database, sqlite } = customAgentD1();
  for (const migration of ["0050_files_notes.sql", "0051_knowledge_indexes.sql", "0061_note_chat.sql"]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const objects = new Map<string, Uint8Array>();
  const env = { AGENT_AUDIT: database, AI: {}, FILES: {
    async put(key: string, bytes: Uint8Array) { objects.set(key, bytes); },
    async get(key: string) { const bytes = objects.get(key); return bytes ? { text: async () => new TextDecoder().decode(bytes) } : null; },
  } } as unknown as Env;
  return { env, sqlite };
}
const request = (id: string, method = "GET", body?: unknown, origin = "https://shiba.test") => new Request(`https://shiba.test/api/notes/${id}/chat`, {
  method, headers: { Origin: origin, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe("private notebook chat", () => {
  beforeEach(() => { state.userId = "alice"; state.generate.mockReset().mockResolvedValue({ text: "An answer" }); });
  it("includes current and mentioned note bodies, saves both messages, and isolates users", async () => {
    const { env } = setup();
    const active = await createNote(env, { workspaceId: "ws_chat", scope: "personal", title: "Draft", markdown: "Active body", createdBy: "alice" });
    const other = await createNote(env, { workspaceId: "ws_chat", scope: "personal", title: "Reference", markdown: "Mentioned body", createdBy: "alice" });
    expect((await handleNotes(request(active.id), env))?.status).toBe(200);
    const response = await handleNotes(request(active.id, "POST", { message: "Summarize", mentions: [{ kind: "note", id: other.id, name: "Reference" }] }), env);
    expect(response?.status).toBe(200);
    expect(JSON.stringify(state.generate.mock.calls[0]?.[0])).toContain("Active body");
    expect(JSON.stringify(state.generate.mock.calls[0]?.[0])).toContain("Mentioned body");
    expect(await listNoteChat(env, active.id, "alice", "ws_chat")).toHaveLength(2);
    expect(await listNoteChat(env, active.id, "bob", "ws_chat")).toEqual([]);
    expect((await handleNotes(request(active.id, "DELETE"), env))?.status).toBe(200);
    expect(await listNoteChat(env, active.id, "alice", "ws_chat")).toEqual([]);
  });
  it("returns 404 for another user's personal note and excludes private and foreign mentions", async () => {
    const { env, sqlite } = setup();
    const active = await createNote(env, { workspaceId: "ws_chat", scope: "personal", title: "Draft", markdown: "Visible", createdBy: "alice" });
    const privateNote = await createNote(env, { workspaceId: "ws_chat", scope: "personal", title: "Secret title", markdown: "Secret body", createdBy: "bob" });
    expect((await handleNotes(request(privateNote.id), env))?.status).toBe(404);
    sqlite.prepare(`INSERT INTO files (id,workspace_id,scope,name,mime,size,r2_key,sha256,version,created_by,created_at,updated_at) VALUES ('foreign','other','personal','Foreign secret','text/plain',1,'secret','hash',1,'alice',1,1)`).run();
    const context = await buildNoteChatContext(env, "alice", active, [
      { kind: "note", id: privateNote.id, name: "user supplied" }, { kind: "file", id: "foreign", name: "user supplied" }, { kind: "note", id: "missing", name: "missing" },
    ]);
    expect(context).toContain("Not available");
    expect(context).not.toMatch(/Secret|Foreign|user supplied/);
  });
  it("validates input, requires same origin, returns friendly errors, and does not persist failed turns", async () => {
    const { env } = setup();
    const note = await createNote(env, { workspaceId: "ws_chat", scope: "personal", title: "Draft", markdown: "Body", createdBy: "alice" });
    expect((await handleNotes(request(note.id, "POST", { message: "" }), env))?.status).toBe(400);
    expect((await handleNotes(request(note.id, "DELETE", undefined, "https://evil.test"), env))?.status).toBe(403);
    expect((await handleNotes(request(note.id, "POST", { message: "Hello" }), { ...env, AI: undefined } as unknown as Env))?.status).toBe(503);
    state.generate.mockRejectedValue(new Error("secret internal error"));
    const response = await handleNotes(request(note.id, "POST", { message: "Hello" }), env);
    expect(response?.status).toBe(502);
    expect(await response?.text()).not.toContain("secret internal");
    expect(await listNoteChat(env, note.id, "alice", "ws_chat")).toEqual([]);
  });
});
