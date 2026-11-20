/** Strict opt-in artifact capture for the dependency-free local daemon. */
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

const MAX_FILE_BYTES = 16_384;
const MAX_TOTAL_BYTES = 65_536;
const MAX_HTML_BYTES = 524_288;
const MAX_PDF_BYTES = 10_485_760;
const MAX_LARGE_BYTES = MAX_HTML_BYTES + MAX_PDF_BYTES;
const MAX_OFFICE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_MP4_BYTES = 12 * 1024 * 1024;
const MAX_OFFICE_MEDIA_TOTAL = 16 * 1024 * 1024;
const MAX_FILES = 8;

// Mirror packages/shared/src/deliverables.ts without requiring installed packages.
const magic = (signature, offset = 0) => (bytes) => bytes.subarray(offset, offset + signature.length).equals(signature);
const ascii = (text, offset = 0) => magic(Buffer.from(text), offset);
const zip = ascii("PK\x03\x04");
const jpeg = magic(Buffer.from([0xff, 0xd8, 0xff]));
const pdf = ascii("%PDF-");
const png = magic(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
const riff = ascii("RIFF"), webp = ascii("WEBP", 8);
const gif87 = ascii("GIF87a"), gif89 = ascii("GIF89a");
const ftyp = ascii("ftyp", 4);
const officeMediaSignatures = {
  xlsx: zip, docx: zip, pptx: zip, png, jpg: jpeg, jpeg,
  webp: (bytes) => riff(bytes) && webp(bytes),
  gif: (bytes) => gif87(bytes) || gif89(bytes),
  mp4: (bytes) => {
    if (bytes.length < 16 || !ftyp(bytes)) return false;
    const size = bytes.readUInt32BE();
    return size >= 16 && size <= bytes.length && size % 4 === 0;
  },
};
const allowedExtensions = new Set(["md", "txt", "json", "csv", "html", "pdf", ...Object.keys(officeMediaSignatures)]);

function safePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 240
    && value === value.trim() && allowedExtensions.has(path.extname(value).slice(1).toLowerCase())
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

export function validateExpectedDeliverables(requested) {
  if (!Array.isArray(requested) || requested.length > MAX_FILES || requested.some((value) => !safePath(value))) {
    throw new Error("Expected deliverables must be at most 8 safe relative non-hidden paths with supported file extensions.");
  }
  if (new Set(requested.map((value) => value.toLowerCase())).size !== requested.length) {
    throw new Error("Expected deliverable paths must be unique.");
  }
}

/**
 * Return complete requested UTF-8 or base64 bodies, or throw; never return a partial
 * successful artifact list. Unspecified deliverables leave legacy collection alone.
 */
export async function captureExpectedDeliverables(cloneDir, requested) {
  if (requested === undefined) return [];
  validateExpectedDeliverables(requested);
  if (requested.length === 0) return [];
  const root = path.resolve(cloneDir);
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Deliverable repository root must be a regular directory.");
  const realRoot = await fs.realpath(root);
  const files = [];
  let totalBytes = 0;
  let largeBytes = 0;
  let officeMediaBytes = 0;
  for (const relativePath of requested) {
    try {
      const extension = path.extname(relativePath).slice(1).toLowerCase();
      const officeMedia = officeMediaSignatures[extension];
      const maxBytes = extension === "mp4" ? MAX_MP4_BYTES : officeMedia ? MAX_OFFICE_IMAGE_BYTES
        : extension === "pdf" ? MAX_PDF_BYTES : extension === "html" ? MAX_HTML_BYTES : MAX_FILE_BYTES;
      const leaf = await checkedLeaf(root, realRoot, relativePath);
      if (leaf.stat.size === 0 || leaf.stat.size > maxBytes) throw new Error(`file must contain 1–${maxBytes} bytes`);
      const handle = await fs.open(leaf.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (before.nlink !== 1) throw new Error("hard-linked files are not allowed");
        if (!before.isFile() || before.ino !== leaf.stat.ino || before.dev !== leaf.stat.dev) throw new Error("file changed during capture");
        const bytes = Buffer.alloc(Math.min(maxBytes, leaf.stat.size) + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = await handle.read(bytes, length, bytes.length - length, length);
          if (read.bytesRead === 0) break;
          length += read.bytesRead;
        }
        if (length === 0 || length > maxBytes) throw new Error(`file must contain 1–${maxBytes} complete bytes`);
        const after = await handle.stat();
        if (after.nlink !== 1) throw new Error("hard-linked files are not allowed");
        const current = await checkedLeaf(root, realRoot, relativePath);
        if (before.size !== length || after.size !== length || before.mtimeMs !== after.mtimeMs
          || current.stat.ino !== before.ino || current.stat.dev !== before.dev) throw new Error("file changed or was truncated during capture");
        if (extension === "html" || extension === "pdf") {
          largeBytes += length;
          if (largeBytes > MAX_LARGE_BYTES) throw new Error(`HTML and PDF deliverables exceed the ${MAX_LARGE_BYTES}-byte total limit`);
        } else if (officeMedia) {
          officeMediaBytes += length;
          if (officeMediaBytes > MAX_OFFICE_MEDIA_TOTAL) throw new Error(`Office and media deliverables exceed the ${MAX_OFFICE_MEDIA_TOTAL}-byte total limit`);
        } else {
          totalBytes += length;
          if (totalBytes > MAX_TOTAL_BYTES) throw new Error("deliverables exceed the 65536-byte total limit");
        }
        const complete = bytes.subarray(0, length);
        const signature = extension === "pdf" ? pdf : officeMedia;
        if (signature) {
          if (!signature(complete)) throw new Error(`file is not a valid ${extension.toUpperCase()} file`);
          files.push({ path: relativePath, content: complete.toString("base64"), encoding: "base64" });
          continue;
        }
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
    if (before.ino !== leaf.stat.ino || before.dev !== leaf.stat.dev
      || before.ino !== after.ino || before.dev !== after.dev
      || before.size !== length || after.size !== length || before.mtimeMs !== after.mtimeMs
      || after.nlink !== 1 || current.stat.ino !== before.ino || current.stat.dev !== before.dev) {
      throw new Error("file changed during capture");
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, length));
  } finally {
    await handle.close();
  }
}
