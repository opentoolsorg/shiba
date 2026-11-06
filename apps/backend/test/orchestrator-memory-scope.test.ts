import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  codeTool: vi.fn((..._args: unknown[]) => ({})),
  distill: vi.fn(async (..._args: unknown[]) => ({ distilled: true, factsBanked: 1, sessionRecorded: true })),
}));
vi.mock("@cloudflare/think", () => ({ Think: class { getTools() { return {}; } } }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/codemode.js", async (original) => ({
  ...await original<typeof import("../src/codemode.js")>(), createRunCodeTool: mocks.codeTool,
}));
vi.mock("../src/session-distill.js", async (original) => ({
  ...await original<typeof import("../src/session-distill.js")>(), distillSession: mocks.distill,
}));
vi.mock("../src/agents/specialists/tools.js", () => ({ createSpecialistTools: () => ({}) }));
vi.mock("../src/employee-run-tools.js", async (original) => ({
  ...await original<typeof import("../src/employee-run-tools.js")>(), createEmployeeRunTools: () => ({}),
}));
vi.mock("../src/extension-skills-tools.js", async (original) => ({
  ...await original<typeof import("../src/extension-skills-tools.js")>(), createExtensionSkillAgentTools: () => ({}),
}));

import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import { createRun, type DelegatedRun } from "../src/runs.js";

const SESSION = "12345678-1234-1234-1234-123456789abc";

function host(name: string) {
  const pending: Promise<unknown>[] = [];
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as object, {
    env: {}, state: { runs: [] }, name, messages: [],
    ctx: { waitUntil: (promise: Promise<unknown>) => pending.push(promise) },
    approvedRunDelegate: () => ({}),
    employeeToolOrgId: () => "self-hosted", employeeDraftStore: () => ({}),
  }) as unknown as CodingOrchestrator;
  return { instance, pending };
}

function run(): DelegatedRun {
  return createRun({ runId: "memory-run", sandboxId: "memory-sandbox", task: "test", repoUrl: "https://github.com/example/repo", baseBranch: "main", publishPullRequest: false });
}

async function distill(instance: CodingOrchestrator, value: DelegatedRun, pending: Promise<unknown>[]) {
  (instance as unknown as { dispatchSessionDistill(value: DelegatedRun): void }).dispatchSessionDistill(value);
  await Promise.all(pending);
}

beforeEach(() => vi.clearAllMocks());

describe("orchestrator memory scope integration", () => {
  it("passes distinct Slack thread partitions without changing general tool authority", () => {
    const first = host("slack:T1:C1:123.000001"), second = host("slack:T1:D1:123.000001");
    first.instance.getTools();
    second.instance.getTools();
    expect(mocks.codeTool.mock.calls.map((call) => call[3])).toEqual([first.instance.name, second.instance.name]);
    expect(mocks.codeTool.mock.calls.map((call) => (call[2] as { principal: string }).principal)).toEqual(["orchestrator-agent", "orchestrator-agent"]);
    expect(mocks.codeTool.mock.calls.map((call) => call[1])).toEqual([undefined, undefined]);
  });

  it("uses the same owner partition for base and named dashboard sessions", () => {
    host("alice@example.test").instance.getTools();
    host(`web:alice@example.test:${SESSION}`).instance.getTools();
    expect(mocks.codeTool.mock.calls.map((call) => call[3])).toEqual(["alice@example.test", "alice@example.test"]);
    expect(mocks.codeTool.mock.calls.map((call) => (call[2] as { principal: string }).principal)).toEqual(["alice@example.test", "alice@example.test"]);
  });

  it("does not select shared legacy memory for default ingress", async () => {
    const current = host("default");
    current.instance.getTools();
    expect(mocks.codeTool.mock.calls[0]?.[3]).toBeNull();
    await distill(current.instance, run(), current.pending);
    expect(mocks.distill).not.toHaveBeenCalled();
  });

  it("banks learned outcomes in the same thread or owner partition the tools can recall", async () => {
    for (const [name, expected] of [["slack:T1:C1:123.000001", "slack:T1:C1:123.000001"], [`web:alice@example.test:${SESSION}`, "alice@example.test"]]) {
      const current = host(name as string);
      current.instance.getTools();
      await distill(current.instance, run(), current.pending);
      expect(mocks.codeTool.mock.calls.at(-1)?.[3]).toBe(expected);
      expect(mocks.distill.mock.calls.at(-1)?.[2]).toEqual({ agent: expected });
    }
  });

  it("never silently copies shared room context into a participant's private learned memory", async () => {
    const current = host(`web:alice@example.test:${SESSION}`);
    await distill(current.instance, { ...run(), collaborationHandoffId: "room-handoff" }, current.pending);
    expect(mocks.distill).not.toHaveBeenCalled();
    expect(current.pending).toEqual([]);
  });
});
