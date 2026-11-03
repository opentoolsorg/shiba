import { describe, expect, it, vi } from "vitest";
import { sealChildDispatch } from "../src/child-dispatch.js";
import { SandboxRuntimeAdapter, type SandboxOps } from "../src/runtime.js";
import type { CodingTaskInput } from "../src/opencode-input.js";
import type { PreparedRuntimeExecution } from "../src/runtime-recovery.js";
import { OpenCodeHarness } from "../src/harness/opencode.js";
import { FIXTURE_BASELINE_COMMIT, FIXTURE_BASE_REVISION, repositorySnapshotFixture } from "./repository-snapshot-fixture.js";

async function fixture() {
  const initial: CodingTaskInput = { sandboxId: "run-recovery", repoUrl: "https://github.com/owner/repo", baseBranch: "main",
    publishPullRequest: false, task: "Create a.txt", codingModel: "google/gemini-3.5-flash-lite", sandboxProvider: "cloudflare" };
  const input = { ...initial, ...await sealChildDispatch({ INTERNAL_SIGNING_KEY: "test-runtime-key" },
    { approvalId: "approved-runtime", sandboxId: initial.sandboxId, inputHash: "a".repeat(64) }, initial) };
  const snapshot = repositorySnapshotFixture({ status: "?? a.txt\n", files: { "a.txt": "result" } });
  const checkout = vi.fn(async () => {});
  const write = vi.fn(async () => {});
  const exec = vi.fn<SandboxOps["exec"]>(async (command, opts) => {
    if (opts?.journal) {
      opts.onOutput?.("stdout", '{"type":"text","part":{"text":"finished"}}\n');
      return { stdout: "finished", stderr: "", exitCode: 0 };
    }
    const git = await snapshot(command);
    return git ?? { stdout: command.includes("diff") ? "diff --git a/a.txt b/a.txt\n+result" : "", stderr: "", exitCode: 0 };
  });
  const ops: SandboxOps = { journaledExec: true, gitCheckout: checkout, writeFile: write, exec,
    readFile: async () => ({ kind: "utf8", content: "result" }) };
  let prepared: PreparedRuntimeExecution | undefined;
  const freeze = async () => {
    await expect(new SandboxRuntimeAdapter().runCodingTask(ops, input, () => {}, {
      onPrepared: async (record) => { prepared = record; throw new Error("simulated eviction after durable prepare"); },
    })).rejects.toThrow("simulated eviction");
    return prepared!;
  };
  return { ops, input, checkout, write, exec, freeze };
}

