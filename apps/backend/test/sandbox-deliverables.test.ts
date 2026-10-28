import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopedExec } from "../src/exec-allowlist.js";
import { shellJoin } from "../src/security.js";
import { captureCheckpoint, checkpointRef } from "../src/git-checkpoint.js";
import { collectExpectedSandboxDeliverables, DELIVERABLE_BLOB_READER, type SandboxOps } from "../src/runtime.js";

let root: string;
let work: string;
let ops: SandboxOps;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "shiba-sandbox-deliverables-"));
  work = join(root, "repo");
  execFileSync("git", ["init", "-b", "main", work], { stdio: "ignore" });
  writeFileSync(join(work, "README.md"), "initial\n");
  execFileSync("git", ["-C", work, "add", "."]);
  execFileSync("git", ["-C", work, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"], { stdio: "ignore" });
  ops = { exec: vi.fn(async (command: string, options?: { cwd?: string; env?: Record<string, string> }) => ({
    stdout: execFileSync("sh", ["-c", command], { cwd: options?.cwd, env: { ...process.env, ...options?.env }, encoding: "utf8" }), stderr: "", exitCode: 0,
  })) } as unknown as SandboxOps;
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
async function collect(paths: string[]) {
  await captureCheckpoint(ops, work, "fixture", 1);
  return collectExpectedSandboxDeliverables(ops, work, checkpointRef("fixture", 1), paths);
}

describe("requested sandbox artifacts from a settled native Git snapshot", () => {
  it("captures only requested complete regular files, preserving UTF-8/BOM bytes", async () => {
    mkdirSync(join(work, "reports"));
    writeFileSync(join(work, "reports", "brief.md"), "\ufeff# Café \ufffd plan\nActual draft\n");
    writeFileSync(join(work, "campaign.json"), '{"channels":["email"]}\n');
    writeFileSync(join(work, "unrequested.txt"), "must not become an artifact");
    const files = await collect(["reports/brief.md", "campaign.json"]);
    expect(files).toEqual([
      { path: "reports/brief.md", encoding: "utf8", content: "\ufeff# Café \ufffd plan\nActual draft\n" },
      { path: "campaign.json", encoding: "utf8", content: '{"channels":["email"]}\n' },
    ]);
  });

  it("captures valid literal replacement characters beyond the default exec cap with only the fixed reader allowlisted", async () => {
    const content = "\ufffd".repeat(5000)+"\n";
    writeFileSync(join(work, "brief.md"), content);
    await captureCheckpoint(ops, work, "fixture", 1);
    const allowlist = [["git"], ["node", "-e", DELIVERABLE_BLOB_READER]];
    const raw = ops;
    const scoped = { ...ops, exec: (command: string, options: Parameters<SandboxOps["exec"]>[1]) => scopedExec(raw, command, { ...options, allowlist }) };
    expect(await collectExpectedSandboxDeliverables(scoped, work, checkpointRef("fixture", 1), ["brief.md"])).toEqual([{ path: "brief.md", content, encoding: "utf8" }]);
    await expect(scopedExec(raw, shellJoin(["node", "-e", "process.stdout.write('arbitrary')"]), { allowlist })).rejects.toThrow(/Refused scoped exec/);
  });

  it.each(["file", "parent"])("rejects a symlink %s instead of following it outside the approved workspace", async (kind) => {
    const outside = join(root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "brief.md"), "private outside content");
    if (kind === "file") symlinkSync(join(outside, "brief.md"), join(work, "brief.md"));
    else symlinkSync(outside, join(work, "reports"));
    await expect(collect([kind === "file" ? "brief.md" : "reports/brief.md"])).rejects.toThrow(/regular file/);
    expect(vi.mocked(ops.exec).mock.calls.some(([command]) => command.startsWith("'node' '-e' "))).toBe(false);
  });

  it.each(["missing", "binary", "invalid-utf8", "over-cap", "malformed-json"])("refuses %s output", async (kind) => {
    const path = kind === "malformed-json" ? "brief.json" : "brief.md";
    if (kind !== "missing") writeFileSync(join(work, path), kind === "binary" ? Buffer.from([0, 1, 2]) : kind === "invalid-utf8" ? Buffer.from([0xc3, 0x28]) : kind === "over-cap" ? "x".repeat(16_385) : "{not json");
    await expect(collect([path])).rejects.toThrow();
  });

  it("rejects truncated executor output instead of accepting a file tail", async () => {
    writeFileSync(join(work, "brief.md"), "complete long draft\n");
    await captureCheckpoint(ops, work, "fixture", 1);
    const original = ops.exec;
    ops.exec = async (command, options) => {
      const result = await original(command, options);
      return command.startsWith("'node' '-e' ") ? { ...result, stdout: result.stdout.slice(-5) } : result;
    };
    await expect(collectExpectedSandboxDeliverables(ops, work, checkpointRef("fixture", 1), ["brief.md"])).rejects.toThrow(/truncated/);
  });

  it.each([
    ["malformed", "!!!!"], ["noncanonical", "Zh=="], ["truncated", "Zg="],
    ["wrong-size", "Zm8="], ["wrong-object", "Zw=="],
  ])("rejects %s binary transport without accepting alternate artifact bytes", async (_kind, encoded) => {
    writeFileSync(join(work, "brief.md"), "f");
    await captureCheckpoint(ops, work, "fixture", 1);
    const original = ops.exec;
    ops.exec = async (command, options) => {
      const result = await original(command, options);
      return command.startsWith("'node' '-e' ") ? { ...result, stdout: encoded! } : result;
    };
    await expect(collectExpectedSandboxDeliverables(ops, work, checkpointRef("fixture", 1), ["brief.md"])).rejects.toThrow(/transport/);
  });

  it("leaves the legacy flow untouched when no files are requested", async () => {
    expect(await collectExpectedSandboxDeliverables(ops, work, "HEAD", undefined)).toEqual([]);
    expect(ops.exec).not.toHaveBeenCalled();
  });
});
