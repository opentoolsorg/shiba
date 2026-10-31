/** Strict opt-in artifact capture for the dependency-free local daemon. */
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

const MAX_FILE_BYTES = 16_384;
const MAX_TOTAL_BYTES = 65_536;
const MAX_FILES = 8;

// Mirror packages/shared/src/deliverables.ts without requiring installed packages.
function safePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 240
    && value === value.trim() && /\.(?:md|txt|json|csv)$/i.test(value)
    && value.split("/").every((part) => part.length > 0 && part === part.trim()
      && /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(part));
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function containsBinaryControl(text) {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

async function checkedLeaf(root, realRoot, relativePath) {
  const parts = relativePath.split("/");
  let current = root;
  let stat;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("symlink files and parents are not allowed");
    if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error("expected a regular file beneath regular directories");
    }
    if (index === parts.length - 1 && stat.nlink !== 1) throw new Error("hard-linked files are not allowed");
  }
  const realLeaf = await fs.realpath(current);
  if (!inside(realRoot, realLeaf)) throw new Error("path escapes the repository");
  return { absolute: current, stat };
}

/**
 * Return complete requested UTF-8 bodies, or throw; never return a partial
 * successful artifact list. Unspecified deliverables leave legacy collection alone.
 */
export async function captureExpectedDeliverables(cloneDir, requested) {
  if (requested === undefined) return [];
  if (!Array.isArray(requested) || requested.length > MAX_FILES || requested.some((value) => !safePath(value))) {
    throw new Error("Expected deliverables must be at most 8 safe relative non-hidden md/txt/json/csv paths.");
  }
  if (new Set(requested.map((value) => value.toLowerCase())).size !== requested.length) {
    throw new Error("Expected deliverable paths must be unique.");
  }
  if (requested.length === 0) return [];
  const root = path.resolve(cloneDir);
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Deliverable repository root must be a regular directory.");
  const realRoot = await fs.realpath(root);
  const files = [];
  let totalBytes = 0;
  for (const relativePath of requested) {
    try {
      const leaf = await checkedLeaf(root, realRoot, relativePath);
      if (leaf.stat.size === 0 || leaf.stat.size > MAX_FILE_BYTES) throw new Error("file must contain 1–16384 bytes");
      const handle = await fs.open(leaf.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (before.nlink !== 1) throw new Error("hard-linked files are not allowed");
        if (!before.isFile() || before.ino !== leaf.stat.ino || before.dev !== leaf.stat.dev) throw new Error("file changed during capture");
        const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = await handle.read(bytes, length, bytes.length - length, length);
          if (read.bytesRead === 0) break;
          length += read.bytesRead;
        }
        if (length === 0 || length > MAX_FILE_BYTES) throw new Error("file must contain 1–16384 complete bytes");
        const after = await handle.stat();
        if (after.nlink !== 1) throw new Error("hard-linked files are not allowed");
        const current = await checkedLeaf(root, realRoot, relativePath);
        if (before.size !== length || after.size !== length || before.mtimeMs !== after.mtimeMs
          || current.stat.ino !== before.ino || current.stat.dev !== before.dev) throw new Error("file changed or was truncated during capture");
        totalBytes += length;
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error("deliverables exceed the 65536-byte total limit");
        // Preserve a UTF-8 BOM as content too; byte counts/hashes must describe
        // the complete file rather than a decoder-normalized approximation.
        const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
        if (!content.trim() || containsBinaryControl(content)) {
          throw new Error("file must contain nonblank UTF-8 text, not binary data");
        }
        files.push({ path: relativePath, content, encoding: "utf8" });
      } finally {
        await handle.close();
      }
    } catch (error) {
      throw new Error(`Expected deliverable ${relativePath} could not be captured: ${error.message}`);
    }
  }
  return files;
}

/** Read one changed worktree file with symlink/hard-link containment (local daemon). */
export async function readContainedChangedFile(cloneDir, relativePath, limits = {}) {
  const maxBytes = limits.maxBytes ?? 400_000;
  const root = path.resolve(cloneDir);
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Repository root must be a regular directory.");
  const realRoot = await fs.realpath(root);
  const leaf = await checkedLeaf(root, realRoot, relativePath);
  if (leaf.stat.size > maxBytes) throw new Error("file exceeds capture size limit");
  const handle = await fs.open(leaf.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (before.nlink !== 1 || !before.isFile()) throw new Error("hard-linked files are not allowed");
    const bytes = Buffer.alloc(Math.min(maxBytes, before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > maxBytes) throw new Error("file exceeds capture size limit");
    const after = await handle.stat();
    const current = await checkedLeaf(root, realRoot, relativePath);
    if (before.ino !== after.stat.ino || before.size !== after.stat.size || after.stat.nlink !== 1) {
      throw new Error("file changed during capture");
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, length));
  } finally {
    await handle.close();
  }
}
