import type { Env } from "./env.js";
import { redactSecrets } from "./security.js";

export interface RunRoomIdentity {
  ownerId: string;
  sessionId: string;
  runId: string;
}

export type RunRoomEvent =
  | { kind: "terminal"; stream: "stdout" | "stderr"; data: string }
  | { kind: "status"; status: string; message?: string }
  | { kind: "diff"; data: string; reset: boolean; complete: boolean }
  | { kind: "child"; childId: string; status: string; message?: string };

export interface RunRoomFrame {
  type: "run:event";
  sequence: number;
  eventId: string;
  runId: string;
  createdAt: number;
  event: RunRoomEvent;
}

export const RUN_ROOM_CHUNK_CHARS = 4_000;
export const MAX_RUN_ROOM_EVENTS = 2_048;
export const RUN_ROOM_RPC_TIMEOUT_MS = 2_000;
const MAX_TERMINAL_LINE_CHARS = 65_536;
const MAX_PUBLISHED_CHARS = 4_000_000;

export function runRoomName(ownerId: string, sessionId: string): string {
  return JSON.stringify([ownerId.trim().toLowerCase(), sessionId]);
}

export function isRunRoomEvent(value: unknown): value is RunRoomEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  const shortText = (text: unknown, max = RUN_ROOM_CHUNK_CHARS) => typeof text === "string" && text.length <= max;
  if (event.kind === "terminal") {
    return (event.stream === "stdout" || event.stream === "stderr") && shortText(event.data);
  }
  if (event.kind === "diff") {
    return shortText(event.data) && typeof event.reset === "boolean" && typeof event.complete === "boolean";
  }
  if (event.kind === "status" || event.kind === "child") {
    return shortText(event.status, 80) && (event.message === undefined || shortText(event.message)) &&
      (event.kind !== "child" || shortText(event.childId, 200));
  }
  return false;
}

/** Server binding only. Browser frames cannot append to the run event log. */
export async function publishRunRoomEvent(
  env: Env,
  identity: RunRoomIdentity,
  event: RunRoomEvent,
  eventId: string = crypto.randomUUID(),
): Promise<number> {
  if (!isRunRoomEvent(event)) throw new Error("Invalid run room event.");
  return env.ConversationRoom.getByName(runRoomName(identity.ownerId, identity.sessionId))
    .appendRunEvent(identity, eventId, event);
}

/** Preserve stream order and redact full lines before splitting wire frames. */
export function createRunRoomPublisher(
  env: Env,
  identity: RunRoomIdentity,
  scrub: (text: string) => string = redactSecrets,
) {
  let pending = Promise.resolve();
  let failure: unknown;
  let publishedChars = 0;
  let overflow = false;
  let failedFrames = 0;
  let gapEventId: string | undefined;
  let paused = false;
  const lines = { stdout: "", stderr: "" };
  const dropping = { stdout: false, stderr: false };
  const deliver = async (event: RunRoomEvent, eventId: string): Promise<boolean> => {
    const append = async (): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          publishRunRoomEvent(env, identity, event, eventId),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Live room delivery timed out.")), RUN_ROOM_RPC_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    try {
      await append();
      return true;
    } catch {
      // The same id makes a retry safe when the first response was lost.
      try {
        await append();
        return true;
      } catch (error) {
        failure ??= error;
        paused = true;
        return false;
      }
    }
  };
  const deliverGap = async (): Promise<boolean> => {
    gapEventId ??= crypto.randomUUID();
    const delivered = await deliver({ kind: "status", status: "stream_gap", message: "Some live output could not be delivered." }, gapEventId);
    if (delivered) { failedFrames = 0; gapEventId = undefined; }
    return delivered;
  };
  const publish = (event: RunRoomEvent): Promise<void> => {
    const size = JSON.stringify(event).length;
    if (publishedChars + size > MAX_PUBLISHED_CHARS) {
      if (overflow) return pending;
      overflow = true;
      event = { kind: "status", status: "stream_limited", message: "Live output reached its retention limit." };
    }
    publishedChars += size;
    const eventId = crypto.randomUUID();
    const next = event;
    pending = pending.then(async () => {
      if (paused) { failedFrames++; return; }
      if (failedFrames > 0 && !await deliverGap()) { failedFrames++; return; }
      if (!await deliver(next, eventId)) failedFrames++;
    });
    return pending;
  };
  const safe = (text: string) => redactSecrets(scrub(text));
  const writeLine = (stream: "stdout" | "stderr", line: string) => {
    const text = safe(line);
    for (let offset = 0; offset < text.length; offset += RUN_ROOM_CHUNK_CHARS) {
      void publish({ kind: "terminal", stream, data: text.slice(offset, offset + RUN_ROOM_CHUNK_CHARS) });
    }
  };
  return {
    publish,
    terminal(stream: "stdout" | "stderr", data: string): void {
      if (dropping[stream]) {
        const end = data.indexOf("\n");
        if (end < 0) return;
        dropping[stream] = false;
        data = data.slice(end + 1);
      }
      lines[stream] += data;
      for (;;) {
        const end = lines[stream].indexOf("\n");
        if (end < 0) break;
        const line = lines[stream].slice(0, end + 1);
        lines[stream] = lines[stream].slice(end + 1);
        if (line.length <= MAX_TERMINAL_LINE_CHARS) writeLine(stream, line);
        else writeLine(stream, "[Output line exceeded the safety limit.]\n");
      }
      if (lines[stream].length > MAX_TERMINAL_LINE_CHARS) {
        lines[stream] = "";
        dropping[stream] = true;
        writeLine(stream, "[Output line exceeded the safety limit.]\n");
      }
    },
    diff(diff: string): Promise<void> {
      const text = safe(diff);
      if (!text) return publish({ kind: "diff", data: "", reset: true, complete: true });
      for (let offset = 0; offset < text.length; offset += RUN_ROOM_CHUNK_CHARS) {
        void publish({
          kind: "diff", data: text.slice(offset, offset + RUN_ROOM_CHUNK_CHARS),
          reset: offset === 0, complete: offset + RUN_ROOM_CHUNK_CHARS >= text.length,
        });
      }
      return pending;
    },
    async flush(): Promise<void> {
      for (const stream of ["stdout", "stderr"] as const) {
        if (lines[stream]) writeLine(stream, lines[stream]);
        lines[stream] = "";
      }
      await pending;
      if (failedFrames > 0) await deliverGap();
      if (failure) throw failure;
    },
  };
}
