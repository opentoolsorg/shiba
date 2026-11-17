import { describe, expect, it, vi } from "vitest";
import type { DelegatedRun } from "@shiba/shared";

vi.mock("@cloudflare/think", () => ({ Think: class {
  setState(next: unknown) { Object.assign(this, { state: next }); }
} }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { createRun } from "../src/runs.js";
import { defaultUsageBudgetPolicy } from "../src/usage.js";

function host(state: OrchestratorState = { runs: [] }) {
  return Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    state, env: { INSTANCE_TYPE: "basic", USAGE_BUDGET_USD: "5" }, name: "owner@example.test",
  });
}

describe("orchestrator cost policy persistence", () => {
  it("stamps only the first terminal transition and preserves it through later writes", () => {
    const run: DelegatedRun = { ...createRun({ runId: "r", sandboxId: "s", repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false, now: 1000 }),
      status: "running", signals: [{ kind: "sandbox.ready", at: 1000 }] };
    const instance = host({ runs: [run] });
    instance.setState({ runs: [{ ...run, status: "completed", updatedAt: 2000 }] });
    const frozen = instance.state.runs[0]?.sandboxMeter;
    expect(frozen).toMatchObject({ status: "estimated", cpuSeconds: .25, ramGbSeconds: 1, diskGbSeconds: 4,
      provenance: { instanceType: "basic", startedAt: 1000, endedAt: 2000 } });
    instance.setState({ runs: [{ ...instance.state.runs[0]!, updatedAt: 9000, sandboxMeter: undefined }] });
    expect(instance.state.runs[0]?.sandboxMeter).toEqual(frozen);
    const legacy = host({ runs: [{ ...run, status: "completed" }] });
    legacy.setState({ runs: [{ ...run, status: "completed", updatedAt: 9000 }] });
    expect(legacy.state.runs[0]?.sandboxMeter).toBeUndefined();
  });

  it("persists a validated policy in DO state and survives a new host", async () => {
    const instance = host();
    const read = () => new Request("https://internal/api/usage/budget");
    expect(await (await instance.onRequest(read())).json()).toMatchObject({ policy: { dailyLimitUsd: 5 } });
    const policy = { ...defaultUsageBudgetPolicy({}), dailyLimitUsd: 2, onExceed: "stop" as const, updatedBy: "owner@example.test", updatedAt: 1000 };
    const put = (body: unknown) => new Request("https://internal/api/usage/budget", { method: "PUT", body: JSON.stringify(body) });
    expect((await instance.onRequest(put({ ...policy, monthlyLimitUsd: -1 }))).status).toBe(400);
    expect((await instance.onRequest(put(policy))).status).toBe(200);
    expect(instance.state.usageBudgetPolicy).toEqual(policy);
    expect(await (await host(structuredClone(instance.state)).onRequest(read())).json()).toEqual({ policy });
    expect((await instance.onRequest(new Request(read(), { method: "POST" }))).status).toBe(405);
    expect((await instance.onRequest(new Request(read(), { headers: { "X-Agent-Principal": "agent" } }))).status).toBe(403);
  });
});
