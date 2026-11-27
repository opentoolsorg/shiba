/** Dependency-free immutable publication capture for the local daemon. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { captureExpectedDeliverables, createExpectedDeliverableValidator, readContainedChangedFile } from "./local-deliverables.mjs";

const MAX_FILES = 50;
const MAX_FILE_BYTES = 100_000;
const MAX_TOTAL_BYTES = 500_000;
const decoder = () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function safePath(value) {
  return Boolean(value) && value.length <= 1024 && !/[\\:]/.test(value)
    && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    && value.split("/").every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

function nulRecords(bytes) {
  const text = decoder().decode(bytes);
  if (text !== "" && !text.endsWith("\0")) throw new Error("Git manifest is truncated.");
  return text === "" ? [] : text.slice(0, -1).split("\0");
}

function textContent(bytes) {
  try {
    const text = decoder().decode(bytes);
    if ([...text].some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || (code >= 127 && code <= 159);
    })) throw new Error("Expected UTF-8 text.");
    return { content: text, encoding: "utf8" };
  } catch {
    return { content: bytes.toString("base64"), encoding: "base64" };
  }
}


function lfsPointer(bytes) {
  if (bytes.length > 1024) return null;
  let text;
  try { text = decoder().decode(bytes); } catch { return null; }
  const match = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize ([0-9]+)\n?$/.exec(text);
  if (!match) return null;
  const size = Number(match[2]);
  return Number.isSafeInteger(size) ? { oid: match[1], size } : null;
}

async function readLfsObject(git, cloneDir, pointer, maxBytes) {
  if (pointer.size > maxBytes) throw new Error("Git LFS object exceeds its complete capture size limit.");
  const commonText = (await git(["rev-parse", "--git-common-dir"], 1024)).toString("utf8").trim();
  if (!commonText || commonText.includes("\n") || commonText.includes("\0")) throw new Error("Git did not return one common object directory.");
  const gitDir = path.resolve(cloneDir, commonText);
  const objectPath = path.join(gitDir, "lfs", "objects", pointer.oid.slice(0, 2), pointer.oid.slice(2, 4), pointer.oid);
  const realGitDir = await fs.realpath(gitDir);
  const realObjectPath = await fs.realpath(objectPath);
  const relative = path.relative(realGitDir, realObjectPath);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Git LFS object escapes the repository object store.");
  }
  const handle = await fs.open(realObjectPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== pointer.size) throw new Error("Git LFS object is missing or has the wrong size.");
    const bytes = Buffer.alloc(pointer.size);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length !== pointer.size) throw new Error("Git LFS object is truncated.");
    if (createHash("sha256").update(bytes).digest("hex") !== pointer.oid) throw new Error("Git LFS object digest does not match its pointer.");
    return bytes;
  } finally {
    await handle.close();
  }
}

/** `git` returns bounded raw stdout bytes and must reject failed commands. */
export async function collectLocalRepositorySnapshot({ cloneDir, baseRevision, expectedDeliverables, git: invokeGit }) {
  // Fixed object IDs are immutable only when repository-controlled replacement
  // refs cannot redirect their trees or blobs to other valid objects.
  const git = (args, maxBytes) => invokeGit(["--no-replace-objects", ...args], maxBytes);
  if (!/^[a-f0-9]{40}$/.test(baseRevision)) throw new Error("Repository capture requires an immutable base revision.");
  // Keep the native link/containment checks before staging. Returned file bodies
  // below come exclusively from the frozen Git tree, never this worktree read.
  await captureExpectedDeliverables(cloneDir, expectedDeliverables);
  await git(["status", "--porcelain", "-z", "-uall"], 1_000_000);
  const pending = [...new Set([
    ...nulRecords(await git(["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", baseRevision, "--"], 1_000_000)),
    ...nulRecords(await git(["ls-files", "--others", "--exclude-standard", "-z"], 1_000_000)),
  ])];
  if (pending.length > 500 || pending.some((name) => !safePath(name))) throw new Error("Repository change list contains unsupported paths or exceeds 500 files.");
  const requested = expectedDeliverables ?? [];
  const requestedSet = new Set(requested);
  if (new Set([...requested, ...pending]).size > MAX_FILES) throw new Error("Repository capture exceeds the 50-file limit; refusing to publish a partial tree.");
  const validated = new Set(requested);
  for (const name of pending.filter((name) => !requestedSet.has(name))) {
    try {
      await readContainedChangedFile(cloneDir, name, { maxBytes: MAX_FILE_BYTES });
      validated.add(name);
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`Changed file ${name} could not be captured: ${error.message}`);
    }
  }
  await git(["add", "-A"], 1024);
  const tree = (await git(["write-tree"], 1024)).toString("utf8").trim();
  if (!/^[a-f0-9]{40}$/.test(tree)) throw new Error("Git did not return an immutable checkpoint tree.");
  const records = nulRecords(await git(["diff", "--raw", "--no-abbrev", "--no-renames", "-z", baseRevision, tree, "--"], 1_000_000));
  if (records.length % 2 || records.length > 1000) throw new Error("Repository checkpoint manifest is incomplete or exceeds 500 files.");
  const changes = [];
  const seen = new Set();
  for (let index = 0; index < records.length; index += 2) {
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMD])$/.exec(records[index]);
    const name = records[index + 1];
    if (!match || !safePath(name) || seen.has(name)) throw new Error("Repository checkpoint contains an unsupported path or change type.");
    const deleted = match[5] === "D";
    if (deleted ? match[2] !== "000000" || !/^0+$/.test(match[4]) : !["100644", "100755"].includes(match[2]) || /^0+$/.test(match[4])) {
      throw new Error("Repository checkpoint contains a symlink or unsupported file type.");
    }
    seen.add(name);
    changes.push({ path: name, objectId: deleted ? null : match[4] });
  }
  if (new Set([...requested, ...changes.map((change) => change.path)]).size > MAX_FILES) throw new Error("Repository checkpoint exceeds the 50-file limit; refusing to publish a partial tree.");
  const files = [];
  const validateFrozenExpected = createExpectedDeliverableValidator();
  const MAX_FROZEN_EXPECTED_BYTES = 12 * 1024 * 1024;
  let totalBytes = 0;
  async function capture(name, objectId, required = false) {
    const sizeText = (await git(["cat-file", "-s", objectId], 1024)).toString("utf8");
    const size = Number(sizeText.trim());
    const maxBytes = required ? MAX_FROZEN_EXPECTED_BYTES : MAX_FILE_BYTES;
    if (!/^\d+\s*$/.test(sizeText) || !Number.isSafeInteger(size) || size > maxBytes) {
      throw new Error(`File ${name} exceeds its complete capture size limit.`);
    }
    const bytes = await git(["cat-file", "blob", objectId], size);
    const hash = createHash("sha1").update(`blob ${size}\0`).update(bytes).digest("hex");
    if (bytes.length !== size || hash !== objectId) throw new Error(`File ${name} has truncated or corrupt Git blob bytes.`);
    if (!required) {
      totalBytes += size;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Captured files exceed their complete byte limit.");
    }
    const materialized = required && lfsPointer(bytes) ? await readLfsObject(git, cloneDir, lfsPointer(bytes), maxBytes) : bytes;
    files.push(required ? validateFrozenExpected.validate(name, materialized) : { path: name, ...textContent(bytes) });
  }
  for (const name of requested) {
    try {
      const entry = nulRecords(await git(["ls-tree", "-z", tree, "--", name], 4096));
      const match = entry.length === 1 && /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry[0]);
      if (!match || match[3] !== name) throw new Error("Expected a regular checkpoint file.");
      await capture(name, match[2], true);
    } catch (error) {
      throw new Error(`Expected deliverable ${name} could not be captured: ${error.message}`);
    }
  }
  for (const change of changes.filter((change) => !requestedSet.has(change.path))) {
    if (change.objectId === null) files.push({ path: change.path, content: null, encoding: "utf8" });
    else {
      if (!validated.has(change.path)) throw new Error("Repository paths changed while freezing the checkpoint.");
      await capture(change.path, change.objectId);
    }
  }
  const diff = decoder().decode(await git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", baseRevision, tree, "--"], 2_000_000));
  return { changedFiles: changes.map((change) => change.path), diff, files };
}
