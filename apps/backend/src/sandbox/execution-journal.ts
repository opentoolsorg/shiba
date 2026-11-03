import type { JournalExecutionInput, JournalPage, JournalState } from "@shiba/sandbox";

export const EXECUTION_EPOCH_LABEL = "shiba-execution-epoch";
export const JOURNAL_MAX_RUNTIME_MS = 15 * 60_000;
export const JOURNAL_START_GRACE_MS = 5_000;
export const JOURNAL_MAX_REPLY_BYTES = 400_000;

export class JournalIntegrityError extends Error {}

export interface JournalClaim {
  digest: string | null;
  deadline: number;
  createdAt: number;
  epoch: string | null;
  state: JournalState;
}

export function assertJournalJobId(jobId: unknown): asserts jobId is string {
  if (typeof jobId !== "string" || !/^[a-f0-9]{64}$/.test(jobId)) throw new Error("Invalid execution journal identity.");
}

export async function executionInputDigest(input: JournalExecutionInput, now = Date.now()): Promise<string> {
  assertJournalJobId(input.jobId);
  const bytes = (value: string) => new TextEncoder().encode(value).length;
  if (typeof input.command !== "string" || !input.command || input.command.includes("\0") || bytes(input.command) > 65_536 ||
      typeof input.cwd !== "string" || !input.cwd.startsWith("/") || input.cwd.includes("\0") || bytes(input.cwd) > 1_024 ||
      !Number.isSafeInteger(input.deadline) || input.deadline > now + JOURNAL_MAX_RUNTIME_MS) {
    throw new Error("Invalid execution journal request.");
  }
  const env = input.env ?? {};
  if (typeof env !== "object" || env === null || Array.isArray(env)) throw new Error("Invalid execution environment.");
  const entries = Object.entries(env).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (entries.length > 64 || entries.some(([name, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string" || value.includes("\0")) ||
      bytes(JSON.stringify(entries)) > 65_536) throw new Error("Execution environment exceeds its limits.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([
    "shiba:execution-journal:v1", input.jobId, input.command, input.cwd, entries, input.deadline,
  ]))));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function emptyJournalPage(jobId: string, state: JournalState, cursor: number, error?: string): JournalPage {
  return { jobId, state, frames: [], cursor, done: state !== "running" && state !== "starting", ...(error ? { error } : {}) };
}

