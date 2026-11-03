/** Dependency-free immutable publication capture for the local daemon. */
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { captureExpectedDeliverables, readContainedChangedFile } from "./local-deliverables.mjs";

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

function textContent(bytes, required) {
  try {
    const text = decoder().decode(bytes);
    if ([...text].some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || (code >= 127 && code <= 159);
    }) || (required && !text.trim())) throw new Error("Expected nonblank UTF-8 text.");
    return { content: text, encoding: "utf8" };
  } catch (error) {
    if (required) throw error;
    return { content: bytes.toString("base64"), encoding: "base64" };
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
  let totalBytes = 0;
  async function capture(name, objectId, required) {
    const sizeText = (await git(["cat-file", "-s", objectId], 1024)).toString("utf8");
    const size = Number(sizeText.trim());
    if (!/^\d+\s*$/.test(sizeText) || !Number.isSafeInteger(size) || size > (required ? 16_384 : MAX_FILE_BYTES) || (required && size === 0)) {
      throw new Error(`File ${name} exceeds its complete capture size limit.`);
    }
    const bytes = await git(["cat-file", "blob", objectId], size);
    const hash = createHash("sha1").update(`blob ${size}\0`).update(bytes).digest("hex");
    if (bytes.length !== size || hash !== objectId) throw new Error(`File ${name} has truncated or corrupt Git blob bytes.`);
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES || (required && totalBytes > 65_536)) throw new Error("Captured files exceed their complete byte limit.");
    files.push({ path: name, ...textContent(bytes, required) });
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
      await capture(change.path, change.objectId, false);
    }
  }
  const diff = decoder().decode(await git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", baseRevision, tree, "--"], 2_000_000));
  return { changedFiles: changes.map((change) => change.path), diff, files };
}
