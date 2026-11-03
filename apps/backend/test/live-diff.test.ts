import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { tokenizeCommand } from "../src/exec-allowlist.js";
import { captureLiveDiff, LIVE_DIFF_MAX_CHARS, LIVE_DIFF_READER } from "../src/live-diff.js";
import type { SandboxOps } from "../src/runtime.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "shiba-live-diff-"));
  directories.push(root);
  return root;
}

function git(root: string, args: string[], input?: string): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
}

function put(root: string, name: string, value: string | Buffer) {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), value);
}

function repository(files: Record<string, string | Buffer> = {}, format: "sha1" | "sha256" = "sha1") {
  const root = directory();
  git(root, ["init", "-q", `--object-format=${format}`]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "user.email", "fixture@example.test"]);
  for (const [name, value] of Object.entries(files)) put(root, name, value);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--allow-empty", "-m", "Baseline"]);
  return { root, baseline: git(root, ["rev-parse", "HEAD"]).trim() };
}

function localOps(instrument = ""): SandboxOps {
  return {
    async gitCheckout() { throw new Error("No sandbox clone is allowed in these local tests."); },
    async writeFile() { throw new Error("Live reads cannot write workspace files."); },
    async readFile() { throw new Error("Live reads use the bounded inline capture."); },
    async exec(command, options) {
      const argv = tokenizeCommand(command);
      if (argv?.[0] !== "node" || argv[1] !== "-e" || argv[2] !== LIVE_DIFF_READER) throw new Error("Unexpected snapshot command.");
      const execution = argv.slice(1);
      if (instrument) execution[1] = `${instrument}\n${execution[1]}`;
      const stdout = execFileSync(argv[0], execution, { cwd: options?.cwd, encoding: "utf8",
        env: process.env, timeout: options?.timeoutMs, maxBuffer: 200_000, stdio: ["ignore", "pipe", "pipe"] });
      return { stdout, stderr: "", exitCode: 0 };
    },
  };
}

