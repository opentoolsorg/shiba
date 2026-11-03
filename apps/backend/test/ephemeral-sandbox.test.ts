import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceTargetSchema, workspaceTargetToExecutionTarget } from "@shiba/shared";
import { OpenCodeHarness } from "../src/harness/opencode.js";
import type { CodingTaskInput } from "../src/opencode-input.js";
import { tokenizeCommand } from "../src/exec-allowlist.js";
import { collectWorkspaceChanges, SandboxRuntimeAdapter, type SandboxOps } from "../src/runtime.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "shiba-ephemeral-"));
  directories.push(path);
  return path;
}

function localOps(root: string, produce?: () => void): SandboxOps {
  const mapped = (path: string) => path.startsWith("/workspace") ? root + path.slice("/workspace".length) : path;
  return {
    pinEgress: vi.fn(async () => {}),
    gitCheckout: vi.fn(async () => { throw new Error("Ephemeral execution must not clone."); }),
    async writeFile(path, content) {
      mkdirSync(dirname(mapped(path)), { recursive: true });
      writeFileSync(mapped(path), content);
    },
    async exec(command, options) {
      const argv = tokenizeCommand(command);
      if (!argv?.length) throw new Error("Invalid test command");
      if (argv[0] === "test-harness") {
        produce?.();
        options?.onOutput?.("stdout", "workspace output\n");
        return { stdout: "workspace output\n", stderr: "", exitCode: 0 };
      }
      const stdout = execFileSync(argv[0]!, argv.slice(1).map(mapped), {
        cwd: options?.cwd ? mapped(options.cwd) : root,
        env: { ...process.env, ...options?.env },
        timeout: options?.timeoutMs ?? 10_000,
        maxBuffer: 2_000_000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { stdout, stderr: "", exitCode: 0 };
    },
    async readFile() { throw new Error("Archive capture must read immutable Git blobs."); },
  };
}

function snapshot(root: string): void {
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "snapshot"]);
  execFileSync("git", ["-C", root, "update-ref", "refs/shiba/checkpoints/test/1", "HEAD"]);
}

class TestHarness extends OpenCodeHarness {
  override buildArgv() { return ["test-harness"]; }
}

