/** Slack thread mirror. Every room event stays under one thread_ts. */

export const SLACK_STATUS_EDIT_INTERVAL_MS = 3_000;

export interface SlackMirrorCall {
  method: "reactions.add" | "chat.postMessage" | "chat.update";
  channel: string;
  threadTs?: string;
  ts?: string;
  text?: string;
  name?: string;
  replyBroadcast?: boolean;
  at: number;
}

export interface SlackMirrorState {
  calls: SlackMirrorCall[];
  /** (thread_ts, message_kind, editKey) -> Slack ts */
  ids: Map<string, string>;
  statusTs?: string;
  lastStatusEditAt?: number;
  seq: number;
}

export function emptySlackMirror(): SlackMirrorState {
  return { calls: [], ids: new Map(), seq: 0 };
}

function key(threadTs: string, kind: string, editKey: string): string {
  return `${threadTs}\u0000${kind}\u0000${editKey}`;
}

function nextTs(state: SlackMirrorState): string {
  state.seq += 1;
  return `1700000000.000${state.seq}`;
}

export async function mirrorIntake(
  state: SlackMirrorState,
  input: { channel: string; threadTs: string; at: number },
): Promise<void> {
  const idem = key(input.threadTs, "ack", "eyes");
  if (state.ids.has(idem)) return;
  state.calls.push({
    method: "reactions.add",
    channel: input.channel,
    ts: input.threadTs,
    name: "eyes",
    at: input.at,
  });
  state.ids.set(idem, input.threadTs);
}

export async function mirrorStatus(
  state: SlackMirrorState,
  input: { channel: string; threadTs: string; text: string; editKey: string; at: number },
): Promise<void> {
  const idem = key(input.threadTs, "status", input.editKey || "status");
  if (!state.statusTs) {
    const ts = nextTs(state);
    state.calls.push({
      method: "chat.postMessage",
      channel: input.channel,
      threadTs: input.threadTs,
      text: input.text,
      ts,
      at: input.at,
    });
    state.statusTs = ts;
    state.lastStatusEditAt = input.at;
    state.ids.set(idem, ts);
    return;
  }
  if (state.lastStatusEditAt !== undefined && input.at - state.lastStatusEditAt < SLACK_STATUS_EDIT_INTERVAL_MS) return;
  state.calls.push({
    method: "chat.update",
    channel: input.channel,
    ts: state.statusTs,
    text: input.text,
    at: input.at,
  });
  state.lastStatusEditAt = input.at;
  state.ids.set(idem, state.statusTs);
}

export async function mirrorResult(
  state: SlackMirrorState,
  input: { channel: string; threadTs: string; text: string; editKey: string; at: number },
): Promise<void> {
  const idem = key(input.threadTs, "result", input.editKey || "result");
  if (state.ids.has(idem)) return;
  const ts = nextTs(state);
  state.calls.push({
    method: "chat.postMessage",
    channel: input.channel,
    threadTs: input.threadTs,
    text: input.text,
    replyBroadcast: true,
    ts,
    at: input.at,
  });
  state.calls.push({
    method: "reactions.add",
    channel: input.channel,
    ts: input.threadTs,
    name: "white_check_mark",
    at: input.at,
  });
  state.ids.set(idem, ts);
}

/** Deny removes the buttons and the bot says this once. */
export function deniedApprovalReply(): { text: string; blocks: [] } {
  return { text: "Stopped. Nothing ran.", blocks: [] };
}
