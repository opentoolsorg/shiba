import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/think", () => ({ Think: class {
  schedule() { return Promise.resolve({}); }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: vi.fn() }));
vi.mock("ai", () => ({ tool: vi.fn() }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import { formatAgentResult, parseAgentResult, type CodingTaskResult } from "../src/opencode-input.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";
import { approveDirect } from "./seeding.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { signInternalRequest } from "../src/edge-identity.js";
import { LOCAL_INTAKE_HEADER } from "@shiba/shared";
import { readFileSync } from "node:fs";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { insertAutomationWorkflowRun, patchAutomationWorkflowRun, listAutomationWorkflowRuns } from "../src/platform/automation-workflow-store.js";

// The release path always destroys the run's sandbox — route it through
// the resolver seam so the suite never loads the real @cloudflare/sandbox
// (a genuine resolution error otherwise prints mid-suite on some runners).
const mocks = vi.hoisted(() => ({ destroy: vi.fn(async () => {}) }));
setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

function completedResult(): CodingTaskResult {
  return {
    status: "completed",
    exitCode: 0,
    stderrTail: "",
    changedFiles: ["a.ts"],
    diff: "diff --git a/a.ts",
    files: [{ path: "a.ts", content: "x", encoding: "utf8" as const }],
    summary: "done",
  };
}

function errorResult(): CodingTaskResult {
  return {
    status: "error",
    exitCode: 3,
    stderrTail: "boom",
    changedFiles: [],
    diff: "",
    files: [],
    summary: "quota exhausted",
  };
}

function makeOrchestrator(): any {
  const instance: any = Object.create(CodingOrchestrator.prototype);
  instance.state = { runs: [] };
  instance.env = productionEnvStubs();
  instance.setState = (s: unknown) => {
    setStateLikeProduction(instance, s as Parameters<CodingOrchestrator["setState"]>[0]);
  };
  return instance;
}

const DELEGATE_INPUT = {
  repoUrl: "https://github.com/owner/repo",
  task: "Fix it.",
  baseBranch: "main",
  publishPullRequest: false,
};

describe("T8 parseAgentResult", () => {
  it("parses a completed envelope as completed", () => {
    const parsed = parseAgentResult(formatAgentResult(completedResult()));
    expect(parsed?.status).toBe("completed");
  });

  it("parses an error envelope as error", () => {
    const parsed = parseAgentResult(formatAgentResult(errorResult()));
    expect(parsed?.status).toBe("error");
    expect(parsed?.summary).toContain("quota exhausted");
  });

  it("returns null for malformed or absent envelopes, never silent success", () => {
    expect(parseAgentResult("just prose, no envelope")).toBeNull();
    expect(parseAgentResult("SHIBA_AI_COWORKER_CODING_RESULT_JSON\n{not json")).toBeNull();
  });
});

describe("T8 orchestrator structured result", () => {
  it("settles cancelled routine workflows and ignores a late child result", async () => {
    const orchestrator = makeOrchestrator();
    const db = customAgentD1();
    for (const migration of ["0055_automation_workflow_runs.sql", "0066_routine_outcomes.sql"]) db.sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    orchestrator.env.AGENT_AUDIT = db.database;
    const pending: Promise<unknown>[] = [];
    orchestrator.ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) };
    vi.spyOn(orchestrator, "postToThread").mockImplementation(() => {});
    vi.spyOn(orchestrator, "releaseSandboxForRun").mockResolvedValue(undefined);
    const row = await insertAutomationWorkflowRun(orchestrator.env, { automationId: "nightly", commandId: "cancel-command" });
    await patchAutomationWorkflowRun(orchestrator.env, row.id, { status: "dispatched", approval_id: "cancel-routine" });
    approveDirect(orchestrator, "cancel-routine", { ...DELEGATE_INPUT, routineRun: { automationId: "nightly", test: false } });
    await orchestrator.cancelRun("agent-tool:cancel-routine");
    await Promise.all(pending);
    const child = vi.fn(async () => formatAgentResult(completedResult()));
    await orchestrator.executeDelegatedTask(DELEGATE_INPUT, child, "cancel-routine");
    expect(child).not.toHaveBeenCalled();
    expect((await listAutomationWorkflowRuns(orchestrator.env, "nightly"))[0]).toMatchObject({ status: "failed", outcome: "failed", failure_reason: "Run cancelled.", run_id: "agent-tool:cancel-routine" });
  });

  it("ignores a caller-supplied routine marker at intake", async () => {
    const orchestrator = makeOrchestrator();
    orchestrator.name = "default";
    const response = await orchestrator.onRequest(new Request("https://internal/api/runs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...DELEGATE_INPUT, routineRun: { automationId: "forged", test: false } }),
    }));
    expect(response.status).toBe(200);
    expect(orchestrator.state.pendingApprovals[0]).not.toHaveProperty("routineRun");
  });
  it("freezes the server-vouched routine marker instead of the request body", async () => {
    const orchestrator = makeOrchestrator();
    orchestrator.name = "default";
    orchestrator.env.INTERNAL_SIGNING_KEY = "ab".repeat(32);
    const request = new Request("https://internal/api/runs", {
      method: "POST", headers: { "content-type": "application/json", [LOCAL_INTAKE_HEADER]: "routine:trusted:test" },
      body: JSON.stringify({ ...DELEGATE_INPUT, routineRun: { automationId: "forged", test: false } }),
    });
    await signInternalRequest(request, orchestrator.env);
    const response = await orchestrator.onRequest(request);
    expect(response.status).toBe(200);
    expect(orchestrator.state.pendingApprovals[0]?.routineRun).toEqual({ automationId: "trusted", test: true });
  });
  it.each([false, true])("does not accept an unsigned routine voucher (signing configured: %s)", async (configured) => {
    const orchestrator = makeOrchestrator();
    orchestrator.name = "default";
    orchestrator.env.INTERNAL_SIGNING_KEY = configured ? "ab".repeat(32) : undefined;
    const response = await orchestrator.onRequest(new Request("https://internal/api/runs", {
      method: "POST", headers: { "content-type": "application/json", [LOCAL_INTAKE_HEADER]: "routine:forged:test" },
      body: JSON.stringify(DELEGATE_INPUT),
    }));
    expect(response.status).toBe(configured ? 401 : 200);
    expect(orchestrator.state.pendingApprovals?.[0]?.routineRun).toBeUndefined();
  });
  it.each([
    [false, false, undefined, false], [true, false, undefined, true], [true, true, undefined, false],
    [false, false, "cannot fetch report", false], [true, false, "cannot fetch report", false],
  ])("retains routine history but suppresses quiet final delivery (%s, %s, %s)", async (noUpdate, test, failureReason, quiet) => {
    const orchestrator = makeOrchestrator();
    const posts = vi.spyOn(orchestrator, "postToThread").mockImplementation(() => {});
    const messages = orchestrator.addMessages = vi.fn(async () => {});
    const notifications = vi.spyOn(orchestrator, "notifyCollaborationRun").mockImplementation(() => {});
    const routineInput = { ...DELEGATE_INPUT, routineRun: { automationId: "nightly", test } };
    approveDirect(orchestrator, "routine", routineInput);
    const childExecute = async () => formatAgentResult({ ...completedResult(), routineOutcome: { noUpdate, failureReason } });
    await orchestrator.executeDelegatedTask(DELEGATE_INPUT, childExecute, "routine");
    expect(orchestrator.state.runs[0]).toMatchObject({ status: "completed", routineRun: routineInput.routineRun, routineOutcome: { noUpdate } });
    expect(orchestrator.state.runs[0].summary).toContain("done");
    expect(orchestrator.state.runResultContext["agent-tool:routine"].summary).toBe("done");
    expect(posts.mock.calls.some(([text]) => typeof text === "string" && text.includes(failureReason ? "Routine run failed: cannot fetch report" : "done"))).toBe(!quiet);
    expect(notifications).toHaveBeenCalledTimes(quiet ? 0 : 1);
    expect(messages).toHaveBeenCalledTimes(quiet ? 0 : 1);
  });
  it("marks an error envelope as error, not completed", async () => {
    const orchestrator = makeOrchestrator();
    approveDirect(orchestrator, "call-error", DELEGATE_INPUT);
    const childExecute = async () => formatAgentResult(errorResult());
    await (orchestrator as unknown as {
      executeDelegatedTask: (input: unknown, child: unknown, id: string) => Promise<string>;
    }).executeDelegatedTask(DELEGATE_INPUT, childExecute, "call-error");
    expect(orchestrator.state.runs).toHaveLength(1);
    expect(orchestrator.state.runs[0]?.status).toBe("error");
  });

  it("marks a completed envelope as completed", async () => {
    const orchestrator = makeOrchestrator();
    approveDirect(orchestrator, "call-ok", DELEGATE_INPUT);
    const childExecute = async () => formatAgentResult(completedResult());
    await (orchestrator as unknown as {
      executeDelegatedTask: (input: unknown, child: unknown, id: string) => Promise<string>;
    }).executeDelegatedTask(DELEGATE_INPUT, childExecute, "call-ok");
    expect(orchestrator.state.runs).toHaveLength(1);
    expect(orchestrator.state.runs[0]?.status).toBe("completed");
  });

  it("marks malformed output as error, never silent success", async () => {
    const orchestrator = makeOrchestrator();
    approveDirect(orchestrator, "call-bad", DELEGATE_INPUT);
    const childExecute = async () => "plain prose with no envelope";
    await (orchestrator as unknown as {
      executeDelegatedTask: (input: unknown, child: unknown, id: string) => Promise<string>;
    }).executeDelegatedTask(DELEGATE_INPUT, childExecute, "call-bad");
    expect(orchestrator.state.runs).toHaveLength(1);
    expect(orchestrator.state.runs[0]?.status).toBe("error");
  });
});
