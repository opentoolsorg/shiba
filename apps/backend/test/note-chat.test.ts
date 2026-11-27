import { teamModelMaximumDebitMicroUsd } from "@shiba/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { createNote } from "../src/notes/notes-store.js";
import { handleNotes } from "../src/notes/notes-routes.js";
import { buildNoteChatContext } from "../src/notes/note-chat-context.js";
import { listNoteChat } from "../src/notes/note-chat-store.js";

const state = vi.hoisted(() => ({ userId: "alice", workspaceId: "ws_chat", generate: vi.fn() }));
vi.mock("ai", () => ({ generateText: state.generate }));
vi.mock("workers-ai-provider", () => ({ createWorkersAI: () => () => ({}) }));
vi.mock("../src/request-auth.js", () => ({
  resolveRequestIdentity: async () => ({ authorized: true, userId: state.userId }),
  requireSameOriginBrowserMutation: (request: Request) => request.headers.get("Origin") === "https://shiba.test" ? null : new Response("Forbidden", { status: 403 }),
}));
vi.mock("../src/org-request-auth.js", () => ({ resolveOrgForApiRequest: async () => ({ workspace: { workspaceId: state.workspaceId } }) }));

function setup() {
  const { database, sqlite } = customAgentD1();
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
  beforeEach(() => { state.userId = "alice"; state.workspaceId = "ws_chat"; state.generate.mockReset().mockResolvedValue({ text: "An answer" }); });
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
  it("prefers the live draft body over the saved note body", async () => {
    const { env } = setup();
    const active = await createNote(env, { workspaceId: "ws_chat", scope: "personal", title: "Draft", markdown: "Saved body", createdBy: "alice" });
    const response = await handleNotes(request(active.id, "POST", { message: "Summarize", noteBody: "Unsaved draft" }), env);
    expect(response?.status).toBe(200);
    expect(JSON.stringify(state.generate.mock.calls[0]?.[0])).toContain("Unsaved draft");
    expect(JSON.stringify(state.generate.mock.calls[0]?.[0])).not.toContain("Saved body");
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
  it("uses only prepaid workspace credits for team note chat", async () => {
    const { env, sqlite } = setup();
    const teamWorkspace = "ws_abcdefabcdefabcdefabcdef";
    state.workspaceId = teamWorkspace;
    const note = await createNote(env, { workspaceId: teamWorkspace, scope: "personal", title: "Draft", markdown: "Body", createdBy: "alice" });
    const denied = await handleNotes(request(note.id, "POST", { message: "Hello" }), env);
    expect(denied?.status).toBe(403);
    expect(state.generate).not.toHaveBeenCalled();

    const fundedEnv = { ...env, STRIPE_SECRET_KEY: "sk_test_note_chat", STRIPE_WEBHOOK_SECRET: "whsec_note_chat" } as unknown as Env;
    const unfunded = await handleNotes(request(note.id, "POST", { message: "Hello" }), fundedEnv);
    expect(unfunded?.status).toBe(402);
    expect(state.generate).not.toHaveBeenCalled();

    const maximumMicroUsd = teamModelMaximumDebitMicroUsd(1024, "@cf/zai-org/glm-4.7-flash");
    sqlite.prepare(`INSERT INTO workspace_billing_topups (id,owner,amount_micro_usd,status,created_at) VALUES (?,?,?,?,?)`)
      .run("top_note_chat", `team:${teamWorkspace}`, maximumMicroUsd, "succeeded", 1);
    const exact = await handleNotes(request(note.id, "POST", { message: "Hello" }), fundedEnv);
    expect(exact?.status).toBe(402);
    expect(state.generate).not.toHaveBeenCalled();
    sqlite.prepare(`UPDATE workspace_billing_topups SET amount_micro_usd=? WHERE id='top_note_chat'`).run(maximumMicroUsd + 1);
    const funded = await handleNotes(request(note.id, "POST", { message: "Hello" }), fundedEnv);
    expect(funded?.status).toBe(200);
    expect(state.generate).toHaveBeenCalledOnce();
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM workspace_billing_debits WHERE subject=? AND kind='run'`).get(`team:${teamWorkspace}`)?.count).toBe(1);
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM workspace_billing_pending WHERE subject=?`).get(`team:${teamWorkspace}`)?.count).toBe(0);
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
