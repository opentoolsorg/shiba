const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, rm, readFile, symlink } = require("node:fs/promises");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { toolsForHost, loadToolchain, preparePackagingTools } = require("./prepare-packaging-tools.cjs");

test("pins match the installed packaging dependencies for both host architectures", async () => {
  assert.equal(typeof loadToolchain(), "function");
  const builder = createRequire(require.resolve("electron-builder/package.json"));
  const library = createRequire(builder.resolve("app-builder-lib/package.json"));
  const dmg = createRequire(builder.resolve("dmg-builder/package.json"));
  const source = await readFile(library.resolve("./out/toolsets/7zip.js"), "utf8") + await readFile(dmg.resolve("./out/dmgUtil.js"), "utf8");
  for (const arch of ["x64", "arm64"]) for (const tool of toolsForHost("darwin", arch)) assert.ok(source.includes(tool.sha256));
});

test("unsupported hosts fail before loading or downloading anything", async () => {
  let loaded = false;
  await assert.rejects(preparePackagingTools({ platform: "linux", arch: "x64", load: () => { loaded = true; }, report() {} }), /supported macOS/);
  assert.equal(loaded, false);
});

test("prefetch uses exact checksum-bound releases and verifies the extracted binaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiba-packaging-tools-"));
  const requests = [];
  try {
    await preparePackagingTools({ platform: "darwin", arch: "x64", report() {}, load: () => async (input) => {
      requests.push(input);
      const directory = path.join(root, input.releaseName);
      const tool = toolsForHost("darwin", "x64").find((entry) => entry.filenameWithExt === input.filenameWithExt);
      await mkdir(path.dirname(path.join(directory, tool.binary)), { recursive: true });
      await writeFile(path.join(directory, tool.binary), "fixture binary");
      return directory;
    } });
    assert.equal(requests.length, 2);
    for (const input of requests) {
      assert.match(input.overrideUrl, /^https:\/\/github\.com\/electron-userland\/electron-builder-binaries\/releases\/download\//);
      assert.match(input.checksums[input.filenameWithExt], /^[a-f0-9]{64}$/);
      assert.equal(input.unsafelyDisableChecksums, undefined);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("upstream errors identify the fixed artifact without leaking redirect credentials", async () => {
  const error = Object.assign(new Error("secret response body"), { response: { statusCode: 504, url: "https://user:password@example.test/file?token=secret" } });
  await assert.rejects(preparePackagingTools({ platform: "darwin", arch: "x64", report() {}, load: () => async () => { throw error; } }), (failure) => {
    assert.match(failure.message, /7zip-darwin-x86_64\.tar\.gz: HTTP 504/);
    assert.doesNotMatch(failure.message, /password|token=|secret|example\.test/);
    return true;
  });
});

test("accepts the official relative 7za symlink while rejecting escapes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiba-packaging-links-"));
  try {
    const tools = toolsForHost("darwin", "x64");
    for (const tool of tools) {
      await mkdir(path.dirname(path.join(root, tool.releaseName, tool.binary)), { recursive: true });
      if (tool.binary === "bin/7za") {
        await writeFile(path.join(root, tool.releaseName, "bin/7zz"), "verified fixture");
        await symlink("7zz", path.join(root, tool.releaseName, tool.binary));
      } else await writeFile(path.join(root, tool.releaseName, tool.binary), "verified fixture");
    }
    const options = { platform: "darwin", arch: "x64", report() {}, load: () => async (tool) => path.join(root, tool.releaseName) };
    await preparePackagingTools(options);
    const entry = path.join(root, tools[0].releaseName, tools[0].binary);
    await rm(entry);
    await writeFile(path.join(root, "outside"), "unrelated");
    await symlink(path.join(root, "outside"), entry);
    await assert.rejects(preparePackagingTools(options), /Packaging preflight failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a missing extracted executable fails the preflight", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiba-packaging-empty-"));
  try {
    await assert.rejects(preparePackagingTools({ platform: "darwin", arch: "x64", report() {}, load: () => async () => root }), /Packaging preflight failed.*ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
