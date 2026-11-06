import { SandboxError } from "../errors.js";
import type { ExecResult, JournalExecutionInput, JournalPage, JournalState, SandboxInstance } from "../types.js";

export interface JournalRpc {
  startExecution(input: JournalExecutionInput): Promise<{ jobId: string; state: JournalState }>;
  readExecution(jobId: string, after: number): Promise<JournalPage>;
  cancelExecution(jobId: string): Promise<{ jobId: string; state: JournalState }>;
}

const RPC_TIMEOUT_MS = 5_000;
const RECOVERY_TIMEOUT_MS = 30_000;
const MAX_DEADLINE_MS = 15 * 60_000;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_FRAMES = 4_096;
const OUTPUT_TAIL_CHARS = 512_000;
const STATES: readonly JournalState[] = ["starting", "running", "exited", "cancelled", "timed_out", "limited", "lost"];
type ExecOptions = NonNullable<Parameters<SandboxInstance["exec"]>[1]>;

function failure(message: string, code: "unknown" | "timeout" | "capability_unsupported" = "unknown") {
  return new SandboxError(code, message, { provider: "cloudflare" });
}

async function bounded<T>(operation: () => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(signal?.reason ?? failure("Execution cancelled."));
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => reject(failure("Execution journal RPC timed out.", "timeout")), Math.max(1, timeoutMs));
      Promise.resolve().then(() => {
        signal?.throwIfAborted();
        return operation();
      }).then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? failure("Execution cancelled.")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, Math.max(1, ms));
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function decodeFrame(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length > 5_464 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw failure("Execution journal contains an invalid output frame.");
  }
  const raw = atob(value);
  if (!raw.length || raw.length > 4_096 || btoa(raw) !== value) throw failure("Execution journal contains an invalid output frame.");
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

/** Retry reads of one supervised job. A lost launch response never grants another launch. */
export async function executeJournaled(rpc: JournalRpc, command: string, opts: ExecOptions): Promise<ExecResult> {
  const journal = opts.journal;
  const now = Date.now();
  const cwd = opts.cwd ?? "/workspace";
  const attaching = journal?.mode === "attach";
  const observationDeadline = attaching ? journal?.observationDeadline : journal?.deadline;
  if (!journal || !/^[a-f0-9]{64}$/.test(journal.jobId) || !Number.isSafeInteger(journal.deadline) || journal.deadline <= 0 ||
    (journal.mode !== undefined && journal.mode !== "start" && journal.mode !== "attach") ||
    !Number.isSafeInteger(observationDeadline) || observationDeadline! <= now ||
    (attaching ? observationDeadline! < journal.deadline || observationDeadline! > now + 45 * 60_000
      : journal.deadline <= now || journal.deadline > now + MAX_DEADLINE_MS)) {
    throw failure("Invalid execution journal identity or deadline.");
  }
  if (!command || command.includes("\0") || new TextEncoder().encode(command).byteLength > 65_536 || !cwd.startsWith("/") ||
    cwd.includes("\0") || new TextEncoder().encode(cwd).byteLength > 1_024 ||
    (opts.env && (Object.keys(opts.env).length > 64 || new TextEncoder().encode(JSON.stringify(opts.env)).byteLength > 65_536))) {
    throw failure("Execution journal input exceeds its supported bounds.");
  }
  const { jobId, deadline } = journal;
  let launched = false;
  let settled = false;
  let cursor = 0;
  let sourceBytes = 0;
  let stdout = "";
  let stderr = "";
  let failureSince: number | undefined;
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const output = async (stream: "stdout" | "stderr", text: string) => {
    if (!text) return;
    const remaining = observationDeadline! - Date.now();
    if (remaining <= 0) throw failure("The original execution deadline expired.", "timeout");
    await bounded(async () => { await opts.onOutput?.(stream, text); }, remaining, opts.signal);
    if (stream === "stdout") stdout = `${stdout}${text}`.slice(-OUTPUT_TAIL_CHARS);
    else stderr = `${stderr}${text}`.slice(-OUTPUT_TAIL_CHARS);
  };
  try {
    opts.signal?.throwIfAborted();
    launched = true;
    if (!attaching) {
      try {
        await bounded(() => rpc.startExecution({ jobId, command, cwd, deadline, ...(opts.env ? { env: opts.env } : {}) }),
          Math.min(RPC_TIMEOUT_MS, deadline - Date.now()), opts.signal);
      } catch {
        opts.signal?.throwIfAborted();
        // Only the retained claim can establish whether the first launch was accepted.
      }
    }
    for (;;) {
      opts.signal?.throwIfAborted();
      const remaining = observationDeadline! - Date.now();
      if (remaining <= 0) throw failure("The original execution deadline expired.", "timeout");
      let page: JournalPage;
      try {
        page = await bounded(() => rpc.readExecution(jobId, cursor), Math.min(RPC_TIMEOUT_MS, remaining), opts.signal);
        failureSince = undefined;
      } catch {
        opts.signal?.throwIfAborted();
        failureSince ??= Date.now();
        if (Date.now() - failureSince >= RECOVERY_TIMEOUT_MS) {
          throw failure("Execution journal recovery stopped. The command was not relaunched.");
        }
        await pause(Math.min(250, Math.max(1, observationDeadline! - Date.now())), opts.signal);
        continue;
      }
      if (!page || page.jobId !== jobId || !STATES.includes(page.state) || !Array.isArray(page.frames) ||
        page.frames.length > 64 || typeof page.done !== "boolean" || !Number.isSafeInteger(page.cursor) || page.cursor < cursor ||
        page.cursor > MAX_FRAMES || page.cursor !== cursor + page.frames.length) {
        throw failure("Execution journal returned an invalid page.");
      }
      const decoded = page.frames.map((frame, index) => {
        if (!frame || frame.sequence !== cursor + index + 1 || (frame.stream !== "stdout" && frame.stream !== "stderr")) {
          throw failure("Execution journal returned a gap or reordered output.");
        }
        const bytes = decodeFrame(frame.dataBase64);
        sourceBytes += bytes.byteLength;
        if (sourceBytes > MAX_SOURCE_BYTES) throw failure("Execution journal exceeded its output bound.");
        return { source: frame, stream: frame.stream, bytes };
      });
      for (const frame of decoded) {
        if (opts.onJournalFrame) await bounded(() => opts.onJournalFrame!(frame.source), observationDeadline! - Date.now(), opts.signal);
        await output(frame.stream, decoders[frame.stream].decode(frame.bytes, { stream: true }));
      }
      cursor = page.cursor;
      if (page.done) {
        const exitCode = page.exitCode;
        if (page.state !== "exited" || typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
          throw failure(`Execution journal ended with ${page.state}. The command was not relaunched.`);
        }
        await output("stdout", decoders.stdout.decode());
        await output("stderr", decoders.stderr.decode());
        settled = true;
        return { stdout, stderr, exitCode };
      }
      if (page.state !== "starting" && page.state !== "running" && !page.frames.length) {
        throw failure("Execution journal has an incomplete terminal receipt.");
      }
      if (!page.frames.length) await pause(Math.min(250, Math.max(1, observationDeadline! - Date.now())), opts.signal);
    }
  } finally {
    if (launched && !settled) {
      await bounded(() => rpc.cancelExecution(jobId), 2_000).catch(() => undefined);
    }
  }
}
