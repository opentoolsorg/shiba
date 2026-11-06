import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { validatePinnedManifest } from "./precache-debs.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytes = Buffer.from([0, 255, 1, 10, 13, 128, 200, 16]);
const base = {
  format: "shiba.computer.pinned-debs.v1", snapshot: "20261105T000000Z", archive: "debian", suite: "bookworm", architecture: "amd64",
  provenance: { inReleaseSha256: "77737fa4b34f2693e982cc9ee35736816c35a7778fc2d326cc1bbf5b301fe1aa", packagesSha256: "9e0b5aabb2465b3d2e7a7fe27f9913846277833f7a2826e7767acccff5b588c5", packagesSize: 8790396, packagesPath: "main/binary-amd64/Packages.xz" },
  packages: [{ name: "libfixture", version: "1.0-1", architecture: "amd64", filename: "libfixture_1.0-1_amd64.deb", url: `https://snapshot.debian.org/file/${"1".repeat(40)}`, size: bytes.length, sha256: sha256(bytes) }],
};
const clone = () => structuredClone(base);
function response(body, url, options = {}) {
  const result = new Response(body, { status: options.status ?? 200, headers: options.headers ?? { "content-length": String(bytes.length) } });
  Object.defineProperty(result, "url", { value: url });
  Object.defineProperty(result, "redirected", { value: options.redirected ?? false });
  return result;
}
async function fixture(t, manifest = clone()) {
  const root = await mkdtemp(join(tmpdir(), "shiba-computer-precache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "computer"); await mkdir(directory);
  await copyFile(new URL("./precache-debs.mjs", import.meta.url), join(directory, "precache-debs.mjs"));
  await writeFile(join(directory, "pinned-debs-manifest.json"), JSON.stringify(manifest));
  const helper = await import(`${pathToFileURL(join(directory, "precache-debs.mjs")).href}?fixture=${randomUUID()}`);
  return { ...helper, root, directory, cache: join(directory, "pinned-debs"), manifest };
}

test("production manifest keeps all seven reviewed packages in the exact signed snapshot", async () => {
  const value = JSON.parse(await readFile(new URL("./pinned-debs-manifest.json", import.meta.url), "utf8"));
  const records = validatePinnedManifest(value);
  assert.deepEqual(records.map((record) => record.name).sort(), ["libasyncns0", "libdrm-radeon1", "libopenjp2-7", "libpaper1", "libpciaccess0", "libwayland-egl1", "libxcb-util1"].sort());
  assert.equal(records.reduce((total, record) => total + record.size, 0), 319888);
  assert(Object.isFrozen(records)); assert(records.every(Object.isFrozen));
});

for (const [label, alter] of [
  ["foreign URL", (m) => { m.packages[0].url = `https://example.com/file/${"1".repeat(40)}`; }],
  ["HTTP downgrade", (m) => { m.packages[0].url = m.packages[0].url.replace("https:", "http:"); }],
  ["URL user info", (m) => { m.packages[0].url = m.packages[0].url.replace("https://", "https://secret@"); }],
  ["URL query", (m) => { m.packages[0].url += "?destination=other"; }],
  ["mutable snapshot path", (m) => { m.packages[0].url = "https://snapshot.debian.org/archive/debian/20261105T000000Z/pool/package.deb"; }],
  ["traversal output path", (m) => { m.packages[0].filename = "../../escape.deb"; }],
  ["absolute output path", (m) => { m.packages[0].filename = "/tmp/escape.deb"; }],
  ["changed architecture", (m) => { m.packages[0].architecture = "arm64"; }],
  ["unbounded package size", (m) => { m.packages[0].size = 2 * 1024 * 1024 + 1; }],
  ["changed signed index", (m) => { m.provenance.packagesSha256 = "f".repeat(64); }],
  ["duplicate record", (m) => { m.packages.push({ ...m.packages[0] }); }],
  ["more than sixteen records", (m) => { m.packages = Array.from({ length: 17 }, () => ({ ...m.packages[0] })); }],
  ["empty record list", (m) => { m.packages = []; }],
  ["aggregate byte budget", (m) => { m.packages = Array.from({ length: 9 }, (_, i) => ({ ...m.packages[0], name: `libfixture${i}`, filename: `libfixture${i}_1.0-1_amd64.deb`, url: `https://snapshot.debian.org/file/${String(i + 1).repeat(40)}`, size: 2 * 1024 * 1024 })); }],
]) test(`rejects ${label} before any network or output`, () => {
  const manifest = clone(); alter(manifest); assert.throws(() => validatePinnedManifest(manifest));
});

test("publishes exact binary bytes only after completion and reuses a verified cache without another GET", async (t) => {
  const f = await fixture(t); let controller, seen;
  const started = new Promise((resolve) => { seen = resolve; });
  let calls = 0;
  const pending = f.precachePinnedDebs({ fetcher: async (url, options) => {
    calls++; assert.equal(options.redirect, "error"); assert(options.signal instanceof AbortSignal);
    return response(new ReadableStream({ start(value) { controller = value; value.enqueue(bytes.subarray(0, 2)); seen(); } }), url);
  } });
  await started;
  assert.deepEqual(await readdir(f.cache), []);
  controller.enqueue(bytes.subarray(2)); controller.close();
  assert.deepEqual(await pending, { packages: 1, bytes: bytes.length });
  const destination = join(f.cache, f.manifest.packages[0].filename);
  assert.deepEqual(await readFile(destination), bytes); assert.equal((await stat(destination)).mode & 0o777, 0o444);
  assert.deepEqual(await readdir(f.cache), [f.manifest.packages[0].filename]);
  await f.precachePinnedDebs({ fetcher: () => { throw new Error("cache hit must not fetch"); } });
  assert.equal(calls, 1);
});

test("CLI rejects arbitrary URL, package and output arguments before reading a manifest or fetching", () => {
  const result = spawnSync(process.execPath, [new URL("./precache-debs.mjs", import.meta.url).pathname, "--url", "https://example.com/private", "--output", "/tmp/escape"], { encoding: "utf8", timeout: 3000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /prefetch failed/); assert(!result.stderr.includes("example.com"));
});

for (const [label, make] of [
  ["tampered bytes", (url) => response(Buffer.alloc(bytes.length, 1), url)],
  ["short stream", (url) => response(bytes.subarray(1), url)],
  ["oversized stream without Content-Length", (url) => response(Buffer.concat([bytes, bytes]), url, { headers: {} })],
  ["incorrect Content-Length", (url) => response(bytes, url, { headers: { "content-length": "9000000" } })],
  ["redirect status", (url) => response(null, url, { status: 302, headers: { location: "https://example.com/" } })],
  ["followed foreign redirect", () => response(bytes, "https://example.com/file", { redirected: true })],
  ["unmarked changed response URL", () => response(bytes, "https://snapshot.debian.org/file/other")],
  ["transient HTTP failure", (url) => response(null, url, { status: 503 })],
  ["interrupted body", (url) => response(new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0, 2)); c.error(new Error("fixture interrupted stream")); } }), url)],
]) test(`rejects ${label} with no published or partial package`, async (t) => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(f.precachePinnedDebs({ fetcher: async (url) => { calls++; return make(url); } }));
  assert.equal(calls, label === "transient HTTP failure" ? 3 : 1); assert.deepEqual(await readdir(f.cache), []);
});

