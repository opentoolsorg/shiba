import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { archiveNote, createNote, NotesConflictError, NotesStoreError, updateNoteMarkdown } from "../src/notes/notes-store.js";

describe("notes versioning", () => {
  it("requires expectedVersion on autosave", async () => {
    const { database } = customAgentD1();
    const objects = new Map<string, Uint8Array>();
    const env = {
      AGENT_AUDIT: database,
      FILES: {
        async put(key: string, value: Uint8Array) { objects.set(key, value); return { key }; },
        async get(key: string) {
          const bytes = objects.get(key);
          return bytes ? { arrayBuffer: async () => bytes.buffer } : null;
        },
      },
    } as unknown as Env;
    const note = await createNote(env, {
      workspaceId: "ws_notes", scope: "personal", title: "Draft", markdown: "Hello", createdBy: "alice@example.test",
    });
  const updated = await updateNoteMarkdown(env, note.id, { markdown: "- [ ] todo item", expectedVersion: 1, title: "Draft" });
    expect(updated.version).toBe(2);
    await expect(updateNoteMarkdown(env, note.id, { markdown: "stale", expectedVersion: 1 })).rejects.toBeInstanceOf(NotesConflictError);
  });

  it("refuses autosaves after a note is archived", async () => {
    const { database } = customAgentD1();
    const env = {
      AGENT_AUDIT: database,
      FILES: { async put(key: string) { return { key }; }, async get() { return null; } },
    } as unknown as Env;
    const note = await createNote(env, {
      workspaceId: "ws_notes", scope: "personal", title: "Draft", markdown: "Hello", createdBy: "alice@example.test",
    });
    await archiveNote(env, note.id);
    await expect(updateNoteMarkdown(env, note.id, { markdown: "late autosave", expectedVersion: 1 })).rejects.toMatchObject({ status: 404 });
  });
});