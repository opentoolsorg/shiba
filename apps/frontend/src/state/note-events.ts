import { knowledgeNoteSchema, type KnowledgeNote, type KnowledgeScope, type WorkspaceEvent } from "@shiba/shared";

/** Metadata only; note bodies continue through the authorized HTTP endpoint. */
export function patchNotes(notes: KnowledgeNote[], event: WorkspaceEvent, workspaceId: string, scope: KnowledgeScope): KnowledgeNote[] {
  if (event.workspaceId !== workspaceId || !event.kind.startsWith("note.")) return notes;
  if (event.kind === "note.ingestion.done") return notes.map((note) => note.id === event.entityId && note.version === event.payload?.version
    ? { ...note, ingestion: { state: "done", error: null } } : note);
  if (event.kind === "note.deleted") return notes.filter((note) => note.id !== event.entityId);
  if (event.kind !== "note.created" && event.kind !== "note.updated") return notes;
  const parsed = knowledgeNoteSchema.safeParse(event.payload?.note);
  if (!parsed.success) return notes;
  const note = parsed.data;
  if (note.id !== event.entityId || note.workspaceId !== workspaceId || note.scope !== scope) return notes;
  const current = notes.find((item) => item.id === note.id);
  if (current && current.version > note.version) return notes;
  return [note, ...notes.filter((item) => item.id !== note.id)].sort((a, b) => b.updatedAt - a.updatedAt);
}