describe("prepared native runtime recovery", () => {
  it("persists immutable preparation before launch and resumes without clone, config or baseline writes", async () => {
    const f = await fixture();
    const record = await f.freeze();
    expect(record).toMatchObject({ phase: "harness", provider: "cloudflare", baseRevision: FIXTURE_BASE_REVISION,
      baselineCommit: FIXTURE_BASELINE_COMMIT, setupCommit: null, approvalId: "approved-runtime" });
    expect(f.exec.mock.calls.some(([, opts]) => opts?.journal)).toBe(false);
    f.checkout.mockClear(); f.write.mockClear(); f.exec.mockClear();
    const fence = vi.fn(async () => {
      expect(f.exec.mock.calls.filter(([command]) => command.includes("commit-tree"))).toHaveLength(0);
    });
    const result = await new SandboxRuntimeAdapter().runCodingTask(f.ops, f.input, () => {}, {
      recovery: record, onSettlementStarted: fence,
    });
    expect(result.status).toBe("completed");
    expect(result.baseRevision).toBe(FIXTURE_BASE_REVISION);
    expect(f.checkout).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.exec.mock.calls[0]?.[1]?.journal).toEqual({ jobId: record.jobId, deadline: record.deadline,
      mode: "attach", observationDeadline: record.recoveryDeadline });
    expect(f.exec.mock.calls.filter(([command]) => command.includes("commit-tree"))).toHaveLength(1);
    expect(fence).toHaveBeenCalledOnce();
    expect(f.exec.mock.calls.every(([, opts]) => opts?.requiredJournalJobId === record.jobId)).toBe(true);
  });

  it("persists preparation using the production async capability shape", async () => {
    const f = await fixture(); const prepared = vi.fn(async () => { throw new Error("prepared"); });
    await expect(new SandboxRuntimeAdapter().runCodingTask({ ...f.ops, journaledExec: undefined, supportsJournal: async () => true }, f.input, () => {}, { onPrepared: prepared })).rejects.toThrow("prepared");
    expect(prepared).toHaveBeenCalledOnce();
  });

  it("requires the original journal instance for normal native settlement as well as resumed settlement", async () => {
    const f = await fixture(); let record: PreparedRuntimeExecution | undefined;
    const result = await new SandboxRuntimeAdapter().runCodingTask(f.ops, f.input, () => {}, {
      onPrepared: async (value) => { record = value; },
    });
    expect(result.status).toBe("completed");
    const index = f.exec.mock.calls.findIndex(([, opts]) => opts?.journal !== undefined);
    expect(index).toBeGreaterThan(0);
    expect(f.exec.mock.calls.slice(0, index).every(([, opts]) => opts?.requiredJournalJobId === undefined)).toBe(true);
    expect(f.exec.mock.calls.slice(index + 1).every(([, opts]) => opts?.requiredJournalJobId === record!.jobId)).toBe(true);
  });

  it("allows read-only observation of a completed journal after its original CLI deadline", async () => {
    const f = await fixture(); const record = await f.freeze();
    const now = vi.spyOn(Date, "now").mockReturnValue(record.deadline + 1);
    try {
      expect((await new SandboxRuntimeAdapter().runCodingTask(f.ops, f.input, () => {}, { recovery: record })).status).toBe("completed");
      expect(f.exec.mock.calls.find(([, opts]) => opts?.journal)?.[1]?.journal?.deadline).toBe(record.deadline);
    } finally { now.mockRestore(); }
  });

  it.each(["commandIdentity", "jobId", "envelopeHash", "baselineCommit", "recoveryDeadline", "phase"] as const)(
    "refuses altered or invalid prepared %s before any sandbox operation", async (field) => {
      const f = await fixture(); const record = await f.freeze();
      f.exec.mockClear(); f.write.mockClear(); f.checkout.mockClear();
      const altered = { ...record, [field]: field === "recoveryDeadline" ? record.recoveryDeadline + 1 : "invalid" };
      await expect(new SandboxRuntimeAdapter().runCodingTask(f.ops, f.input, () => {}, {
        recovery: altered as unknown as PreparedRuntimeExecution,
      })).rejects.toThrow();
      expect(f.exec).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled(); expect(f.checkout).not.toHaveBeenCalled();
    });

  it("rejects changed approved input and changed effective environment before attaching", async () => {
    const f = await fixture(); const record = await f.freeze(); f.exec.mockClear();
    await expect(new SandboxRuntimeAdapter().runCodingTask(f.ops, { ...f.input, task: "different task" }, () => {}, { recovery: record })).rejects.toThrow();
    await expect(new SandboxRuntimeAdapter().runCodingTask(f.ops, f.input, () => {}, { recovery: record, env: { CHANGED: "yes" } })).rejects.toThrow();
    expect(f.exec).not.toHaveBeenCalled();
  });

  it("refuses unsupported providers and expired dispatches without falling through to ordinary exec", async () => {
    const f = await fixture(); const record = await f.freeze(); f.exec.mockClear();
    await expect(new SandboxRuntimeAdapter().runCodingTask({ ...f.ops, supportsJournal: async () => false }, f.input, () => {}, { recovery: record })).rejects.toThrow("requires a Cloudflare");
    const now = vi.spyOn(Date, "now").mockReturnValue(record.recoveryDeadline);
    try {
      await expect(new SandboxRuntimeAdapter().runCodingTask(f.ops, f.input, () => {}, { recovery: record })).rejects.toThrow("approved dispatch");
    } finally { now.mockRestore(); }
    expect(f.exec).not.toHaveBeenCalled();
  });

  it("does not collect or run tests if the durable settlement fence fails", async () => {
    const f = await fixture(); const record = await f.freeze(); f.exec.mockClear();
    const result = await new SandboxRuntimeAdapter().runCodingTask(f.ops, f.input, () => {}, {
      recovery: record, onSettlementStarted: async () => { throw new Error("durable fence unavailable"); },
    });
    expect(result.status).toBe("error");
    expect(result.summary).toContain("durable fence unavailable");
    expect(result.errorCode).toBe("outcome_unknown");
    expect(f.exec).toHaveBeenCalledOnce();
  });

  it("returns typed uncertainty when attachment loses the container", async () => {
    const f = await fixture(); const record = await f.freeze();
    f.exec.mockRejectedValueOnce(new Error("Execution container was replaced"));
    const result = await new SandboxRuntimeAdapter().runCodingTask(f.ops, f.input, () => {}, { recovery: record });
    expect(result).toMatchObject({ status: "error", errorCode: "outcome_unknown" });
  });

  it("fails closed before sandbox operations when recovered harness configuration cannot be reconstructed", async () => {
    const f = await fixture(); const record = await f.freeze();
    f.exec.mockClear(); f.checkout.mockClear(); f.write.mockClear();
    const harness = new OpenCodeHarness();
    vi.spyOn(harness, "env").mockImplementation(() => { throw new Error("Invalid frozen harness configuration."); });
    const gap = vi.fn();
    await expect(new SandboxRuntimeAdapter(harness).runCodingTask(f.ops, f.input, () => {}, {
      recovery: record, onStreamGap: gap,
    })).rejects.toThrow("Invalid frozen harness configuration");
    expect(f.exec).not.toHaveBeenCalled(); expect(f.checkout).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
    expect(gap).not.toHaveBeenCalled();
  });

  it("keeps reconstructed enriched commands bound to the original approved envelope", async () => {
    const f = await fixture(); const effective = { ...f.input, chatgptThreadId: "worker-enriched" };
    let record: PreparedRuntimeExecution | undefined;
    await expect(new SandboxRuntimeAdapter().runCodingTask(f.ops, effective, () => {}, {
      approvedInput: f.input, onPrepared: async (value) => { record = value; throw new Error("prepared"); },
    })).rejects.toThrow("prepared");
    expect(record?.envelopeHash).toBe(f.input.dispatchEnvelopeHash);
  });
});
