import type { RunSignal } from "@shiba/shared";
import { scopedExec } from "./exec-allowlist.js";
import type { SandboxOps } from "./runtime.js";
import { shellJoin } from "./security.js";

export type LiveDiffPreview =
  | { status: "ready"; diff: string }
  | { status: "limited" | "unavailable"; reason: string };

export const LIVE_DIFF_MAX_CHARS = 20_000;

// Fixed inline source cannot be replaced by a background process in the worktree.
// All patch text is generated from bounded captured bytes, never mutable temp files.
export const LIVE_DIFF_READER = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const baseline = process.argv[1];
const MAX_PATCH = 20000, MAX_PATHS = 4096, MAX_MANIFEST = 1048576;
const MAX_FILE = 16777216, MAX_BODY = 1048576, MAX_TOTAL = 67108864;
const deadline = Date.now() + 3500;
const descriptors = [];
let total = 0;
function stop(status, reason) { throw { previewStatus: status, previewReason: reason }; }
function limited() { stop("limited", "The live diff exceeds its bounded preview limits. The final captured diff remains authoritative."); }
function unavailable() { stop("unavailable", "A complete live diff could not be captured safely. The final captured diff remains authoritative."); }
function checkTime() { if (Date.now() >= deadline) limited(); }
const gitEnv = {
  PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0",
};
let root, rootFd, gitFd;
function git(args, cap) {
  checkTime();
  const out = spawnSync("git", ["--git-dir=/proc/self/fd/3", "--work-tree=/proc/self/fd/4", "--no-replace-objects",
    "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false", ...args], {
    cwd: root, env: gitEnv, stdio: ["ignore", "pipe", "pipe", gitFd, rootFd],
    maxBuffer: cap + 1, timeout: Math.max(1, deadline - Date.now()),
  });
  if (out.error || out.signal || out.stdout.length > cap) limited();
  if (out.status !== 0) unavailable();
  return out.stdout;
}
function text(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { unavailable(); }
}
function names(bytes) {
  const value = text(bytes);
  if (value && !value.endsWith("\0")) unavailable();
  return value ? value.slice(0, -1).split("\0") : [];
}
function validName(name) {
  if (!name || Buffer.byteLength(name) > 1024 || /[\x00-\x1f\x7f]/.test(name)) unavailable();
  const parts = name.split("/");
  if (parts.length > 64 || parts.some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) unavailable();
  return parts;
}
function hash(bytes) {
  return crypto.createHash(baseline.length === 64 ? "sha256" : "sha1")
    .update("blob " + bytes.length + "\0").update(bytes).digest("hex");
}
function sameStat(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode;
}
function capture(name) {
  const parts = validName(name);
  const held = [];
  let parent = rootFd;
  try {
    for (const part of parts.slice(0, -1)) {
      const fd = fs.openSync("/proc/self/fd/" + parent + "/" + part, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      held.push(fd); parent = fd;
    }
    const fd = fs.openSync("/proc/self/fd/" + parent + "/" + parts[parts.length - 1], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    held.push(fd);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) unavailable();
    const size = Number(before.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE || total + size > MAX_TOTAL) limited();
    total += size;
    const digest = crypto.createHash(baseline.length === 64 ? "sha256" : "sha1").update("blob " + size + "\0");
    const chunks = [], scratch = Buffer.alloc(Math.min(size + 1, 65536));
    let read = 0;
    while (true) {
      checkTime();
      const count = fs.readSync(fd, scratch, 0, Math.min(scratch.length, size + 1 - read), null);
      if (!count) break;
      read += count;
      if (read > size) unavailable();
      digest.update(scratch.subarray(0, count));
      if (size <= MAX_BODY) chunks.push(Buffer.from(scratch.subarray(0, count)));
    }
    if (read !== size || !sameStat(before, fs.fstatSync(fd, { bigint: true }))) unavailable();
    return { oid: digest.digest("hex"), mode: Number(before.mode) & 64 ? "100755" : "100644", size,
      bytes: size <= MAX_BODY ? Buffer.concat(chunks) : undefined };
  } catch (error) {
    if (error && error.code === "ENOENT") return undefined;
    throw error;
  } finally { for (const fd of held.reverse()) fs.closeSync(fd); }
}
function quote(value) {
  const bytes = Buffer.from(value);
  let out = '"';
  for (const byte of bytes) {
    if (byte === 34 || byte === 92) out += "\\" + String.fromCharCode(byte);
    else if (byte < 32 || byte >= 127) out += "\\" + byte.toString(8).padStart(3, "0");
    else out += String.fromCharCode(byte);
  }
  return out + '"';
}
function side(bytes, prefix) {
  if (!bytes.length) return { count: 0, patch: "" };
  const value = text(bytes), lines = value.split("\n"), ended = value.endsWith("\n");
  if (ended) lines.pop();
  return { count: lines.length, patch: lines.map(line => prefix + line + "\n").join("") + (ended ? "" : "\\ No newline at end of file\n") };
}
function binary(bytes) {
  if (bytes.includes(0)) return true;
  try { new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); return false; }
  catch { return true; }
}
function patch(name, before, after, oldBytes, newBytes) {
  const a = quote("a/" + name), b = quote("b/" + name);
  let out = "diff --git " + a + " " + b + "\n";
  if (!before) out += "new file mode " + after.mode + "\n";
  else if (!after) out += "deleted file mode " + before.mode + "\n";
  else if (before.mode !== after.mode) out += "old mode " + before.mode + "\nnew mode " + after.mode + "\n";
  const zero = "0".repeat(baseline.length);
  out += "index " + (before ? before.oid : zero) + ".." + (after ? after.oid : zero) + "\n";
  if (before && after && before.oid === after.oid) return out;
  if (binary(oldBytes) || binary(newBytes)) return out + "Binary files " + (before ? a : "/dev/null") + " and " + (after ? b : "/dev/null") + " differ\n";
  const left = side(oldBytes, "-"), right = side(newBytes, "+");
  if (!left.count && !right.count) return out;
  return out + "--- " + (before ? a : "/dev/null") + "\n+++ " + (after ? b : "/dev/null") + "\n@@ -" +
    (left.count ? "1," + left.count : "0,0") + " +" + (right.count ? "1," + right.count : "0,0") + " @@\n" + left.patch + right.patch;
}
try {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseline || "")) unavailable();
  root = process.cwd();
  rootFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); descriptors.push(rootFd);
  gitFd = fs.openSync("/proc/self/fd/" + rootFd + "/.git", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); descriptors.push(gitFd);
  const entries = new Map();
  for (const record of names(git(["ls-tree", "-r", "-z", baseline, "--"], MAX_MANIFEST))) {
    const tab = record.indexOf("\t"), meta = record.slice(0, tab).split(" "), name = record.slice(tab + 1);
    if (tab < 0 || meta.length !== 3 || !["100644", "100755"].includes(meta[0]) || meta[1] !== "blob" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(meta[2])) unavailable();
    validName(name); entries.set(name, { mode: meta[0], oid: meta[2] });
    if (entries.size > MAX_PATHS) limited();
  }
  const allNames = new Set([...entries.keys(), ...names(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--"], MAX_MANIFEST))]);
  if (allNames.size > MAX_PATHS) limited();
  let diff = "";
  for (const name of [...allNames].sort()) {
    checkTime(); validName(name);
    const before = entries.get(name), after = capture(name);
    if (!before && !after || before && after && before.oid === after.oid && before.mode === after.mode) continue;
    if (after && !after.bytes) limited();
    const oldBytes = before ? git(["cat-file", "blob", before.oid], MAX_BODY) : Buffer.alloc(0);
    if (before && hash(oldBytes) !== before.oid) unavailable();
    diff += patch(name, before, after, oldBytes, after ? after.bytes : Buffer.alloc(0));
    if (diff.length > MAX_PATCH) limited();
  }
  process.stdout.write(JSON.stringify({ status: "ready", diff }));
} catch (error) {
  process.stdout.write(JSON.stringify({ status: error && error.previewStatus === "limited" ? "limited" : "unavailable",
    reason: error && error.previewStatus ? error.previewReason : "A complete live diff could not be captured safely. The final captured diff remains authoritative." }));
} finally { for (const fd of descriptors.reverse()) { try { fs.closeSync(fd); } catch {} } }
`;

/** One complete preview or a public, bounded reason why it could not be read. */
export async function captureLiveDiff(
  ops: SandboxOps,
  workdir: string,
  baselineCommit: string,
  signals: RunSignal[],
  signal?: AbortSignal,
): Promise<LiveDiffPreview> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baselineCommit)) {
    return { status: "unavailable", reason: "The live diff has no immutable baseline." };
  }
  try {
    const result = await scopedExec(ops, shellJoin(["node", "-e", LIVE_DIFF_READER, baselineCommit]), {
      cwd: workdir, timeoutMs: 5_000, signal, allowlist: [["node", "-e", LIVE_DIFF_READER]], signals, maxOutputChars: 160_000,
      receiptLabel: "Read bounded live diff snapshot",
    });
    if (result.exitCode !== 0) throw new Error("Live snapshot reader failed.");
    const preview: unknown = JSON.parse(result.stdout);
    if (typeof preview !== "object" || preview === null) throw new Error("Invalid live snapshot.");
    const value = preview as Record<string, unknown>;
    if (value.status === "ready" && typeof value.diff === "string" && value.diff.length <= LIVE_DIFF_MAX_CHARS) return { status: "ready", diff: value.diff };
    if (value.status === "limited") return { status: "limited", reason: "The live diff exceeds its bounded preview limits. The final captured diff remains authoritative." };
    if (value.status === "unavailable") return { status: "unavailable", reason: "A complete live diff could not be captured safely. The final captured diff remains authoritative." };
  } catch {
    // Never expose raw process errors or partial captured bytes through status.
  }
  return { status: "unavailable", reason: "A complete live diff is temporarily unavailable. The final captured diff remains authoritative." };
}
