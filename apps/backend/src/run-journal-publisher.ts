import type { JournalFrame } from "@shiba/sandbox";
import type { Env } from "./env.js";
import { redactSecrets } from "./security.js";
import {
  MAX_RUN_JOURNAL_FRAMES, MAX_RUN_JOURNAL_CHARS, RUN_ROOM_CHUNK_CHARS, RUN_ROOM_RPC_TIMEOUT_MS, runRoomName,
  type RunJournalBatch, type RunJournalIdentity, type RunRoomIdentity,
} from "./run-room-events.js";

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_FRAME_BYTES = 4_096;
const MAX_LINE_BYTES = 65_536;
const MAX_REDACTED_LINE_CHARS = 65_536;
const MAX_REDACTED_BATCH_CHARS = 128_000;
const LINE_NOTICE = "[Output line exceeded the safety limit.]\n";
type Stream = "stdout" | "stderr";

async function bounded<T>(operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Journal room delivery timed out.")), RUN_ROOM_RPC_TIMEOUT_MS); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function eventId(journal: RunJournalIdentity, stream: Stream, from: number, through: number, final: boolean, chunk: number): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([
    "shiba:journal-room:v1", journal.jobId, journal.generation, stream, from, through, final, chunk,
  ])))).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 15) | 80;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Only complete, scrubbed lines cross the binding. Unfinished raw bytes stay in memory. */
export async function createRunJournalPublisher(
  env: Env,
  identity: RunRoomIdentity,
  journal: RunJournalIdentity,
  scrub: (text: string) => string = redactSecrets,
) {
  const room = env.ConversationRoom.getByName(runRoomName(identity.ownerId, identity.sessionId));
  let acknowledged = await bounded(() => room.openRunJournal(identity, journal));
  if (!Number.isSafeInteger(acknowledged) || acknowledged < 0 || acknowledged > MAX_RUN_JOURNAL_FRAMES) throw new Error("Invalid durable journal acknowledgment.");
  let readSequence = 0;
  let sourceBytes = 0;
  let publishedChars = 0;
  let ended = false;
  let failure: unknown;
  let accepting = false;
  const buffers: Record<Stream, number[]> = { stdout: [], stderr: [] };
  const dropping = { stdout: false, stderr: false };
  const fromSequence = { stdout: 0, stderr: 0 };
  const safe = (bytes: number[]) => {
    const text = redactSecrets(scrub(new TextDecoder().decode(new Uint8Array(bytes))));
    return text.length <= MAX_REDACTED_LINE_CHARS ? text : LINE_NOTICE;
  };
  const append = async (sourceSequence: number, through: number, outputs: Array<{ stream: Stream; from: number; text: string }>, final: boolean) => {
    const events: RunJournalBatch["events"] = [];
    for (const output of outputs) {
      publishedChars += output.text.length;
      if (publishedChars > MAX_RUN_JOURNAL_CHARS) throw new Error("Redacted journal output exceeded its bound.");
      for (let offset = 0, index = 0; offset < output.text.length; offset += RUN_ROOM_CHUNK_CHARS, index++) {
        events.push({
          eventId: await eventId(journal, output.stream, output.from, sourceSequence, final, index),
          event: { kind: "terminal", stream: output.stream, data: output.text.slice(offset, offset + RUN_ROOM_CHUNK_CHARS) },
        });
      }
    }
    const batch = { ...journal, sourceSequence, acknowledgedThrough: through, events };
    let next: number;
    try { next = await bounded(() => room.appendRunJournalBatch(identity, batch)); }
    catch { next = await bounded(() => room.appendRunJournalBatch(identity, batch)); }
    if (!Number.isSafeInteger(next) || next < acknowledged || next > sourceSequence) throw new Error("Journal publisher was superseded or received an invalid acknowledgment.");
    acknowledged = next;
  };
  const exclusive = async (operation: () => Promise<void>) => {
    if (failure) throw failure;
    if (accepting) throw new Error("Journal source callbacks must be awaited in order.");
    accepting = true;
    try { await operation(); }
    catch (error) { failure = error; throw error; }
    finally { accepting = false; }
  };
  return {
    get acknowledgedThrough(): number { return acknowledged; },
    async accept(frame: JournalFrame): Promise<void> {
      await exclusive(async () => {
        if (ended || !Number.isSafeInteger(frame.sequence) || frame.sequence !== readSequence + 1 || frame.sequence > MAX_RUN_JOURNAL_FRAMES ||
          (frame.stream !== "stdout" && frame.stream !== "stderr") || typeof frame.dataBase64 !== "string" ||
          frame.dataBase64.length > 5_464 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.dataBase64)) {
          throw new Error("Invalid journal source frame.");
        }
        const raw = atob(frame.dataBase64);
        if (!raw.length || raw.length > MAX_FRAME_BYTES || btoa(raw) !== frame.dataBase64 || (sourceBytes += raw.length) > MAX_SOURCE_BYTES) throw new Error("Journal source exceeded its byte bound.");
        readSequence = frame.sequence;
        if (frame.sequence <= acknowledged) return;
        const stream = frame.stream;
        const from = fromSequence[stream] || frame.sequence;
        let output = "";
        for (let index = 0; index < raw.length; index++) {
          const byte = raw.charCodeAt(index);
          fromSequence[stream] ||= frame.sequence;
          if (!dropping[stream]) buffers[stream].push(byte);
          if (buffers[stream].length > MAX_LINE_BYTES) { buffers[stream] = []; dropping[stream] = true; }
          if (byte === 10) {
            output += dropping[stream] ? LINE_NOTICE : safe(buffers[stream]);
            if (output.length > MAX_REDACTED_BATCH_CHARS) throw new Error("Redacted journal batch exceeded its bound.");
            buffers[stream] = [];
            dropping[stream] = false;
            fromSequence[stream] = 0;
          }
        }
        const complete = !buffers.stdout.length && !buffers.stderr.length && !dropping.stdout && !dropping.stderr;
        await append(frame.sequence, complete ? frame.sequence : acknowledged, output ? [{ stream, from, text: output }] : [], false);
      });
    },
    async end(): Promise<void> {
      await exclusive(async () => {
        if (ended) return;
        const outputs: Array<{ stream: Stream; from: number; text: string }> = [];
        for (const stream of ["stdout", "stderr"] as const) {
          if (buffers[stream].length || dropping[stream]) outputs.push({
            stream, from: fromSequence[stream], text: dropping[stream] ? LINE_NOTICE : safe(buffers[stream]),
          });
        }
        await append(readSequence, readSequence, outputs, true);
        buffers.stdout = []; buffers.stderr = [];
        ended = true;
      });
    },
  };
}
