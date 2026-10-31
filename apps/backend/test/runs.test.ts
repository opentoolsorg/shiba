import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CONCURRENT_RUNS,
  RUN_DEADLINE_MS,
  canStartRun,
  countActiveRuns,
  createRun,
  isActiveStatus,
  recordReceipt,
  transitionRun,
} from "../src/runs.js";
import { makeReceipt } from "../src/receipts.js";
import { evidenceFor } from "./seeding.js";
import { decideRunTransition, type QueuedRunInput, type RunCommand } from "@shiba/shared";

const INPUT = {
  repoUrl: "https://github.com/owner/repo",
  task: "task",
  baseBranch: "main",
  publishPullRequest: false,
};

const QUEUE_METADATA = {
  executionTarget: { kind: "artifact-workspace", workspaceName: "Drafts", expectedDeliverables: ["brief.md"] },
  reviewAfterPublish: true, reviewOf: "reviewed-run", reviewRoundId: "round-one", queuedBy: "principal-one", orgId: "org-one",
  sandboxProvider: "cloudflare", customAgentId: "employee-one", collaborationHandoffId: "handoff-one", customAgentVersion: 2,
  employeeToolPolicyVersion: 2, skillPins: [{ skillId: `skill-${"a".repeat(24)}`, version: 1, name: "Evidence" }],
  route: { purpose: "coding", connectionId: "connection-one", modelId: "model-one", harness: "opencode", policyVersion: 1 },
  continuationKey: "account:home", authAccount: "home", runtime: "local", targetMachineId: "laptop-one",
  testCommand: ["pnpm", "test"], expectedDeliverables: ["brief.md"],
  forkedFrom: { runId: "parent-run", checkpointRef: "refs/shiba/checkpoints/parent/1" },
  parentRunId: "parent-run", subagentPath: "0.1", subagentSandbox: "fresh", captainId: "den-one", role: "fixer",
  envNames: ["TEAM"], envDigest: "a".repeat(64), envSealed: "sealed-environment", runSetup: true,
} satisfies Partial<QueuedRunInput>;

