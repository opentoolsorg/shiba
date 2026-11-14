import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { createNote, NotesConflictError, updateNoteMarkdown } from "../src/notes/notes-store.js";

describe("notes versioning", () => {
  it("requires expectedVersion on autosave", async () => {
    const { database, sqlite } = customAgentD1();
    sqlite.exec(readFileSync(new URL("../migrations/0050_files_notes.sql", import.meta.url), "utf8"));
    sqlite.exec(readFileSync(new URL("../migrations/0051_knowledge_indexes.sql", import.meta.url), "utf8"));
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
});