describe("bounded live diff snapshots with real local Git", () => {
  it.each(["sha1", "sha256"] as const)("includes committed, staged, untracked and deleted files since the frozen %s baseline", async (format) => {
    const { root, baseline } = repository({ "committed.txt": "before\n", "deleted.txt": "delete me\n", "deleted-empty.txt": "", ".gitignore": "cache/\n" }, format);
    put(root, "committed.txt", "committed by the harness\n");
    git(root, ["add", "committed.txt"]);
    git(root, ["commit", "-q", "-m", "Harness commit"]);
    put(root, "staged.txt", "new staged file\n");
    git(root, ["add", "staged.txt"]);
    const unicodePath = 'a space/"quote-é".txt';
    put(root, unicodePath, "new untracked file\n");
    put(root, "empty.txt", "");
    put(root, "script.sh", "#!/bin/sh\necho hello\n");
    chmodSync(join(root, "script.sh"), 0o755);
    put(root, "cache/private.txt", "ignored and private\n");
    rmSync(join(root, "deleted.txt"));
    rmSync(join(root, "deleted-empty.txt"));
    const head = git(root, ["rev-parse", "HEAD"]);
    const index = readFileSync(join(root, ".git/index"));
    const refs = git(root, ["show-ref"]);

    const preview = await captureLiveDiff(localOps(), root, baseline, []);
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error(preview.reason);
    expect(preview.diff).toContain("+committed by the harness");
    expect(preview.diff).toContain("+new staged file");
    expect(preview.diff).toContain("+new untracked file");
    expect(preview.diff).toContain("deleted file mode 100644");
    expect(preview.diff).toContain("new file mode 100755");
    expect(preview.diff).not.toContain("ignored and private");
    expect(git(root, ["rev-parse", "HEAD"])).toBe(head);
    expect(readFileSync(join(root, ".git/index"))).toEqual(index);
    expect(git(root, ["show-ref"])).toBe(refs);

    git(root, ["reset", "--hard", baseline]);
    git(root, ["clean", "-fdx"]);
    git(root, ["apply", "--check", "-"], preview.diff);
    git(root, ["apply", "-"], preview.diff);
    expect(readFileSync(join(root, "committed.txt"), "utf8")).toBe("committed by the harness\n");
    expect(readFileSync(join(root, "staged.txt"), "utf8")).toBe("new staged file\n");
    expect(readFileSync(join(root, unicodePath), "utf8")).toBe("new untracked file\n");
    expect(readFileSync(join(root, "empty.txt"))).toHaveLength(0);
    expect(statSync(join(root, "script.sh")).mode & 0o111).not.toBe(0);
    expect(existsSync(join(root, "deleted.txt"))).toBe(false);
    expect(existsSync(join(root, "deleted-empty.txt"))).toBe(false);
  });

  it.each([
    ["old\n", "new\n"], ["old", "new\n"], ["old\n", "new"],
    ["", "new\n"], ["old\n", ""], ["old\r\n", "new\r\n"], ["\ufeffold\n", "\ufeffnew\n"],
  ])("preserves exact line endings and empty contents when %j becomes %j", async (before, after) => {
    const { root, baseline } = repository({ "file.txt": before });
    put(root, "file.txt", after);
    const preview = await captureLiveDiff(localOps(), root, baseline, []);
    if (preview.status !== "ready") throw new Error(preview.reason);
    git(root, ["reset", "--hard", baseline]);
    git(root, ["apply", "--check", "-"], preview.diff);
    git(root, ["apply", "-"], preview.diff);
    expect(readFileSync(join(root, "file.txt"))).toEqual(Buffer.from(after));
  });

  it("shows binary changes and executable mode changes without interpreting binary bytes as text", async () => {
    const { root, baseline } = repository({ "binary.bin": Buffer.from([0, 1, 2]), "script.sh": "echo hi\n" });
    put(root, "binary.bin", Buffer.from([0, 255, 3]));
    chmodSync(join(root, "script.sh"), 0o755);
    const preview = await captureLiveDiff(localOps(), root, baseline, []);
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error(preview.reason);
    expect(preview.diff).toContain('Binary files "a/binary.bin" and "b/binary.bin" differ');
    expect(preview.diff).toContain("old mode 100644\nnew mode 100755");
    expect(preview.diff).not.toContain("\0");
  });

  it.each(["parent symlink", "leaf symlink", "FIFO"])("refuses %s without exposing outside bytes or blocking", async (kind) => {
    const { root, baseline } = repository({ "nested/file.txt": "before\n" });
    const outside = directory();
    put(outside, "file.txt", "OUTSIDE_PREVIEW_SECRET\n");
    if (kind === "parent symlink") {
      rmSync(join(root, "nested"), { recursive: true });
      symlinkSync(outside, join(root, "nested"));
    } else if (kind === "leaf symlink") {
      rmSync(join(root, "nested/file.txt"));
      symlinkSync(join(outside, "file.txt"), join(root, "nested/file.txt"));
    } else {
      rmSync(join(root, "nested/file.txt"));
      execFileSync("mkfifo", [join(root, "nested/file.txt")]);
    }
    const preview = await captureLiveDiff(localOps(), root, baseline, []);
    expect(preview.status).toBe("unavailable");
    expect(JSON.stringify(preview)).not.toContain("OUTSIDE_PREVIEW_SECRET");
  });

  it("discards an oversized patch atomically instead of returning a stale or partial diff", async () => {
    const { root, baseline } = repository({ "small.txt": "before\n" });
    put(root, "small.txt", "after\n");
    put(root, "oversized.txt", "x".repeat(LIVE_DIFF_MAX_CHARS));
    const preview = await captureLiveDiff(localOps(), root, baseline, []);
    expect(preview.status).toBe("limited");
    expect(preview).not.toHaveProperty("diff");
    expect(JSON.stringify(preview)).not.toContain("+after");
  });

  it("keeps file reads anchored when a parent is swapped for a symlink after it opens", async () => {
    const { root, baseline } = repository({ "nested/file.txt": "before\n" });
    const outside = directory();
    put(outside, "file.txt", "OUTSIDE_RACE_SECRET\n");
    put(root, "nested/file.txt", "inside captured directory\n");
    const instrument = `{
      const io = require("node:fs"), original = io.openSync;
      let swapped = false;
      io.openSync = function(name, ...args) {
        const fd = original.call(this, name, ...args);
        if (!swapped && String(name).endsWith("/nested")) {
          swapped = true;
          io.renameSync(process.cwd() + "/nested", process.cwd() + "/moved");
          io.symlinkSync(${JSON.stringify(outside)}, process.cwd() + "/nested");
        }
        return fd;
      };
    }`;
    const preview = await captureLiveDiff(localOps(instrument), root, baseline, []);
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error(preview.reason);
    expect(preview.diff).toContain("+inside captured directory");
    expect(preview.diff).not.toContain("OUTSIDE_RACE_SECRET");
  });

  it("rejects a file changed while its descriptor is being read", async () => {
    const { root, baseline } = repository({ "file.txt": "before\n" });
    put(root, "file.txt", "captured value\n");
    const instrument = String.raw`{
      const io = require("node:fs"), original = io.readSync;
      let changed = false;
      io.readSync = function(fd, ...args) {
        const count = original.call(this, fd, ...args);
        if (!changed && io.readlinkSync("/proc/self/fd/" + fd).endsWith("/file.txt")) {
          changed = true;
          io.writeFileSync(process.cwd() + "/file.txt", "changed during read\n");
        }
        return count;
      };
    }`;
    const preview = await captureLiveDiff(localOps(instrument), root, baseline, []);
    expect(preview.status).toBe("unavailable");
    expect(preview).not.toHaveProperty("diff");
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("changed during read\n");
  });

  it("preserves a leading BOM in the first untracked filename", async () => {
    const { root, baseline } = repository();
    const name = "\ufefffile.txt";
    put(root, name, "new\n");
    const preview = await captureLiveDiff(localOps(), root, baseline, []);
    if (preview.status !== "ready") throw new Error(preview.reason);
    rmSync(join(root, name));
    git(root, ["apply", "--check", "-"], preview.diff);
    git(root, ["apply", "-"], preview.diff);
    expect(readFileSync(join(root, name), "utf8")).toBe("new\n");
  });

  it("does not execute repository clean filters or fsmonitor hooks", async () => {
    const { root, baseline } = repository({ "file.txt": "before\n", ".gitattributes": "*.txt filter=malicious\n" });
    git(root, ["config", "filter.malicious.clean", "touch FILTER_EXECUTED"]);
    git(root, ["config", "filter.malicious.required", "true"]);
    git(root, ["config", "core.fsmonitor", "touch FSMONITOR_EXECUTED"]);
    put(root, "file.txt", "after\n");
    const preview = await captureLiveDiff(localOps(), root, baseline, []);
    expect(preview.status).toBe("ready");
    expect(existsSync(join(root, "FILTER_EXECUTED"))).toBe(false);
    expect(existsSync(join(root, "FSMONITOR_EXECUTED"))).toBe(false);
  });

  it("rejects modified baseline object bytes instead of displaying them under a trusted object ID", async () => {
    const { root, baseline } = repository({ "file.txt": "before\n" });
    const oid = git(root, ["rev-parse", `${baseline}:file.txt`]).trim();
    const object = join(root, ".git/objects", oid.slice(0, 2), oid.slice(2));
    const corrupt = Buffer.from("UNTRUSTED_BASELINE_BYTES\n");
    chmodSync(object, 0o644);
    writeFileSync(object, deflateSync(Buffer.concat([Buffer.from(`blob ${corrupt.length}\0`), corrupt])));
    put(root, "file.txt", "after\n");
    const preview = await captureLiveDiff(localOps(), root, baseline, []);
    expect(preview.status).toBe("unavailable");
    expect(JSON.stringify(preview)).not.toContain("UNTRUSTED_BASELINE_BYTES");
  });

  it("never exposes arbitrary container errors through the public preview status", async () => {
    const operations = localOps();
    operations.exec = async () => ({ stdout: JSON.stringify({ status: "limited", reason: "PRIVATE_CONTAINER_VALUE", diff: "PRIVATE_PARTIAL_DIFF" }), stderr: "", exitCode: 0 });
    const preview = await captureLiveDiff(operations, "/workspace/run", "a".repeat(40), []);
    expect(preview.status).toBe("limited");
    expect(preview).not.toHaveProperty("diff");
    expect(JSON.stringify(preview)).not.toContain("PRIVATE");
  });

  it("rejects a symlinked Git directory and invalid baseline identifiers", async () => {
    const { root, baseline } = repository();
    const other = repository();
    rmSync(join(root, ".git"), { recursive: true });
    symlinkSync(join(other.root, ".git"), join(root, ".git"));
    expect((await captureLiveDiff(localOps(), root, baseline, [])).status).toBe("unavailable");
    const operations = localOps();
    operations.exec = async () => { throw new Error("Invalid baseline must be refused before exec."); };
    expect((await captureLiveDiff(operations, root, "HEAD", [])).status).toBe("unavailable");
  });
});