/** Fixed control program. Only the original approved CLI receives its environment. */
export const EXECUTION_JOURNAL_SOURCE = String.raw`
const fs = require("node:fs");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const ROOT = "/var/lib/shiba-executions";
const MAX_BYTES = 4194304;
const MAX_FRAMES = 4096;
const FRAME_BYTES = 4096;
const PAGE_FRAMES = 64;
const FILE_CAP = 6500000;
const C = fs.constants;
const [action, jobId, cursorText = "0", expectedDigest, expectedDeadline] = process.argv.slice(1);
if (!/^[a-f0-9]{64}$/.test(jobId || "")) throw new Error("Invalid job identity.");
const boot = () => fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const identity = (pid) => {
  try {
    const raw = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
    return { start: fields[19], group: Number(fields[2]), session: Number(fields[3]) };
  } catch { return null; }
};
const instance = () => {
  const pidNamespace = fs.readlinkSync("/proc/self/ns/pid");
  const initStart = identity(1)?.start;
  if (!/^pid:\[\d+\]$/.test(pidNamespace) || typeof initStart !== "string" || !/^\d+$/.test(initStart)) throw new Error("Container identity unavailable.");
  return { pidNamespace, initStart };
};
const sameInstance = (meta) => {
  const current = instance();
  return meta.bootId === boot() && meta.pidNamespace === current.pidNamespace && meta.initStart === current.initStart;
};
const alive = (pid, start) => {
  if (!Number.isSafeInteger(pid) || pid < 1 || typeof start !== "string") return false;
  return identity(pid)?.start === start;
};
const anchor = () => {
  const fs = require("node:fs");
  const cp = require("node:child_process");
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  const chunks = [];
  let size = 0;
  for (;;) {
    const bytes = Buffer.alloc(16384);
    const count = fs.readSync(0, bytes, 0, bytes.length, null);
    if (!count) break;
    size += count;
    if (size > 512000) process.exit(127);
    chunks.push(bytes.subarray(0, count));
  }
  const spec = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  let cancelled = false;
  try { fs.lstatSync(spec.cancelPath); cancelled = true; } catch (e) { if (e.code !== "ENOENT") cancelled = true; }
  if (cancelled || Date.now() >= spec.deadline) { process.exitCode = 143; return; }
  const child = cp.spawn("sh", ["-c", spec.command], {
    cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  child.on("error", () => { process.exitCode = 127; });
  child.on("close", (code, signal) => {
    process.exitCode = Number.isInteger(code) ? code : signal === "SIGTERM" ? 143 : signal === "SIGKILL" ? 137 : 127;
  });
};
const directory = (path, create) => {
  let fd = fs.openSync("/", C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  try {
    for (const part of path.split("/").filter(Boolean)) {
      if (part === "." || part === "..") throw new Error("Invalid directory.");
      const child = "/proc/self/fd/" + fd + "/" + part;
      if (create) { try { fs.mkdirSync(child, { mode: 448 }); } catch (e) { if (e.code !== "EEXIST") throw e; } }
      const next = fs.openSync(child, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      fs.closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (e) { fs.closeSync(fd); throw e; }
};
let rootFd;
try { rootFd = directory(ROOT, action === "start" || action === "cancel"); }
catch (e) {
  if (action === "read" && e.code === "ENOENT") {
    process.stdout.write(JSON.stringify({ jobId, state: "starting", frames: [], cursor: Number(cursorText) || 0, done: false }));
    process.exit(0);
  }
  throw e;
}
const root = "/proc/self/fd/" + rootFd;
const name = root + "/" + jobId;
const cancelName = root + "/" + jobId + ".cancel";
const writeAll = (fd, value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let offset = 0;
  while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
};
const readSafe = (path, cap, growing = false) => {
  const fd = fs.openSync(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(cap)) throw new Error("Unsafe journal file.");
    const size = Number(before.size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = fs.readSync(fd, bytes, offset, size - offset, offset);
      if (!count) throw new Error("Truncated journal file.");
      offset += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(path, { bigint: true });
    if (after.ino !== before.ino || after.dev !== before.dev || named.ino !== before.ino || named.dev !== before.dev ||
        named.isSymbolicLink() || after.size < before.size || after.nlink !== 1n ||
        (!growing && (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs))) {
      throw new Error("Journal changed while reading.");
    }
    return bytes;
  } finally { fs.closeSync(fd); }
};
const cancelled = () => {
  try { readSafe(cancelName, 16); return true; }
  catch (e) { if (e.code === "ENOENT") return false; throw e; }
};
const atomic = (dir, file, value) => {
  const temp = dir + "/" + file + "." + crypto.randomUUID() + ".tmp";
  const fd = fs.openSync(temp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 384);
  try { writeAll(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, dir + "/" + file);
};
const jsonFile = (path) => JSON.parse(readSafe(path, 8192).toString("utf8"));
const jobDirectory = () => fs.openSync(name, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
const result = (data) => process.stdout.write(JSON.stringify(data));
const lost = () => ({ jobId, state: "lost", frames: [], cursor: Number(cursorText) || 0, done: true, error: "Execution journal is unavailable or invalid." });
const main = () => {
  if (action === "settle") {
    const fd = jobDirectory();
    try {
      const dir = "/proc/self/fd/" + fd;
      const meta = jsonFile(dir + "/meta.json");
      const receipt = jsonFile(dir + "/receipt.json");
      if (!expectedDigest || !expectedDeadline || meta.version !== 1 || meta.jobId !== jobId || !sameInstance(meta) ||
          meta.digest !== expectedDigest || meta.deadline !== Number(expectedDeadline) || receipt.state !== "exited" ||
          receipt.version !== 1 || receipt.jobId !== jobId || receipt.bootId !== meta.bootId ||
          receipt.pidNamespace !== meta.pidNamespace || receipt.initStart !== meta.initStart ||
          receipt.digest !== meta.digest || receipt.deadline !== meta.deadline) throw new Error("Settlement instance changed.");
      const chunks = [];
      let size = 0;
      for (;;) {
        const bytes = Buffer.alloc(16384);
        const count = fs.readSync(0, bytes, 0, bytes.length, null);
        if (!count) break;
        size += count;
        if (size > 512000) throw new Error("Settlement request too large.");
        chunks.push(bytes.subarray(0, count));
      }
      const spec = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof spec.command !== "string" || !spec.command || spec.command.includes("\0") || Buffer.byteLength(spec.command) > 65536 ||
          typeof spec.cwd !== "string" || !spec.cwd.startsWith("/") || spec.cwd.includes("\0") || Buffer.byteLength(spec.cwd) > 1024 ||
          !spec.env || typeof spec.env !== "object" || Array.isArray(spec.env) || Object.keys(spec.env).length > 128 ||
          Object.values(spec.env).some(value => typeof value !== "string" || value.includes("\0")) ||
          Buffer.byteLength(JSON.stringify(spec.env)) > 131072) throw new Error("Invalid settlement input.");
      const child = cp.spawn("sh", ["-c", spec.command], { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ["ignore", "inherit", "inherit"] });
      child.on("error", () => { process.exitCode = 127; });
      child.on("close", (code, signal) => {
        process.exitCode = Number.isInteger(code) ? code : signal === "SIGTERM" ? 143 : signal === "SIGKILL" ? 137 : 127;
      });
    } finally { fs.closeSync(fd); }
    return;
  }
  if (action === "cancel") {
    try {
      const fd = fs.openSync(cancelName, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 384);
      try { writeAll(fd, "cancel\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (e) { if (e.code !== "EEXIST") throw e; readSafe(cancelName, 16); }
    result({ jobId, state: "cancelled" });
    return;
  }
  if (action === "read") {
    const cursor = Number(cursorText);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > MAX_FRAMES) throw new Error("Invalid journal cursor.");
    let fd;
    try { fd = jobDirectory(); } catch (e) {
      if (e.code === "ENOENT") { result({ jobId, state: "starting", frames: [], cursor, done: false }); return; }
      throw e;
    }
    try {
      const dir = "/proc/self/fd/" + fd;
      let meta;
      try { meta = jsonFile(dir + "/meta.json"); } catch (e) {
        if (e.code === "ENOENT") { result({ jobId, state: "starting", frames: [], cursor, done: false }); return; }
        throw e;
      }
      if (meta.version !== 1 || meta.jobId !== jobId || !sameInstance(meta) || !/^[a-f0-9]{64}$/.test(meta.digest || "") || !Number.isSafeInteger(meta.deadline) ||
          (expectedDigest && meta.digest !== expectedDigest) || (expectedDeadline && meta.deadline !== Number(expectedDeadline))) throw new Error("Invalid journal metadata.");
      const readReceipt = () => {
        try { return jsonFile(dir + "/receipt.json"); } catch (e) { if (e.code !== "ENOENT") throw e; }
      };
      let receipt = readReceipt();
      if (!receipt && !alive(meta.supervisorPid, meta.supervisorStart)) {
        // Completion publishes its receipt before the supervisor exits.
        receipt = readReceipt();
        if (!receipt) throw new Error("Supervisor no longer exists.");
      }
      if (receipt && (receipt.version !== 1 || receipt.jobId !== jobId || receipt.digest !== meta.digest || receipt.bootId !== meta.bootId ||
          receipt.pidNamespace !== meta.pidNamespace || receipt.initStart !== meta.initStart ||
          receipt.deadline !== meta.deadline ||
          !["exited", "cancelled", "timed_out", "limited", "lost"].includes(receipt.state) || !Number.isSafeInteger(receipt.exitCode) ||
          !Number.isSafeInteger(receipt.lastSequence) || receipt.lastSequence < 0 || receipt.lastSequence > MAX_FRAMES)) throw new Error("Invalid exit receipt.");
      const raw = readSafe(dir + "/journal.jsonl", FILE_CAP, !receipt).toString("utf8");
      const lastNewline = raw.lastIndexOf("\n");
      if (receipt && raw && lastNewline !== raw.length - 1) throw new Error("Truncated journal.");
      const rows = lastNewline < 0 ? [] : raw.slice(0, lastNewline).split("\n").map((line) => JSON.parse(line));
      if (rows.length > MAX_FRAMES) throw new Error("Too many journal frames.");
      let size = 0;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.sequence !== i + 1 || !["stdout", "stderr"].includes(row.stream) || typeof row.dataBase64 !== "string" ||
            row.dataBase64.length > 5464 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.dataBase64)) throw new Error("Invalid frame.");
        const data = Buffer.from(row.dataBase64, "base64");
        if (!data.length || data.length > FRAME_BYTES || data.toString("base64") !== row.dataBase64) throw new Error("Invalid frame bytes.");
        size += data.length;
      }
      if (size > MAX_BYTES || cursor > rows.length || (receipt && (receipt.lastSequence !== rows.length || receipt.totalBytes !== size))) throw new Error("Journal cursor or receipt does not match.");
      const frames = rows.slice(cursor, cursor + PAGE_FRAMES);
      const next = cursor + frames.length;
      result({ jobId, state: receipt?.state || "running", frames, cursor: next, done: Boolean(receipt) && next === rows.length,
        ...(receipt ? { exitCode: receipt.exitCode, ...(receipt.error ? { error: receipt.error } : {}) } : {}) });
    } finally { fs.closeSync(fd); }
    return;
  }
  if (action !== "start") throw new Error("Invalid journal action.");
  const chunks = [];
  let inputBytes = 0;
  for (;;) {
    const chunk = Buffer.alloc(16384);
    const count = fs.readSync(0, chunk, 0, chunk.length, null);
    if (!count) break;
    inputBytes += count;
    if (inputBytes > 512000) throw new Error("Execution request too large.");
    chunks.push(chunk.subarray(0, count));
  }
  const spec = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof spec.command !== "string" || !spec.command || spec.command.includes("\0") || Buffer.byteLength(spec.command) > 65536 ||
      typeof spec.cwd !== "string" || !spec.cwd.startsWith("/") || Buffer.byteLength(spec.cwd) > 1024 ||
      !Number.isSafeInteger(spec.deadline) || !/^[a-f0-9]{64}$/.test(spec.digest || "") ||
      typeof spec.env !== "object" || spec.env === null || Array.isArray(spec.env) ||
      Object.keys(spec.env).length > 72 || Buffer.byteLength(JSON.stringify(spec.env)) > 70000) throw new Error("Invalid execution request.");
  if (cancelled()) return;
  try { fs.mkdirSync(name, { mode: 448 }); } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const fd = jobDirectory();
    try {
      const previous = jsonFile("/proc/self/fd/" + fd + "/meta.json");
      if (previous.digest !== spec.digest || previous.deadline !== spec.deadline || !sameInstance(previous)) throw new Error("Execution claim changed.");
    } finally { fs.closeSync(fd); }
    return;
  }
  const jobFd = jobDirectory();
  const dir = "/proc/self/fd/" + jobFd;
  const log = fs.openSync(dir + "/journal.jsonl", C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 384);
  const meta = { version: 1, jobId, digest: spec.digest, deadline: spec.deadline, bootId: boot(), ...instance(), supervisorPid: process.pid, supervisorStart: identity(process.pid)?.start };
  let sequence = 0;
  let totalBytes = 0;
  let reason;
  let child;
  let childIdentity;
  let finished = false;
  let force;
  let drain;
  let watch;
  const terminate = (nextReason) => {
    reason ||= nextReason;
    if (!child?.pid) return;
    const current = identity(child.pid);
    const matchingLeader = current && current.start === childIdentity?.start && current.group === child.pid && current.session === child.pid;
    const send = (signal) => {
      if (!sameInstance(meta)) return;
      const current = identity(child.pid);
      if (!current || current.start !== childIdentity?.start || current.group !== child.pid || current.session !== child.pid) return;
      try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== "ESRCH") throw e; }
    };
    if (matchingLeader) send("SIGTERM");
    force ||= setTimeout(() => send("SIGKILL"), 250);
    drain ||= setTimeout(() => {
      if (finished) return;
      reason = "lost";
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish(-1);
    }, 1000);
  };
  const finish = (exitCode) => {
    if (finished) return;
    finished = true;
    clearInterval(watch);
    clearTimeout(force);
    clearTimeout(drain);
    try { if (!reason && cancelled()) reason = "cancelled"; } catch { reason = "lost"; }
    if (!reason && Date.now() >= spec.deadline) reason = "timed_out";
    fs.fsyncSync(log);
    fs.closeSync(log);
    atomic(dir, "receipt.json", { ...meta, state: reason || "exited", exitCode, lastSequence: sequence, totalBytes,
      ...(reason ? { error: "Execution ended with status " + reason + "." } : {}) });
    fs.closeSync(jobFd);
    fs.closeSync(rootFd);
  };
  if (cancelled() || Date.now() >= spec.deadline) {
    reason = cancelled() ? "cancelled" : "timed_out";
    atomic(dir, "meta.json", meta);
    finish(-1);
    return;
  }
  child = cp.spawn(process.execPath, ["-e", "(" + anchor.toString() + ")()"], {
    cwd: spec.cwd, env: process.env, detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  childIdentity = child.pid ? identity(child.pid) : null;
  // Publish once while the trusted anchor is still waiting for its input.
  atomic(dir, "meta.json", { ...meta, childPid: child.pid, childStart: childIdentity?.start });
  child.stdin.on("error", () => { try { terminate(cancelled() ? "cancelled" : "lost"); } catch { terminate("lost"); } });
  child.stdin.end(JSON.stringify({ command: spec.command, cwd: spec.cwd, env: spec.env, deadline: spec.deadline, cancelPath: ROOT + "/" + jobId + ".cancel" }));
  const append = (stream, chunk) => {
    if (reason) return;
    for (let offset = 0; offset < chunk.length; offset += FRAME_BYTES) {
      const bytes = chunk.subarray(offset, offset + FRAME_BYTES);
      if (sequence >= MAX_FRAMES || totalBytes + bytes.length > MAX_BYTES) { terminate("limited"); return; }
      writeAll(log, JSON.stringify({ sequence: ++sequence, stream, dataBase64: bytes.toString("base64") }) + "\n");
      totalBytes += bytes.length;
    }
  };
  child.stdout.on("data", (chunk) => { try { append("stdout", chunk); } catch { terminate("lost"); } });
  child.stderr.on("data", (chunk) => { try { append("stderr", chunk); } catch { terminate("lost"); } });
  child.on("error", () => { reason ||= "lost"; });
  child.on("close", (code, signal) => finish(Number.isInteger(code) ? code : signal === "SIGTERM" ? 143 : signal === "SIGKILL" ? 137 : -1));
  watch = setInterval(() => {
    try {
      if (Date.now() >= spec.deadline) terminate("timed_out");
      else if (cancelled()) terminate("cancelled");
    } catch { terminate("lost"); }
  }, 50);
};
try { main(); } catch {
  if (action === "settle") { process.stderr.write("The original execution container is unavailable. Settlement refused.\n"); process.exitCode = 125; }
  else { result(lost()); process.exitCode = 1; }
}
`;