describe("ephemeral sandbox workspace", () => {
  it("runs without a repository, initializes context, and captures empty and binary outputs", async () => {
    const root = directory();
    const ops = localOps(root, () => {
      writeFileSync(join(root, "out/empty.txt"), "");
      writeFileSync(join(root, "out/data.bin"), new Uint8Array([0, 255, 10]));
      writeFileSync(join(root, "working-notes.txt"), "Private intermediate notes.");
    });
    const input: CodingTaskInput = {
      repoUrl: "", baseBranch: "main", task: "Prepare analysis outputs", publishPullRequest: false,
      sandboxId: "ephemeral-test", codingModel: "google/gemini-3.5-flash-lite",
      executionTarget: workspaceTargetToExecutionTarget({ type: "ephemeral", workspaceId: "analysis" }),
      expectedDeliverables: [],
    };
    const terminal = vi.fn();
    const harness = new TestHarness();
    const result = await new SandboxRuntimeAdapter(harness).runCodingTask(ops, input, () => {}, { onTerminal: terminal });

    expect(result.status).toBe("completed");
    expect(ops.pinEgress).toHaveBeenCalledExactlyOnceWith();
    expect(ops.gitCheckout).not.toHaveBeenCalled();
    expect(result.files).toEqual([
      { path: "out/data.bin", content: "AP8K", encoding: "base64" },
      { path: "out/empty.txt", content: "", encoding: "utf8" },
    ]);
    expect(result.changedFiles).toEqual(["out/data.bin", "out/empty.txt"]);
    expect(JSON.parse(readFileSync(join(root, ".shiba/context.json"), "utf8"))).toMatchObject({
      workspaceId: "analysis", outputDirectory: "/workspace/out",
    });
    expect(terminal).toHaveBeenCalledWith("stdout", "workspace output\n");
  }, 60_000);

  it("reads full files larger than the sandbox output cap using bounded chunks", async () => {
    const root = directory();
    mkdirSync(join(root, "out"));
    const bytes = new Uint8Array(1_048_576).fill(255);
    writeFileSync(join(root, "out/data.bin"), bytes);
    snapshot(root);
    const result = await collectWorkspaceChanges(localOps(root), root, "refs/shiba/checkpoints/test/1");
    expect(result.files).toHaveLength(1);
    expect(Buffer.from(result.files[0]!.content!, "base64")).toEqual(Buffer.from(bytes));
  }, 60_000);

  it("handles an empty output directory without inventing files", async () => {
    const root = directory();
    mkdirSync(join(root, "out"));
    snapshot(root);
    expect(await collectWorkspaceChanges(localOps(root), root, "refs/shiba/checkpoints/test/1")).toEqual({ files: [], changedFiles: [], diff: "" });
  });

  it("finishes an empty ephemeral workspace cleanly while retaining repository no-op verification", async () => {
    const root = directory();
    const input: CodingTaskInput = {
      repoUrl: "", baseBranch: "main", task: "Inspect the empty workspace", publishPullRequest: false,
      sandboxId: "empty-workspace", codingModel: "google/gemini-3.5-flash-lite",
      executionTarget: workspaceTargetToExecutionTarget({ type: "ephemeral", workspaceId: "empty" }),
      expectedDeliverables: [],
    };
    const result = await new SandboxRuntimeAdapter(new TestHarness()).runCodingTask(localOps(root), input, () => {});
    expect(result.status).toBe("completed");
    expect(result.files).toEqual([]);
    const repositoryVerdict = await new OpenCodeHarness().verify({ ...input, executionTarget: undefined, repoUrl: "https://github.com/org/repo" }, result);
    expect(repositoryVerdict.ok).toBe(false);
  }, 60_000);

  it("polls live diffs during the active turn, scrubs them, and stops polling at settlement", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let liveReads = 0;
    const ops: SandboxOps = {
      async gitCheckout() {}, async writeFile() {},
      async readFile() { return { kind: "utf8", content: "updated" }; },
      async exec(command, options) {
        if (command === "'test-harness'") {
          signalStarted?.();
          await new Promise<void>((resolve) => { release = resolve; });
          options?.onOutput?.("stdout", "done\n");
          return { stdout: "done\n", stderr: "", exitCode: 0 };
        }
        if (command.includes("--no-ext-diff")) {
          liveReads++;
          return { stdout: "+secret-value", stderr: "", exitCode: 0 };
        }
        if (command.includes("'status'")) return { stdout: " M result.txt\n", stderr: "", exitCode: 0 };
        if (command.includes("'diff'")) return { stdout: "final diff", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const publish = vi.fn();
    try {
      const promise = new SandboxRuntimeAdapter(new TestHarness()).runCodingTask(ops, {
        repoUrl: "https://github.com/org/repo", baseBranch: "main", task: "Fix it", publishPullRequest: false,
        sandboxId: "live-diff", codingModel: "google/gemini-3.5-flash-lite",
      }, () => {}, { onDiff: publish, scrub: (text) => text.replaceAll("secret-value", "[redacted]") });
      await started;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(liveReads).toBe(2);
      expect(publish).toHaveBeenCalledWith("+[redacted]");
      expect(publish).toHaveBeenCalledTimes(1);
      release?.();
      expect((await promise).status).toBe("completed");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(liveReads).toBe(2);
      expect(publish).toHaveBeenLastCalledWith("final diff");
    } finally {
      release?.();
      vi.useRealTimers();
    }
  });

  it.each(["output root", "output child"])("rejects a symlink at the %s without reading its target", async (kind) => {
    const root = directory();
    if (kind === "output root") symlinkSync("/etc", join(root, "out"));
    else {
      mkdirSync(join(root, "out"));
      symlinkSync("/etc/passwd", join(root, "out/passwords.txt"));
    }
    snapshot(root);
    await expect(collectWorkspaceChanges(localOps(root), root, "refs/shiba/checkpoints/test/1")).rejects.toThrow("symlink");
  });

  it("rejects truncated and corrupt artifact transport", async () => {
    const root = directory();
    mkdirSync(join(root, "out"));
    writeFileSync(join(root, "out/result.txt"), "secret-free report");
    snapshot(root);
    const ops = localOps(root);
    const execute = ops.exec.bind(ops);
    ops.exec = async (command, options) => {
      const value = await execute(command, options);
      return command.includes("subarray(offset") ? { ...value, stdout: value.stdout.slice(4) } : value;
    };
    await expect(collectWorkspaceChanges(ops, root, "refs/shiba/checkpoints/test/1")).rejects.toThrow("truncated");
  });

  it("preserves workspace identity and validates malformed selectors", () => {
    const target = workspaceTargetToExecutionTarget({ type: "ephemeral", workspaceId: "research", template: "brief" });
    expect(target).toMatchObject({ kind: "artifact-workspace", workspaceId: "research", template: "brief", expectedDeliverables: [] });
    expect(workspaceTargetSchema.safeParse({ type: "ephemeral", workspaceId: "../escape" }).success).toBe(false);
    expect(workspaceTargetToExecutionTarget({ type: "github", repoUrl: "https://github.com/org/repo" })).toEqual({ kind: "repository", repoUrl: "https://github.com/org/repo", baseBranch: "main" });
  });

  it("marks a transport failure after output as uncertain and never reruns the harness", async () => {
    const executeHarness = vi.fn();
    const gap = vi.fn();
    const ops: SandboxOps = {
      async gitCheckout() {}, async writeFile() {},
      async readFile() { return { kind: "utf8", content: "" }; },
      async exec(command, options) {
        if (command === "'test-harness'") {
          executeHarness();
          options?.onOutput?.("stdout", "accepted operation\n");
          throw new Error("HTTP 503 server error");
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const result = await new SandboxRuntimeAdapter(new TestHarness()).runCodingTask(ops, {
      repoUrl: "https://github.com/org/repo", baseBranch: "main", task: "Run once", publishPullRequest: false,
      sandboxId: "transport-failure", codingModel: "google/gemini-3.5-flash-lite",
    }, () => {}, { onStreamGap: gap });
    expect(result.status).toBe("error");
    expect(result.summary).toContain("Execution outcome is uncertain");
    expect(executeHarness).toHaveBeenCalledOnce();
    expect(gap).toHaveBeenCalledOnce();
  });
});
