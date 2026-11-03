import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenizeCommand } from "../src/exec-allowlist.js";
import {
  collectWorkspaceChanges,
  WORKSPACE_BLOB_READER,
  WORKSPACE_MANIFEST_READER,
  type SandboxOps,
} from "../src/runtime.js";
import { MAX_WORKSPACE_ARTIFACT_BYTES, MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES } from "../src/run-deliverables.js";

const CHECKPOINT = "refs/shiba/checkpoints/security/1";
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function objectId(data: Buffer): string {
  return createHash("sha1").update(`blob ${data.byteLength}\0`).update(data).digest("hex");
}

function manifestOps(entries: string[], bodies: Map<string, Buffer> = new Map(), declaredSize?: string) {
  const exec = vi.fn<SandboxOps["exec"]>(async (command) => {
    const argv = tokenizeCommand(command);
    if (argv?.[0] === "node" && argv[2] === WORKSPACE_MANIFEST_READER) {
      return { stdout: JSON.stringify({ tree: Buffer.from(entries.length ? `${entries.join("\0")}\0` : "").toString("base64") }), stderr: "", exitCode: 0 };
    }
    if (argv?.[0] === "git" && argv[1] === "cat-file" && argv[2] === "-s") {
      const body = bodies.get(argv[3] ?? "");
      return { stdout: declaredSize ?? String(body?.byteLength ?? 0), stderr: "", exitCode: 0 };
    }
    if (argv?.[0] === "node" && argv[2] === WORKSPACE_BLOB_READER) {
      const body = bodies.get(argv[3] ?? "");
      const offset = Number(argv[4]);
      return { stdout: body ? Buffer.from(body.subarray(offset, offset + 196_608)).toString("base64") : "", stderr: "", exitCode: 0 };
    }
    throw new Error(`Unexpected operation: ${argv?.[0]}`);
  });
  const readFile = vi.fn<SandboxOps["readFile"]>(async () => { throw new Error("Mutable filesystem reads are forbidden."); });
  const ops: SandboxOps = {
    async gitCheckout() {}, async writeFile() {}, exec, readFile,
  };
  return { ops, exec, readFile };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe("artifact snapshot export security", () => {
  it.each([
    "120000 blob", "160000 commit", "040000 tree", "100600 blob",
  ])("refuses unsupported Git entry mode and type %j before fetching bytes", async (mode) => {
    const { ops, exec, readFile } = manifestOps([`${mode} ${"a".repeat(40)}\tout/result.txt`]);
    await expect(collectWorkspaceChanges(ops, "/workspace", CHECKPOINT)).rejects.toThrow("symlink");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([
    "out/../private.txt", "out/a/../../private.txt", "out/.env", "out/a/.private", "out/a\\b.txt",
    "out//result.txt", "out/ result.txt", "outside/result.txt", "out", "out/name\tsecret.txt",
  ])("refuses unsafe manifest path %j before object reads", async (path) => {
    const { ops, exec } = manifestOps([`100644 blob ${"b".repeat(40)}\t${path}`]);
    await expect(collectWorkspaceChanges(ops, "/workspace", CHECKPOINT)).rejects.toThrow("unsupported path");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("rejects case-insensitive duplicate paths before reading the second body", async () => {
    const body = Buffer.from("report");
    const oid = objectId(body);
    const { ops, exec } = manifestOps([
      `100644 blob ${oid}\tout/report.txt`, `100644 blob ${oid}\tout/REPORT.txt`,
    ], new Map([[oid, body]]));
    await expect(collectWorkspaceChanges(ops, "/workspace", CHECKPOINT)).rejects.toThrow("duplicate filename");
    const sizeReads = exec.mock.calls.filter(([command]) => tokenizeCommand(command)?.[2] === "-s");
    expect(sizeReads).toHaveLength(1);
  });

  it("rejects over-count manifests before any object size or body reads", async () => {
    const { ops, exec } = manifestOps(Array.from({ length: 65 }, (_, index) => `100644 blob ${"c".repeat(40)}\tout/${index}.bin`));
    await expect(collectWorkspaceChanges(ops, "/workspace", CHECKPOINT)).rejects.toThrow("file count");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it.each([String(MAX_WORKSPACE_ARTIFACT_BYTES + 1), "-1", "1.5", "9007199254740992", "NaN"])("refuses invalid or oversized declared blob size %j before body reads", async (size) => {
    const { ops, exec } = manifestOps([`100644 blob ${"d".repeat(40)}\tout/result.bin`], new Map(), size);
    await expect(collectWorkspaceChanges(ops, "/workspace", CHECKPOINT)).rejects.toThrow("file size limit");
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("rejects same-length corruption despite valid base64 byte transport", async () => {
    const original = Buffer.from("approved output");
    const changed = Buffer.from("tampered output");
    expect(changed.byteLength).toBe(original.byteLength);
    const oid = objectId(original);
    const { ops } = manifestOps([`100644 blob ${oid}\tout/result.txt`], new Map([[oid, changed]]));
    await expect(collectWorkspaceChanges(ops, "/workspace", CHECKPOINT)).rejects.toThrow("corrupt byte transport");
  });

  it("rejects a missing final manifest boundary rather than accepting a partial file list", async () => {
    const { ops, exec } = manifestOps([]);
    exec.mockResolvedValueOnce({
      stdout: JSON.stringify({ tree: Buffer.from(`100644 blob ${"e".repeat(40)}\tout/result.txt`).toString("base64") }),
      stderr: "", exitCode: 0,
    });
    await expect(collectWorkspaceChanges(ops, "/workspace", CHECKPOINT)).rejects.toThrow("malformed, truncated");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("enforces total bytes before reading the first blob beyond the archive budget", async () => {
    const body = Buffer.alloc(MAX_WORKSPACE_ARTIFACT_BYTES, 0xff);
    const oid = objectId(body);
    const accepted = MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES / MAX_WORKSPACE_ARTIFACT_BYTES;
    const { ops, exec } = manifestOps(Array.from({ length: accepted + 1 }, (_, index) => `100644 blob ${oid}\tout/${index}.bin`), new Map([[oid, body]]));
    await expect(collectWorkspaceChanges(ops, "/workspace", CHECKPOINT)).rejects.toThrow("total byte limit");
    const sizeReads = exec.mock.calls.filter(([command]) => tokenizeCommand(command)?.[2] === "-s");
    const bodyReads = exec.mock.calls.filter(([command]) => tokenizeCommand(command)?.[2] === WORKSPACE_BLOB_READER);
    expect(sizeReads).toHaveLength(accepted + 1);
    expect(bodyReads).toHaveLength(accepted * Math.ceil(MAX_WORKSPACE_ARTIFACT_BYTES / 196_608));
  }, 60_000);

  it("exports the retained commit after files become symlinks and the checkpoint ref is repointed", async () => {
    const root = mkdtempSync(join(tmpdir(), "shiba-artifact-security-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "out"));
    writeFileSync(join(root, "out/result.txt"), "approved snapshot");
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "original snapshot");
    const commit = git(root, "rev-parse", "HEAD");
    git(root, "update-ref", CHECKPOINT, commit);
    rmSync(join(root, "out/result.txt"));
    symlinkSync("/etc/passwd", join(root, "out/result.txt"));
    git(root, "add", "-A");
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "changed snapshot");
    git(root, "update-ref", CHECKPOINT, "HEAD");
    const { ops, readFile } = manifestOps([]);
    ops.exec = async (command, options) => {
      const argv = tokenizeCommand(command);
      if (!argv?.[0]) throw new Error("Invalid command");
      return {
        stdout: execFileSync(argv[0], argv.slice(1), {
          cwd: options?.cwd, encoding: "utf8", maxBuffer: 2_000_000,
          stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
        }),
        stderr: "", exitCode: 0,
      };
    };
    const result = await collectWorkspaceChanges(ops, root, commit);
    expect(result.files).toEqual([{ path: "out/result.txt", content: "approved snapshot", encoding: "utf8" }]);
    expect(readFile).not.toHaveBeenCalled();
  }, 60_000);
});
