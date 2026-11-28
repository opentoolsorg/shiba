import { describe, expect, it, vi } from "vitest";
import { sealChildDispatch } from "../src/child-dispatch.js";
import { tokenizeCommand } from "../src/exec-allowlist.js";
import type { CodingTaskInput } from "../src/opencode-input.js";
import type { PreparedRuntimeExecution } from "../src/runtime-recovery.js";
import { SandboxRuntimeAdapter, type SandboxOps } from "../src/runtime.js";
import { repositorySnapshotFixture } from "./repository-snapshot-fixture.js";

const START = ["'/usr/local/bin/shiba-run-computer'", "'start'"].join(" ");
const EVIDENCE = ["'/usr/local/bin/shiba-run-computer'", "'evidence'"].join(" ");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/CXsAAAAASUVORK5CYII=";
const INPUT: CodingTaskInput = {
  sandboxId: "run-computer",
  repoUrl: "https://github.com/owner/repo",
  baseBranch: "main",
  task: "Inspect a local page.",
  codingModel: "google/gemini-3.5-flash-lite",
  publishPullRequest: false,
  computer: true,
  runtime: "sandbox",
  sandboxProvider: "cloudflare",
};

function fixture(desktopExit = 0, harnessExit = 0, evidenceExit = 0) {
  const events: string[] = [];
  const snapshot = repositorySnapshotFixture({ status: "?? a.txt\n", files: { "a.txt": "result" } });
  const exec = vi.fn<SandboxOps["exec"]>(async (command, options) => {
    const argv = tokenizeCommand(command);
    const desktop = command === START;
    if (desktop) events.push("desktop");
    if (command === EVIDENCE) return { stdout: evidenceExit === 0 ? PNG : "", stderr: "", exitCode: evidenceExit };
    if (argv?.[0] === "git" && (argv[1] === "init" || argv.includes("--allow-empty"))) events.push("init");
    if (options?.journal) events.push("harness");
    return await snapshot(command) ?? {
      stdout: "",
      stderr: desktop ? "internal process detail" : "",
      exitCode: desktop ? desktopExit : options?.journal ? harnessExit : 0,
    };
  });
  const ops = {
    journaledExec: true,
    exec,
    gitCheckout: vi.fn(async () => { events.push("checkout"); }),
    pinEgress: vi.fn(async () => { events.push("pin"); }),
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn<SandboxOps["readFile"]>(async () => ({ kind: "utf8", content: "" })),
  } satisfies SandboxOps;
  return { events, ops };
}

