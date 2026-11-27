import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleNotes } from "../src/notes/notes-routes.js";

const { publish, create, update, get, archive } = vi.hoisted(() => ({ publish: vi.fn(), create: vi.fn(), update: vi.fn(), get: vi.fn(), archive: vi.fn() }));
vi.mock("../src/request-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/request-auth.js")>(),
  resolveRequestIdentity: async () => ({ authorized: true, userId: "alice" }),
  isAuthorizedRequest: async () => true,
  resolveUserId: async () => "alice",
  requireSameOriginBrowserMutation: () => null,
}));
vi.mock("../src/org-request-auth.js", () => ({ resolveOrgForApiRequest: async () => ({ workspace: { workspaceId: "ws_1" } }) }));
vi.mock("../src/knowledge/knowledge-access.js", () => ({ assertKnowledgeRead: async () => {}, assertKnowledgeWrite: async () => {}, KnowledgeAccessError: class extends Error {} }));
vi.mock("../src/knowledge/knowledge-ingestion.js", () => ({ enqueueIngestion: async () => "job_1", filesBucket: vi.fn() }));
vi.mock("../src/platform/workspace-events-do.js", () => ({ publishWorkspaceEvent: publish }));
vi.mock("../src/notes/notes-store.js", () => ({ archiveNote: archive, createNote: create, getNote: get, updateNoteMarkdown: update, listNotes: async () => [], NotesStoreError: class extends Error {}, NotesConflictError: class extends Error {} }));
const note = { id: "note_1", workspaceId: "ws_1", scope: "personal", title: "Title", sha256: "hash", projectId: null, version: 1, createdBy: "alice", createdAt: 1, updatedAt: 1, ingestion: { state: "pending" }, r2Key: "private/body.md" };
const env = { AGENT_AUDIT: {} } as never;

describe("note realtime write paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    create.mockResolvedValue(note); get.mockResolvedValue(note); update.mockResolvedValue({ ...note, version: 2 }); archive.mockResolvedValue({ ...note, archivedAt: 2, updatedAt: 2 }); publish.mockResolvedValue(undefined);
  });
  it("publishes personal create metadata only to its creator", async () => {
    const response = await handleNotes(new Request("https://shiba.test/api/notes", { method: "POST", body: JSON.stringify({ title: "Title", markdown: "Private body" }) }), env);
    expect(response?.status).toBe(201);
    expect(publish).toHaveBeenCalledWith(env, "ws_1", expect.objectContaining({ kind: "note.created", entityId: "note_1", audience: { userIds: ["alice"] } }));
    const frame = publish.mock.calls[0]?.[2];
    expect(frame.payload.note).not.toHaveProperty("r2Key");
    expect(JSON.stringify(frame)).not.toContain("Private body");
  });
  it("publishes versioned updates and keeps HTTP success when delivery fails", async () => {
    publish.mockRejectedValue(new Error("socket unavailable"));
    const response = await handleNotes(new Request("https://shiba.test/api/notes/note_1", { method: "PATCH", body: JSON.stringify({ title: "Changed", markdown: "Body", expectedVersion: 1 }) }), env);
    expect(response?.status).toBe(200);
    expect(publish).toHaveBeenCalledWith(env, "ws_1", expect.objectContaining({ kind: "note.updated", payload: { note: expect.objectContaining({ version: 2 }) } }));
  });
  it("publishes personal deletion only to its creator", async () => {
    const response = await handleNotes(new Request("https://shiba.test/api/notes/note_1", { method: "DELETE" }), env);
    expect(response?.status).toBe(200);
    expect(archive).toHaveBeenCalledWith(env, "note_1");
    expect(publish).toHaveBeenCalledWith(env, "ws_1", expect.objectContaining({ kind: "note.deleted", entityId: "note_1", audience: { userIds: ["alice"] } }));
  });
  it("publishes workspace note metadata to the workspace", async () => {
    create.mockResolvedValue({ ...note, scope: "workspace" });
    await handleNotes(new Request("https://shiba.test/api/notes?scope=workspace", { method: "POST", body: "{}" }), env);
    expect(publish.mock.calls[0]?.[2]).not.toHaveProperty("audience");
  });
});
