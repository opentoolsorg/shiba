/** Room thread message kinds. Payload carries ids only, never message bodies. */
export const THREAD_MESSAGE_KINDS = [
  "text",
  "ack",
  "status",
  "milestone",
  "approval_card",
  "question_card",
  "handoff",
  "handoff_report",
  "result",
  "system",
] as const;

export type ThreadMessageKind = (typeof THREAD_MESSAGE_KINDS)[number];

export interface ThreadMessagePayload {
  approvalId?: string;
  askId?: string;
  runId?: string;
  taskId?: string;
  handoffId?: string;
  pr?: string;
  actorId?: string;
  ownerActorId?: string;
}

export interface PostRoomEventInput {
  roomId: string;
  threadRootId: string | null;
  kind: ThreadMessageKind;
  payload?: ThreadMessagePayload;
  /** Status rows upsert in place. One status row per thread. */
  editKey?: string;
  body?: string;
  alsoInChannel?: boolean;
}

export interface RoomEventAudience {
  userIds?: string[];
  roomId?: string;
}
