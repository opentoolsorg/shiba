const { createRequire } = require("node:module");
const { realpath, stat } = require("node:fs/promises");
const path = require("node:path");

const BUILDER_VERSION = "26.15.7";
const RELEASES = "https://github.com/electron-userland/electron-builder-binaries/releases/download/";

// Metadata from the installed, pinned app-builder-lib/toolsets/7zip and
// dmg-builder/dmgUtil. Use their normal checksum-verifying download/cache path.
function toolsForHost(platform, arch) {
  if (platform !== "darwin" || !["x64", "arm64"].includes(arch)) throw new Error("Packaging preflight requires a supported macOS host.");
  const suffix = arch === "arm64" ? "arm64" : "x86_64";
  return [
    { releaseName: "7zip@1.0.0", filenameWithExt: `7zip-darwin-${suffix}.tar.gz`, sha256: "496a341abe210aae1a25bc202ee97f6de6c76a3dc80f91d96616be05502d72c1", binary: "bin/7za" },
    { releaseName: "dmg-builder@1.2.5", filenameWithExt: `dmgbuild-bundle-${suffix}-75c8a6c.tar.gz`, sha256: arch === "arm64" ? "793404d0c96687e27d5ee40a668d498c92e36a64d6c2906df511031adb33cbeb" : "1664972f9cc2d6e8fce3b63e42cd30078aff602669c5856939c4519921200433", binary: "dmgbuild" },
  ];
}

function loadToolchain() {
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
  const libraryRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
  if (builderRequire("electron-builder/package.json").version !== BUILDER_VERSION || libraryRequire("./package.json").version !== BUILDER_VERSION) {
    throw new Error("Packaging preflight metadata requires electron-builder/app-builder-lib 26.15.7; review pins before upgrading.");
  }
  return libraryRequire("./out/util/electronGet.js").downloadBuilderToolset;
}

function failureMessage(error, tool) {
  const status = error?.response?.statusCode;
  const code = /^[A-Z][A-Z0-9_]{0,40}$/.test(error?.code ?? "") ? error.code : /^[A-Za-z][A-Za-z0-9]{0,60}$/.test(error?.name ?? "") ? error.name : "unclassified";
  // Never print response bodies, signed redirect queries, headers or raw errors.
  return `Packaging preflight failed for ${tool.filenameWithExt}: ${Number.isInteger(status) ? `HTTP ${status}` : code}; source ${RELEASES}${tool.releaseName}/${tool.filenameWithExt}`;
}

async function preparePackagingTools({ platform = process.platform, arch = process.arch, load = loadToolchain, report = console.log } = {}) {
  const tools = toolsForHost(platform, arch);
  const download = load();
  for (const tool of tools) {
    report(`Verifying packaging tool ${tool.filenameWithExt}`);
    try {
      const directory = await download({ releaseName: tool.releaseName, filenameWithExt: tool.filenameWithExt, checksums: { [tool.filenameWithExt]: tool.sha256 }, overrideUrl: `${RELEASES}${tool.releaseName}` });
      // The official 7za entry is a relative symlink to 7zz. Resolve it while
      // refusing links that escape this checksum-verified extracted toolset.
      const root = await realpath(directory), executable = await realpath(path.join(directory, tool.binary));
      const relative = path.relative(root, executable);
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("Extracted executable escapes toolset.");
      const binary = await stat(executable);
      if (!binary.isFile() || binary.size === 0) throw new Error("Invalid extracted executable.");
    } catch (error) {
      throw new Error(failureMessage(error, tool));
    }
  }
  report("Pinned packaging tools are ready in electron-builder's normal verified cache.");
}

module.exports = { toolsForHost, loadToolchain, preparePackagingTools };

if (require.main === module) {
  const timer = setTimeout(() => { console.error("Packaging preflight exceeded its five-minute budget."); process.exit(1); }, 300_000);
  preparePackagingTools().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => clearTimeout(timer));
}
