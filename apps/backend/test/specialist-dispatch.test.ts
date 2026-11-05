import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exploreInputSchema,
  sealSpecialistDispatch,
  verifySpecialistDispatch,
  withinSpecialistDeadline,
} from "../src/agents/specialists/contract.js";
import { createSnapshotTools } from "../src/agents/specialists/snapshot-tools.js";
import { mintSubagentRun } from "../src/den/spawn.js";
import { createRun } from "../src/runs.js";
import { runInputHash } from "@shiba/shared";

const ENV = { INTERNAL_SIGNING_KEY: "test-specialist-key" };
const PARENT_IDENTITY = { className: "CodingOrchestrator", name: "dashboard:owner" };
const PARENT = [PARENT_IDENTITY];
const INPUT = { goal: "Find the handler", context: "Explicit only", files: [{ path: "src/handler.ts", content: "export function handler() { return 1; }" }] };

afterEach(() => vi.useRealTimers());

describe("bounded specialist dispatch", () => {
  it("binds the full explicit input, owner, role, and deadline", async () => {
    const sealed = await sealSpecialistDispatch(ENV, "explorer", PARENT_IDENTITY.name, "child-1", INPUT, 1_000);
    await expect(verifySpecialistDispatch(ENV, sealed, "explorer", PARENT, 1_001)).resolves.toMatchObject({ input: INPUT });
    await expect(verifySpecialistDispatch(ENV, { ...sealed, input: { ...INPUT, goal: "Steal credentials" } }, "explorer", PARENT, 1_001)).rejects.toThrow(/signature/);
    await expect(verifySpecialistDispatch(ENV, sealed, "reviewer", PARENT, 1_001)).rejects.toThrow(/role/);
    await expect(verifySpecialistDispatch(ENV, sealed, "explorer", [{ ...PARENT_IDENTITY, name: "dashboard:other" }], 1_001)).rejects.toThrow(/parent/);
    await expect(verifySpecialistDispatch(ENV, sealed, "explorer", [], 1_001)).rejects.toThrow(/parent/);
    await expect(verifySpecialistDispatch(ENV, sealed, "explorer", [...PARENT, { className: "ExplorerAgent", name: "child" }], 1_001)).rejects.toThrow(/parent/);
    await expect(verifySpecialistDispatch(ENV, sealed, "explorer", PARENT, 61_000)).rejects.toThrow(/deadline/);
  });

  it("refuses credentials, approval fields, traversal, duplicate paths, and oversized context in requests", () => {
    expect(() => exploreInputSchema.parse({ ...INPUT, approval: true })).toThrow();
    expect(() => exploreInputSchema.parse({ ...INPUT, providerKey: "secret" })).toThrow();
    expect(() => exploreInputSchema.parse({ ...INPUT, files: [{ path: "../secret", content: "" }] })).toThrow();
    expect(() => exploreInputSchema.parse({ ...INPUT, files: [INPUT.files[0], INPUT.files[0]] })).toThrow();
    expect(() => exploreInputSchema.parse({ ...INPUT, context: "x".repeat(16_001) })).toThrow();
  });

  it("has read-only tools restricted to the exact snapshot", async () => {
    const tools = createSnapshotTools(exploreInputSchema.parse(INPUT));
    expect(Object.keys(tools).sort()).toEqual(["file_read", "repo_query", "symbol_search"]);
    const opts = { toolCallId: "read", messages: [], context: undefined };
    await expect(tools.file_read?.execute?.({ path: "/etc/environment" }, opts)).resolves.toEqual({ error: "File is outside the supplied snapshot." });
    await expect(tools.symbol_search?.execute?.({ query: "handler" }, opts)).resolves.toMatchObject({ matches: [{ path: "src/handler.ts", line: 1 }] });
    await expect(tools.repo_query?.execute?.({ query: "" }, opts)).resolves.toEqual({ paths: ["src/handler.ts"] });
  });

  it("stops a hung child at the absolute deadline and propagates cancellation", async () => {
    vi.useFakeTimers();
    let childSignal: AbortSignal | undefined;
    const pending = withinSpecialistDeadline(async (signal) => {
      childSignal = signal;
      return new Promise<never>(() => {});
    }, Date.now() + 60_000);
    const rejected = expect(pending).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(childSignal?.aborted).toBe(true);
    const operation = vi.fn();
    await expect(withinSpecialistDeadline(operation, Date.now() - 1)).rejects.toThrow(/deadline/);
    expect(operation).not.toHaveBeenCalled();
  });

  it("observes cancellation raised synchronously while child work starts", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let childSignal: AbortSignal | undefined;
    const settled = vi.fn();
    const pending = withinSpecialistDeadline(async (signal) => {
      childSignal = signal;
      parent.abort();
      return new Promise<never>(() => {});
    }, Date.now() + 60_000, parent.signal).then(
      () => settled("completed"),
      (error: Error) => settled(error.message),
    );
    await vi.advanceTimersByTimeAsync(0);
    const immediateResult = settled.mock.calls[0]?.[0];
    // Drain the old deadline too so a failed ordering regression leaves no work.
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(childSignal?.aborted).toBe(true);
    expect(immediateResult).toMatch(/cancelled/);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("never starts already-cancelled work or accepts a result after cancellation", async () => {
    vi.useFakeTimers();
    const cancelled = new AbortController();
    cancelled.abort(new Error("Stop requested."));
    const notStarted = vi.fn();
    await expect(withinSpecialistDeadline(notStarted, Date.now() + 60_000, cancelled.signal))
      .rejects.toThrow("Stop requested.");
    expect(notStarted).not.toHaveBeenCalled();

    const parent = new AbortController();
    let resolveChild!: (value: string) => void;
    let childSignal: AbortSignal | undefined;
    const settled = vi.fn();
    const pending = withinSpecialistDeadline((signal) => {
      childSignal = signal;
      return new Promise<string>((resolve) => { resolveChild = resolve; });
    }, Date.now() + 60_000, parent.signal).then(
      (value) => settled(value),
      (error: Error) => settled(error.message),
    );
    await vi.advanceTimersByTimeAsync(0);
    parent.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(childSignal?.aborted).toBe(true);
    expect(settled).toHaveBeenCalledWith(expect.stringMatching(/cancelled/));
    resolveChild("late completed result");
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(settled).toHaveBeenCalledTimes(1);
  });
});

describe("child sandbox boundary", () => {
  const fields = { repoUrl: "https://github.com/o/r", task: "Parent", baseBranch: "main", publishPullRequest: false };
  const parent = { ...createRun({ ...fields, runId: "parent", sandboxId: "parent-workspace", approval: { approvalId: "human-parent", decidedBy: "human", decidedAt: 100, inputHash: runInputHash(fields) } }), status: "running" as const };
  const args = { runs: [parent], parent, input: { parentRunId: parent.runId, task: "New child task", sandboxMode: "fresh" as const }, callId: "child" };

  it("cannot turn a preapproved count budget into approval of a new task", () => {
    const legacyBudgetRequest = { ...args, budgetApproval: { approvalId: "human-parent", subagentBudget: 10, decidedBy: "human", decidedAt: 100 }, parentBudgetRemaining: 10 };
    expect(mintSubagentRun(legacyBudgetRequest)).toMatchObject({ ok: false, status: 403 });
  });

  it("cannot nest, share a workspace, or publish an external action", () => {
    expect(mintSubagentRun({ ...args, parent: { ...parent, subagentPath: "1" } })).toMatchObject({ ok: false, status: 400 });
    expect(mintSubagentRun({ ...args, input: { ...args.input, sandboxMode: "shared" } })).toMatchObject({ ok: false, status: 400 });
    expect(mintSubagentRun({ ...args, input: { ...args.input, publishPullRequest: true } })).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses forged frozen-input approval and concurrent children", () => {
    expect(mintSubagentRun({ ...args, childApproval: { approvalId: "forged", decidedBy: "human", decidedAt: 100, inputHash: "bad" } })).toMatchObject({ ok: false, status: 403 });
    expect(mintSubagentRun({ ...args, runs: [parent, { ...parent, runId: "active-child", parentRunId: parent.runId }] })).toMatchObject({ ok: false, status: 429 });
  });

  it("creates an isolated child only for its exact human-approved frozen input", () => {
    const inputHash = runInputHash({ ...fields, task: args.input.task, parentRunId: parent.runId, subagentPath: "1", subagentSandbox: "fresh" });
    const minted = mintSubagentRun({ ...args, childApproval: { approvalId: "human-child", decidedBy: "human", decidedAt: 200, inputHash } });
    expect(minted.ok).toBe(true);
    if (!minted.ok) throw new Error(minted.error);
    expect(minted.run.sandboxId).not.toBe(parent.sandboxId);
    expect(minted.run).toMatchObject({ parentRunId: parent.runId, subagentPath: "1", publishPullRequest: false, approval: { approvalId: "human-child" } });
    expect(minted.run.subagentBudgetRemaining).toBeUndefined();
  });
});
