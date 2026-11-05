import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, link, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const computerDirectory = dirname(fileURLToPath(import.meta.url));
const maximumPackageBytes = 2 * 1024 * 1024;
const maximumTotalBytes = 16 * 1024 * 1024;
const manifestFormat = "shiba.computer.pinned-debs.v1";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => { throw new Error(`Pinned computer packages: ${message}`); };

// This build helper has no URL, package, destination, or manifest CLI options.
// The reviewed repository manifest supplies a small fixed set of public files.
export function validatePinnedManifest(value) {
  if (!value || value.format !== manifestFormat || value.snapshot !== "20261105T000000Z"
    || value.archive !== "debian" || value.suite !== "bookworm" || value.architecture !== "amd64"
    || value.provenance?.inReleaseSha256 !== "77737fa4b34f2693e982cc9ee35736816c35a7778fc2d326cc1bbf5b301fe1aa"
    || value.provenance?.packagesSha256 !== "9e0b5aabb2465b3d2e7a7fe27f9913846277833f7a2826e7767acccff5b588c5"
    || value.provenance?.packagesSize !== 8790396
    || value.provenance?.packagesPath !== "main/binary-amd64/Packages.xz"
    || !Array.isArray(value.packages) || !value.packages.length || value.packages.length > 16) fail("invalid fixed snapshot manifest");
  const names = new Set(), files = new Set(), urls = new Set();
  let total = 0;
  for (const record of value.packages) {
    if (!record || !/^[a-z0-9][a-z0-9+.-]*$/.test(record.name ?? "")
      || !/^[0-9][A-Za-z0-9.+~:-]*$/.test(record.version ?? "")
      || record.architecture !== "amd64"
      || record.filename !== `${record.name}_${record.version}_amd64.deb`
      || !/^[A-Za-z0-9][A-Za-z0-9.+~_-]*\.deb$/.test(record.filename)
      || basename(record.filename) !== record.filename
      || !/^https:\/\/snapshot\.debian\.org\/file\/[a-f0-9]{40}$/.test(record.url ?? "")
      || !/^[a-f0-9]{64}$/.test(record.sha256 ?? "")
      || !Number.isSafeInteger(record.size) || record.size <= 0 || record.size > maximumPackageBytes
      || names.has(record.name) || files.has(record.filename) || urls.has(record.url)) fail("invalid or duplicate package record");
    names.add(record.name); files.add(record.filename); urls.add(record.url); total += record.size;
  }
  if (total > maximumTotalBytes) fail("package byte budget exceeded");
  return Object.freeze(value.packages.map((record) => Object.freeze({ ...record })));
}

async function assertCacheDirectory(directory) {
  try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== join(await realpath(computerDirectory), "pinned-debs")) fail("unsafe cache directory");
}

async function verifyCachedFile(destination, record) {
  let handle;
  try { handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== record.size) fail("cached package size or type mismatch");
    const bytes = Buffer.alloc(record.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await handle.stat();
    if (count !== record.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || digest(bytes.subarray(0, count)) !== record.sha256) fail("cached package hash mismatch");
    return true;
  } finally { await handle.close(); }
}

async function verifiedBytes(record, fetcher, signal) {
  signal.throwIfAborted();
  const response = await fetcher(record.url, { redirect: "error", signal, headers: { Accept: "application/octet-stream" } });
  if (signal.aborted) void response.body?.cancel().catch(() => {});
  signal.throwIfAborted();
  if (response.status !== 200 || response.redirected || response.url !== record.url || !response.body) {
    void response.body?.cancel().catch(() => {});
    fail("unexpected package response or redirect");
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) !== record.size)) {
    void response.body.cancel().catch(() => {});
    fail("package content length mismatch");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let count = 0;
  let removeAbort = () => {};
  const aborted = new Promise((_, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else {
      signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", abort);
    }
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (done) break;
      if (!(value instanceof Uint8Array) || count + value.byteLength > record.size) fail("package stream exceeds pinned size");
      chunks.push(value); count += value.byteLength;
    }
    const bytes = Buffer.concat(chunks, count);
    if (count !== record.size || digest(bytes) !== record.sha256) fail("package size or SHA256 mismatch");
    return bytes;
  } finally {
    removeAbort();
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function publishPackage(directory, record, bytes, signal) {
  await assertCacheDirectory(directory);
  signal.throwIfAborted();
  const destination = join(directory, record.filename);
  const temporary = join(directory, `.precache-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.chmod(0o444); await handle.close(); handle = undefined;
    signal.throwIfAborted();
    // A hard link publishes the completed inode atomically without replacing an
    // existing file or following a concurrently created destination symlink.
    try { await link(temporary, destination); }
    catch (error) { if (error.code !== "EEXIST" || !await verifyCachedFile(destination, record)) throw error; }
    if (!await verifyCachedFile(destination, record)) fail("package publication failed");
    signal.throwIfAborted();
  } finally {
    if (handle) await handle.close();
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function precachePinnedDebs({ fetcher = globalThis.fetch, signal } = {}) {
  const records = validatePinnedManifest(JSON.parse(await readFile(join(computerDirectory, "pinned-debs-manifest.json"), "utf8")));
  const directory = join(computerDirectory, "pinned-debs");
  await assertCacheDirectory(directory);
  const controller = new AbortController();
  let next = 0;
  const worker = async () => {
    while (next < records.length) {
      const record = records[next++];
      const boundedSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
      boundedSignal.throwIfAborted();
      if (await verifyCachedFile(join(directory, record.filename), record)) continue;
      const bytes = await verifiedBytes(record, fetcher, boundedSignal);
      boundedSignal.throwIfAborted();
      await publishPackage(directory, record, bytes, boundedSignal);
    }
  };
  const results = await Promise.allSettled(Array.from({ length: Math.min(2, records.length) }, async () => {
    try { await worker(); } catch (error) { controller.abort(error); throw error; }
  }));
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return { packages: records.length, bytes: records.reduce((sum, record) => sum + record.size, 0) };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    if (process.argv.length !== 2) fail("CLI arguments are unsupported");
    const result = await precachePinnedDebs();
    console.log(`Verified ${result.packages} pinned computer packages (${result.bytes} bytes).`);
  } catch {
    console.error("Pinned computer package prefetch failed; no image build should proceed. Check the fixed manifest, public Snapshot availability, and local cache integrity.");
    process.exitCode = 1;
  }
}
