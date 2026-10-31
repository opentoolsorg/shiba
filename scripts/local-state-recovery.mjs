#!/usr/bin/env node
/** Offline, local Wrangler persistence only. Never starts a Worker or calls a remote API. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

const exec = promisify(execFile);
const FORMAT = "shiba-wrangler-local-v1";
const HELP = "Usage: node scripts/local-state-recovery.mjs backup --offline <persist-root> <new-bundle>\n       node scripts/local-state-recovery.mjs verify <bundle>\n       node scripts/local-state-recovery.mjs restore --offline <bundle> <new-persist-root>\nStop every writer first. --offline acknowledges a cooperative maintenance window, not a filesystem lock. Restore never overwrites or launches anything.";

async function version() {
  return JSON.parse(await fs.readFile(new URL("../node_modules/wrangler/package.json", import.meta.url), "utf8")).version;
}

async function canonical(input, mustExist = true) {
  const absolute = path.resolve(input);
  if (mustExist) {
    if (!(await fs.lstat(absolute)).isDirectory()) throw new Error("Expected a real directory.");
    return fs.realpath(absolute);
  }
  try {
    await fs.lstat(absolute);
    throw new Error("Destination already exists; choose a new isolated directory.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return path.join(await fs.realpath(path.dirname(absolute)), path.basename(absolute));
}

function disjoint(a, b) {
  if (a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`)) {
    throw new Error("Source and destination must be separate, non-overlapping directories.");
  }
}

async function offline(root) {
  try {
    await exec(process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof", ["-F", "p", "+D", root], { timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
  } catch (error) {
    if (error.stdout?.trim()) throw new Error("Persistence files are open. Stop Wrangler and all other readers/writers first.");
    if (error.code === 1 && !error.stdout?.trim()) {
      const stderrLines = String(error.stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
      const benign = stderrLines.length === 0 || stderrLines.every((line) => line.startsWith("lsof: WARNING:"));
      if (benign) return;
    }
    throw new Error(`Cannot establish offline state: lsof inspection failed (${error.code ?? "unknown"}). Stop writers and check permissions.`);
  }
  throw new Error("Persistence files are open. Stop Wrangler and all other readers/writers first.");
}

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function quickCheck(file) {
  // Read-only SQLite may need a writable WAL index. Confine that to a private disposable copy.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "shiba-sqlite-check-"));
  await fs.chmod(scratch, 0o700);
  const database = path.join(scratch, "state.sqlite");
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        const stat = await fs.lstat(`${file}${suffix}`);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsupported SQLite sidecar.");
        await fs.copyFile(`${file}${suffix}`, `${database}${suffix}`);
        await fs.chmod(`${database}${suffix}`, 0o600);
      } catch (error) {
        if (suffix && error.code === "ENOENT") continue;
        throw error;
      }
    }
    const result = await exec("sqlite3", ["-readonly", database, "PRAGMA quick_check;"], { timeout: 30_000 });
    if (result.stdout.trim() !== "ok") throw new Error("integrity failed");
  } catch {
    throw new Error("SQLite read-only integrity check failed; bundle is not usable.");
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function inventory(root, privateFiles = false, checkDatabases = true) {
  const directories = [];
  const files = [];
  let bytes = 0;
  let sqliteDatabases = 0;
  async function walk(relative = "") {
    const directory = path.join(root, relative);
    if (privateFiles && ((await fs.stat(directory)).mode & 0o777) !== 0o700) throw new Error("Bundle directories must have mode 0700.");
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const item = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(root, item);
      if (entry.isDirectory()) {
        directories.push(item);
        await walk(item);
      } else if (entry.isFile()) {
        const before = await fs.lstat(absolute);
        if (before.nlink !== 1) throw new Error("Hard links are unsupported in persistence bundles.");
        if (privateFiles && (before.mode & 0o777) !== 0o600) throw new Error("Bundle files must have mode 0600.");
        const sha256 = await digest(absolute);
        const handle = await fs.open(absolute, "r");
        const header = Buffer.alloc(16);
        try { await handle.read(header, 0, 16, 0); } finally { await handle.close(); }
        if (entry.name.endsWith(".sqlite")) {
          if (header.toString() !== "SQLite format 3\0") throw new Error("SQLite database header is invalid.");
          if (checkDatabases) await quickCheck(absolute);
          sqliteDatabases += 1;
        }
        const after = await fs.lstat(absolute);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error("Persistence changed during inspection; stop every writer.");
        files.push({ path: item, size: after.size, sha256 });
        bytes += after.size;
      } else {
        throw new Error("Symlinks and special files are unsupported in persistence bundles.");
      }
    }
  }
  await walk();
  if (!directories.includes("v3") || !files.length || !sqliteDatabases) throw new Error("Expected a populated Wrangler v3 persistence root with SQLite state.");
  if (directories.some((name) => !name.startsWith("v3/") && name !== "v3") || files.some((file) => !file.path.startsWith("v3/"))) throw new Error("Only the explicit Wrangler v3 persistence tree is supported; configuration belongs elsewhere.");
  return { directories, files, counts: { files: files.length, bytes, sqliteDatabases } };
}

async function privateCopy(source, target) {
  await fs.cp(source, target, { recursive: true, force: false, errorOnExist: true });
  async function tighten(directory) {
    await fs.chmod(directory, 0o700);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await tighten(child);
      else if (entry.isFile()) await fs.chmod(child, 0o600);
      else throw new Error("Source changed to an unsupported file type during copying.");
    }
  }
  await tighten(target);
}

function equal(expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("Integrity manifest mismatch: files, hashes, or counts changed.");
}

export async function verifyBundle(input) {
  const root = await canonical(input);
  const manifestStat = await fs.lstat(path.join(root, "manifest.json"));
  if (((await fs.stat(root)).mode & 0o777) !== 0o700 || !manifestStat.isFile() || manifestStat.nlink !== 1 || (manifestStat.mode & 0o777) !== 0o600) throw new Error("Bundle must be private with an ordinary manifest (0700 directories, 0600 files).");
  if ((await fs.readdir(root)).sort().join(",") !== "manifest.json,state") throw new Error("Unexpected bundle contents.");
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8")); }
  catch { throw new Error("Manifest JSON is invalid or unreadable."); }
  if (manifest.format !== FORMAT || manifest.wranglerVersion !== await version()) throw new Error("Unsupported bundle format or Wrangler version. Use the exact recorded Wrangler version.");
  const state = path.join(root, "state");
  await canonical(state);
  await offline(state);
  const actual = await inventory(state, true);
  equal({ directories: manifest.directories, files: manifest.files, counts: manifest.counts }, actual);
  return { root, manifest, actual };
}

export async function backupState(input, output, acknowledgedOffline) {
  if (!acknowledgedOffline) throw new Error("--offline is required: stop all services using this persistence root.");
  const source = await canonical(input);
  const target = await canonical(output, false);
  disjoint(source, target);
  await offline(source);
  const before = await inventory(source, false, false);
  await fs.mkdir(target, { mode: 0o700 });
  try {
    await privateCopy(source, path.join(target, "state"));
    await offline(source);
    equal(before, await inventory(source, false, false));
    equal(before, await inventory(path.join(target, "state"), true));
    const manifest = { format: FORMAT, createdAt: new Date().toISOString(), wranglerVersion: await version(), ...before };
    await fs.writeFile(path.join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    return manifest.counts;
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreState(input, output, acknowledgedOffline) {
  if (!acknowledgedOffline) throw new Error("--offline is required: do not start services during verification or restore.");
  const target = await canonical(output, false);
  const { root, manifest, actual } = await verifyBundle(input);
  disjoint(root, target);
  // Corruption is rejected before the restore destination is created. Never replace live state.
  await fs.mkdir(target, { mode: 0o700 });
  try {
    for (const directory of actual.directories) await fs.mkdir(path.join(target, directory), { mode: 0o700 });
    for (const file of actual.files) {
      await fs.copyFile(path.join(root, "state", file.path), path.join(target, file.path), constants.COPYFILE_EXCL);
      await fs.chmod(path.join(target, file.path), 0o600);
    }
    // Matching every database/WAL/blob hash preserves the integrity check already run by verifyBundle.
    equal(actual, await inventory(target, true, false));
    equal(actual, await inventory(path.join(root, "state"), true, false));
    return manifest.counts;
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values, positionals } = parseArgs({ options: { offline: { type: "boolean" }, help: { type: "boolean" } }, allowPositionals: true });
    if (values.help) console.log(HELP);
    else {
      const [command, source, destination] = positionals;
      let counts;
      if (command === "verify" && source && positionals.length === 2) counts = (await verifyBundle(source)).manifest.counts;
      else if (command === "backup" && source && destination && positionals.length === 3) counts = await backupState(source, destination, values.offline);
      else if (command === "restore" && source && destination && positionals.length === 3) counts = await restoreState(source, destination, values.offline);
      else throw new Error(HELP);
      console.log(JSON.stringify({ operation: command, counts }));
    }
  } catch (error) {
    console.error(`local-state-recovery: ${error.message}`);
    process.exitCode = 1;
  }
}