describe("approved run desktop", () => {
  it.each([
    { harness: "antigravity-subscription" }, { harness: "claude-login" },
    { harness: "codex-subscription", codexAuthMode: "device-auth" }, { chatgptAccessToken: "test-only" },
  ] as const)("refuses credential-bearing routes before any sandbox IO: %o", async (route) => {
    const { events, ops } = fixture();
    const result = await new SandboxRuntimeAdapter().runCodingTask(ops, { ...INPUT, ...route }, () => {});
    expect(result.status).toBe("error");
    expect(events).toEqual([]);
    expect(ops.exec).not.toHaveBeenCalled();
  });

  it("starts after the scoped checkout and exposes only the promised tool to the harness", async () => {
    const { events, ops } = fixture();
    const save = vi.fn(async () => { events.push("save"); });

    const result = await new SandboxRuntimeAdapter().runCodingTask(ops, INPUT, () => {}, { exportComputerScreenshot: save });

    expect(result.status).toBe("completed");
    expect(events).toEqual(["checkout", "desktop", "harness", "save"]);
    const launch = ops.exec.mock.calls.find(([command]) => command === START);
    expect(launch?.[1]).toMatchObject({ activeOnly: true, timeoutMs: 25_000 });
    expect(launch?.[1]?.env).toBeUndefined();
    const harness = ops.exec.mock.calls.find(([, options]) => options?.journal);
    const prompt = tokenizeCommand(harness?.[0] ?? "")?.at(-1);
    expect(prompt).toContain("shiba-run-computer tool shot '{}'");
    expect(prompt).toContain("Do not use raw X commands");
    expect(prompt).toContain("Never enter secrets");
    const evidence = ops.exec.mock.calls.find(([command]) => command === EVIDENCE);
    expect(evidence?.[1]).toMatchObject({ activeOnly: true, requiredJournalJobId: harness?.[1]?.journal?.jobId });
    expect(ops.readFile).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledExactlyOnceWith(PNG);
  });

  it("pins and initializes an empty workspace before desktop start", async () => {
    const { events, ops } = fixture();
    const result = await new SandboxRuntimeAdapter().runCodingTask(ops, {
      ...INPUT,
      repoUrl: "",
      executionTarget: { kind: "artifact-workspace", expectedDeliverables: ["a.txt"] },
    }, () => {});
    expect(result.status).toBe("completed");
    expect(events).toEqual(["pin", "init", "init", "desktop", "harness"]);
    expect(ops.gitCheckout).not.toHaveBeenCalled();
  });

  it("does not initialize, mention, or export a desktop for an ordinary run", async () => {
    const { events, ops } = fixture();
    const save = vi.fn(async () => {});
    await new SandboxRuntimeAdapter().runCodingTask(ops, { ...INPUT, computer: undefined }, () => {}, {
      exportComputerScreenshot: save,
    });
    expect(events).toEqual(["checkout", "harness"]);
    expect(ops.exec.mock.calls.every(([command]) => !command.includes("shiba-run-computer"))).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses an unapproved addition and never opens a desktop after checkout failure", async () => {
    const { events, ops } = fixture();
    const adapter = new SandboxRuntimeAdapter();
    expect((await adapter.runCodingTask(ops, INPUT, () => {}, {
      approvedInput: { ...INPUT, computer: false },
    })).status).toBe("error");
    expect(events).toEqual([]);
    ops.gitCheckout.mockRejectedValueOnce(new Error("checkout failed"));
    expect((await adapter.runCodingTask(ops, INPUT, () => {}, {})).status).toBe("error");
    expect(events).toEqual([]);
  });

  it("does not run the harness if desktop start fails or export a failed run", async () => {
    const save = vi.fn(async () => {});
    const desktopFailure = fixture(69);
    const result = await new SandboxRuntimeAdapter().runCodingTask(desktopFailure.ops, INPUT, () => {}, {
      exportComputerScreenshot: save,
    });
    expect(result).toMatchObject({ status: "error", exitCode: 69, stderrTail: "" });
    expect(desktopFailure.events).toEqual(["checkout", "desktop"]);
    const harnessFailure = fixture(0, 1);
    expect((await new SandboxRuntimeAdapter().runCodingTask(harnessFailure.ops, INPUT, () => {}, {
      exportComputerScreenshot: save,
    })).status).toBe("error");
    expect(harnessFailure.ops.exec.mock.calls.some(([command]) => command === EVIDENCE)).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps the completed result when no screenshot was taken or storage fails", async () => {
    const save = vi.fn(async () => { throw new Error("storage unavailable"); });
    const adapter = new SandboxRuntimeAdapter();
    const noShot = fixture(0, 0, 69);
    expect((await adapter.runCodingTask(noShot.ops, INPUT, () => {}, { exportComputerScreenshot: save })).status).toBe("completed");
    expect(save).not.toHaveBeenCalled();
    const { ops } = fixture();
    expect((await adapter.runCodingTask(ops, INPUT, () => {}, { exportComputerScreenshot: save })).status).toBe("completed");
    expect(save).toHaveBeenCalledOnce();
  });

  it("reattaches to the frozen harness command without reinitializing the desktop", async () => {
    const input = { ...INPUT, ...await sealChildDispatch({ INTERNAL_SIGNING_KEY: "test-runtime-key-minimum-32-characters" },
      { approvalId: "approved-computer", sandboxId: INPUT.sandboxId, inputHash: "a".repeat(64) }, INPUT) };
    const adapter = new SandboxRuntimeAdapter();
    const first = fixture();
    let record: PreparedRuntimeExecution | undefined;
    await expect(adapter.runCodingTask(first.ops, input, () => {}, {
      onPrepared: async (prepared) => { record = prepared; throw new Error("simulated eviction"); },
    })).rejects.toThrow("simulated eviction");
    expect(first.events).toEqual(["checkout", "desktop"]);
    if (!record) throw new Error("The runtime did not persist the prepared execution.");
    const recovered = fixture();
    const result = await adapter.runCodingTask(recovered.ops, input, () => {}, { recovery: record });
    expect(result.status).toBe("completed");
    expect(recovered.events).toEqual(["harness"]);
    expect(recovered.ops.exec.mock.calls[0]?.[1]?.journal?.mode).toBe("attach");
  });
});