test("retries transient public responses within the original bound and still verifies the pinned hash", async (t) => {
  const f = await fixture(t); let calls = 0;
  await f.precachePinnedDebs({ fetcher: async (url) => ++calls < 3 ? response(null, url, { status: 503 }) : response(bytes, url) });
  assert.equal(calls, 3);
  assert.deepEqual(await readFile(join(f.cache, base.packages[0].filename)), bytes);
});

test("cancellation during public backoff prevents another fetch", async (t) => {
  const f = await fixture(t), controller = new AbortController(); let calls = 0;
  await assert.rejects(f.precachePinnedDebs({ signal: controller.signal, fetcher: async (url) => { calls++; controller.abort(); return response(null, url, { status: 503 }); } }));
  assert.equal(calls, 1); assert.deepEqual(await readdir(f.cache), []);
});

test("rejects an already aborted operation before fetching", async (t) => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.precachePinnedDebs({ signal: controller.signal, fetcher: () => assert.fail("must not fetch") }));
  assert.deepEqual(await readdir(f.cache), []);
});

test("cancels a pending body without publishing or hanging", async (t) => {
  const f = await fixture(t), controller = new AbortController(); let started, cancelled = false;
  const seen = new Promise((resolve) => { started = resolve; });
  const pending = f.precachePinnedDebs({ signal: controller.signal, fetcher: async (url) => response(new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0, 1)); started(); }, cancel() { cancelled = true; } }), url) });
  await seen; controller.abort(new Error("fixture cancelled"));
  await assert.rejects(pending, /fixture cancelled/);
  assert(cancelled); assert.deepEqual(await readdir(f.cache), []);
});

test("refuses a cache directory symlink without writing its target", async (t) => {
  const f = await fixture(t), outside = join(f.root, "outside"); await mkdir(outside); await symlink(outside, f.cache);
  await assert.rejects(f.precachePinnedDebs({ fetcher: () => assert.fail("must not fetch") }), /unsafe cache directory/);
  assert.deepEqual(await readdir(outside), []);
});

test("refuses destination symlinks and existing corrupted packages", async (t) => {
  const f = await fixture(t), outside = join(f.root, "outside.deb"); await mkdir(f.cache); await writeFile(outside, bytes);
  const destination = join(f.cache, f.manifest.packages[0].filename); await symlink(outside, destination);
  await assert.rejects(f.precachePinnedDebs({ fetcher: () => assert.fail("must not fetch") }));
  assert.deepEqual(await readFile(outside), bytes); await rm(destination); await writeFile(destination, Buffer.alloc(bytes.length, 1));
  await assert.rejects(f.precachePinnedDebs({ fetcher: () => assert.fail("must not fetch") }), /cached package hash mismatch/);
  assert.deepEqual(await readFile(destination), Buffer.alloc(bytes.length, 1));
});

test("caps parallel downloads at two", async (t) => {
  const manifest = clone(); manifest.packages = Array.from({ length: 4 }, (_, i) => ({ ...manifest.packages[0], name: `libfixture${i}`, filename: `libfixture${i}_1.0-1_amd64.deb`, url: `https://snapshot.debian.org/file/${String(i + 1).repeat(40)}` }));
  const f = await fixture(t, manifest); let active = 0, maximum = 0;
  await f.precachePinnedDebs({ fetcher: async (url) => {
    active++; maximum = Math.max(maximum, active); await new Promise((resolve) => setImmediate(resolve)); active--;
    return response(bytes, url);
  } });
  assert(maximum <= 2); assert.equal((await readdir(f.cache)).length, 4);
});