function makeRun(runId: string, status: Parameters<typeof transitionRun>[1] = "pending") {
  const pending = createRun({
    runId,
    sandboxId: `sandbox-${runId}`,
    ...INPUT,
    approval: evidenceFor(INPUT, `ap-${runId}`),
    now: 1000,
  });
  if (status === "completed") {
    return transitionRun(transitionRun(pending, "running", undefined, 2000), status, undefined, 2000);
  }
  return transitionRun(pending, status, undefined, 2000);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("run registry", () => {
  it.each(Object.entries(QUEUE_METADATA))("pending replay retains %s without changing generation or receipts", (key, value) => {
    const run = createRun({ ...INPUT, [key]: value, runId: "replay", sandboxId: "sandbox-replay", now: 1 });
    let command: RunCommand | undefined;
    const next = transitionRun(run, "pending", undefined, 99, undefined, (input, decision) => {
      command = input;
      expect("events" in decision && decision.events[0]).toMatchObject({ replayed: true });
    });
    expect(next).toEqual(run);
    expect(next.generation).toBe(run.generation);
    expect(next.receipts).toEqual(run.receipts);
    expect(command?.type === "queue" && command.input).toMatchObject({ [key]: value });
  });

  it("replays complete queue identity and keeps projected mutable values detached", () => {
    const run = createRun({ ...INPUT, ...QUEUE_METADATA, runId: "all-fields", sandboxId: "sandbox-all", now: 1 });
    const before = structuredClone(run);
    let queueInput: QueuedRunInput | undefined;
    const next = transitionRun(run, "pending", undefined, 99, undefined, (command, decision) => {
      if (command.type !== "queue") throw new Error("Expected queue replay");
      queueInput = command.input;
      expect("events" in decision && decision.events[0]).toMatchObject({ replayed: true });
    });
    expect(next).toEqual(before);
    if (!queueInput) throw new Error("Missing replay input");
    expect(Object.keys(queueInput).sort()).toEqual(Object.keys({ ...INPUT, ...QUEUE_METADATA, sandboxId: run.sandboxId }).sort());
    const changes: Partial<QueuedRunInput>[] = [
      { executionTarget: { ...QUEUE_METADATA.executionTarget, workspaceName: "Different" } },
      { employeeToolPolicyVersion: 3 }, { skillPins: [{ ...QUEUE_METADATA.skillPins[0], version: 2 }] },
      { collaborationHandoffId: "other-handoff" }, { orgId: "other-org" }, { customAgentVersion: 3 },
      { continuationKey: "other-account" }, { authAccount: "other" }, { targetMachineId: "other-laptop" },
      { testCommand: ["pnpm", "lint"] }, { expectedDeliverables: ["other.md"] }, { envDigest: "b".repeat(64) },
      { role: "reviewer" }, { runtime: "sandbox" }, { runSetup: false },
    ];
    for (const change of changes) {
      const decision = decideRunTransition({ run }, { type: "queue", commandId: "changed", runId: run.runId, input: { ...queueInput, ...change }, at: 100 });
      expect("error" in decision && decision.error.code).toBe("input_conflict");
    }
    queueInput.testCommand?.push("--changed");
    queueInput.expectedDeliverables?.push("changed.md");
    queueInput.envNames?.push("OTHER");
    if (queueInput.skillPins?.[0]) queueInput.skillPins[0].name = "Changed";
    if (queueInput.executionTarget?.kind === "artifact-workspace") queueInput.executionTarget.expectedDeliverables.push("changed.md");
    if (queueInput.route) queueInput.route.modelId = "changed";
    if (queueInput.forkedFrom) queueInput.forkedFrom.checkpointRef = "changed";
    expect(run).toEqual(before);
  });
  it("creates pending runs with timestamps", () => {
    const run = createRun({
      runId: "r1",
      sandboxId: "s1",
      repoUrl: "https://github.com/owner/repo",
      task: "t",
      baseBranch: "main",
      publishPullRequest: true,
      now: 42,
    });
    expect(run.status).toBe("pending");
    expect(run.createdAt).toBe(42);
    expect(run.updatedAt).toBe(42);
  });

  it("transitions runs and records summaries", () => {
    const run = transitionRun(makeRun("r1", "running"), "completed", { summary: "done" }, 3000);
    expect(run.status).toBe("completed");
    expect(run.summary).toBe("done");
    expect(run.updatedAt).toBe(3000);
  });

  it("counts only active runs toward the concurrency limit", () => {
    // Policy value, kept in step with max_instances in wrangler.jsonc.
    expect(MAX_CONCURRENT_RUNS).toBe(5);
    expect(isActiveStatus("pending")).toBe(true);
    expect(isActiveStatus("running")).toBe(true);
    expect(isActiveStatus("completed")).toBe(false);
    expect(isActiveStatus("cancelled")).toBe(false);
    const runs = [makeRun("a", "running"), makeRun("b", "completed"), makeRun("c", "pending")];
    expect(countActiveRuns(runs)).toBe(2);
    expect(canStartRun(runs)).toBe(true);
  });

  it("keeps cancellation terminal when late completion arrives", () => {
    const cancelled = transitionRun(makeRun("r1", "running"), "cancelled", undefined, 3000);
    expect(transitionRun(cancelled, "completed", { summary: "late result" }, 4000)).toEqual(cancelled);
    expect(transitionRun(cancelled, "error", { error: "destroyed" }, 4000)).toEqual(cancelled);
  });

  it("uses the clock for creation and transitions without changing the original record", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5000);
    const clockInput = {
      repoUrl: "https://github.com/owner/repo",
      task: "implement the task",
      baseBranch: "develop",
      publishPullRequest: true,
    };
    const pending = createRun({
      runId: "clock",
      sandboxId: "sandbox-clock",
      ...clockInput,
      approval: evidenceFor(clockInput, "ap-clock"),
    });
    expect(pending.createdAt).toBe(5000);
    expect(pending.updatedAt).toBe(5000);
    vi.setSystemTime(6000);
    const running = transitionRun(pending, "running");
    expect(running).toEqual({
      ...pending,
      status: "running",
      generation: pending.generation + 1,
      updatedAt: 6000,
    });
    expect(pending.status).toBe("pending");
    expect(pending.updatedAt).toBe(5000);
    expect(running).not.toBe(pending);
  });

  it.each(["completed", "error", "aborted", "cancelled"] as const)(
    "%s releases a slot while preserving the retained run record",
    (status) => {
      const a = makeRun("a", "running");
      const b = makeRun("b", "pending");
      const c = makeRun("c", "running");
      const finished = transitionRun(c, status, { summary: "progress", error: "diagnostic" }, 3000);
      const retained = [a, b, finished];
      expect(isActiveStatus(status)).toBe(false);
      expect(countActiveRuns(retained)).toBe(2);
      expect(canStartRun(retained)).toBe(true);
      expect(retained).toHaveLength(3);
      expect(finished).toEqual({
        ...c,
        status,
        generation: c.generation + 1,
        summary: "progress",
        error: "diagnostic",
        // T40: a bare "error" transition classifies as executor_failed;
        // callers that know better pass errorCode in the patch.
        ...(status === "error" ? { errorCode: "executor_failed" } : {}),
        updatedAt: 3000,
        receipts:
          status === "cancelled"
            ? c.receipts
            : [
                ...(c.receipts ?? []),
                {
                  at: 3000,
                  kind: status === "completed" ? "submit" : "error",
                  message: "diagnostic",
                },
              ],
      });
      expect(c.status).toBe("running");
    },
  );

  it.each(["pending", "running"] as const)("cancels a %s run without dropping its progress", (status) => {
    const active = { ...makeRun("r1", status), summary: "partial progress", error: "earlier diagnostic" };
    const cancelled = transitionRun(active, "cancelled", undefined, 3000);
    expect(cancelled).toEqual({
      ...active,
      status: "cancelled",
      generation: active.generation + 1,
      updatedAt: 3000,
    });
    expect(countActiveRuns([cancelled])).toBe(0);
    expect(active.status).toBe(status);
  });

  it.each(["cancelled", "aborted"] as const)("does not reactivate a hard-terminal %s run", (status) => {
    const terminal = makeRun("r1", status);
    for (const next of ["pending", "running", "completed", "error", "aborted", "cancelled"] as const) {
      expect(transitionRun(terminal, next, { summary: "late", error: "late" }, 4000)).toEqual(terminal);
    }
  });

  it.each(["completed", "error"] as const)(
    "keeps a terminal %s run immutable; retries require a new run ID",
    (status) => {
      const prior = transitionRun(makeRun("r1", "running"), status, { summary: "first attempt" }, 3000);
      const rerun = transitionRun(prior, "running", undefined, 4000);
      expect(rerun).toEqual(prior);
      expect(rerun.summary).toBe("first attempt");
      expect(rerun.error).toBeUndefined();
    },
  );

  it("allows empty history and blocks an already over-capacity registry", () => {
    expect(countActiveRuns([])).toBe(0);
    expect(canStartRun([])).toBe(true);
    const runs = Array.from({ length: MAX_CONCURRENT_RUNS + 1 }, (_, index) => makeRun(`r${index}`));
    expect(countActiveRuns(runs)).toBe(MAX_CONCURRENT_RUNS + 1);
    expect(canStartRun(runs)).toBe(false);
  });

  it("refuses the run past the concurrency limit and frees a slot on cancel", () => {
    const runs = Array.from({ length: MAX_CONCURRENT_RUNS }, (_, index) =>
      makeRun(`r${index}`, index === MAX_CONCURRENT_RUNS - 1 ? "pending" : "running"),
    );
    expect(canStartRun(runs)).toBe(false);
    const freed = [...runs.slice(0, -1), makeRun("last", "cancelled")];
    expect(canStartRun(freed)).toBe(true);
  });
});

describe("run deadline headroom", () => {
  it("exceeds the worst-case phase budget (clone 5m + harness 15m + git 5m)", () => {
    expect(RUN_DEADLINE_MS).toBeGreaterThanOrEqual(45 * 60 * 1000);
  });
});

describe("grade receipts on terminal runs", () => {
  it("a terminal transition is immutable, but a grade receipt still lands", () => {
    const completed = transitionRun(makeRun("g1", "running"), "completed", { summary: "done" });
    // The bug this pins: re-transitioning a terminal run is a silent no-op,
    // so a quality grade must arrive as a receipt, not a transition.
    const discarded = transitionRun(completed, "completed", { summary: "[quality] never lands" });
    expect(discarded.summary).toBe("done");
    const graded = recordReceipt(completed, makeReceipt("grade", "Result quality: full success."));
    expect(graded.status).toBe("completed");
    expect(graded.summary).toBe("done");
    expect(graded.receipts?.at(-1)?.kind).toBe("grade");
    expect(graded.receipts?.at(-1)?.message).toContain("full success");
  });
});

