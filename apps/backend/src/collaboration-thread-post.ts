/**
 * Seam for room thread posts. The rooms workstream owns the real writer.
 * This stub keeps the call site typed until that module replaces it.
 */
export interface RoomThreadPost {
  roomId: string;
  threadRootId?: string | null;
  kind: "ack" | "status" | "milestone" | "result" | "question_card" | "approval_card";
  payload: Record<string, unknown>;
  editKey?: string;
}

export async function postRoomEvent(
  _env: unknown,
  _event: RoomThreadPost,
): Promise<{ posted: false }> {
  return { posted: false };
}