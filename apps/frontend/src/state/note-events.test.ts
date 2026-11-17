import { describe, expect, it } from "vitest";
import type { KnowledgeNote, WorkspaceEvent } from "@shiba/shared";
import { patchNotes } from "./note-events";

const note: KnowledgeNote = { id: "note_1", workspaceId: "ws_1", scope: "personal", title: "Draft", sha256: "hash", projectId: null, version: 1, createdBy: "alice", createdAt: 1, updatedAt: 1, ingestion: { state: "pending" } };
const event = (kind: string, value = note): WorkspaceEvent => ({ id: "evt_1", workspaceId: "ws_1", kind, entityId: value.id, at: 1, payload: { note: value } });

describe("note list events", () => {
  it("inserts, updates and deletes metadata without duplicate ids", () => {
    const created = patchNotes([], event("note.created"), "ws_1", "personal");
    expect(created).toEqual([note]);
    const updated = { ...note, title: "New title", version: 2, updatedAt: 2 };
    const result = patchNotes(created, event("note.updated", updated), "ws_1", "personal");
    expect(result).toEqual([updated]);
    expect(patchNotes(result, event("note.created"), "ws_1", "personal")).toBe(result);
    expect(patchNotes(result, event("note.deleted"), "ws_1", "personal")).toEqual([]);
  });

  it("ignores malformed frames and other workspace/scope metadata", () => {
    const notes = [note];
    expect(patchNotes(notes, event("note.updated"), "ws_2", "personal")).toBe(notes);
    expect(patchNotes(notes, event("note.updated"), "ws_1", "workspace")).toBe(notes);
    expect(patchNotes(notes, { ...event("note.updated"), payload: { note: { id: note.id } } }, "ws_1", "personal")).toBe(notes);
  });

  it("only completes ingestion for the matching version", () => {
    const frame = { ...event("note.ingestion.done"), payload: { version: 1 } };
    expect(patchNotes([note], frame, "ws_1", "personal")[0]?.ingestion.state).toBe("done");
    expect(patchNotes([{ ...note, version: 2 }], frame, "ws_1", "personal")[0]?.ingestion.state).toBe("pending");
  });
});
