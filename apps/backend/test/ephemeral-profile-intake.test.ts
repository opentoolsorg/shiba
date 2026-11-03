import { beforeEach, describe, expect, it, vi } from "vitest";
import { executionTargetSchema, runInputHash, type CustomAgentRecord, type PendingApproval } from "@shiba/shared";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import type { Env } from "../src/env.js";
import { formatAgentToolInput, parseAgentToolInput } from "../src/opencode-input.js";
import { createRun } from "../src/runs.js";
import { sealRunEnv } from "../src/run-env-seal.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), resolveCustom: vi.fn() }));
vi.mock("@cloudflare/think", () => ({ Think: class {
  getTools() { return {}; }
  keepAliveWhile<T>(run: () => Promise<T>) { return run(); }
  async schedule() { return {}; }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/custom-agents-resolve.js", async (original) => ({
  ...await original<typeof import("../src/custom-agents-resolve.js")>(),
  resolveCustomAgentForRun: mocks.resolveCustom,
}));

const PROFILE: CustomAgentRecord = {
  id: "bot-ephemeral", orgId: "self-hosted", slug: "marketing", version: 1, createdAt: 1, updatedAt: 1,
  config: {
    name: "Marketing", instructions: "Prepare the profile deliverables.", harness: "opencode",
    sandboxProvider: "cloudflare", approvalPolicy: "auto_approve",
    defaultRepoUrl: "https://github.com/saved/profile-repository",
    expectedDeliverables: ["marketing/brief.md", "out/sources.json"],
  },
};
const INPUT = {
  repoUrl: "", task: "Prepare the campaign brief", baseBranch: "main", publishPullRequest: false,
  customAgentId: PROFILE.id,
  workspaceTarget: { type: "ephemeral", workspaceId: "campaign" },
  expectedDeliverables: ["out/human.md"],
};

function fixture(metadata?: Record<string, unknown>) {
  const statement = { bind: (..._values: unknown[]) => statement, run: async () => ({ success: true }), first: async () => null };
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: { ...productionEnvStubs(), Sandbox: {}, AGENT_AUDIT: { prepare: () => statement } } as unknown as Env,
    name: "default",
    messages: metadata ? [{ role: "user", parts: [{ type: "text", text: "Human request" }], metadata: { shibaTask: metadata } }] : [],
    state: { runs: [] } as OrchestratorState,
    setState(next: OrchestratorState) { setStateLikeProduction(this, next); },
  });
  return {
    instance,
    queue: (extra: Record<string, unknown> = {}) => instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...INPUT, ...extra }),
    })),
    gate: (extra: Record<string, unknown> = {}) => (instance.getTools().delegate_coding_task as unknown as {
      needsApproval(input: unknown, options: { toolCallId: string }): Promise<boolean>;
    }).needsApproval({ ...INPUT, ...extra }, { toolCallId: "profile-chat" }),
  };
}

function assertFrozenExecutable(approval: PendingApproval): void {
  expect(executionTargetSchema.safeParse(approval.executionTarget).success).toBe(true);
  const frozen = { ...approval, baseBranch: approval.baseBranch ?? "main", publishPullRequest: approval.publishPullRequest === true };
  const run = createRun({ ...frozen, runId: "frozen-run", sandboxId: "frozen-sandbox", approval: {
    approvalId: approval.approvalId, decidedBy: "human", decidedAt: Date.now(), inputHash: runInputHash(frozen),
  } });
  expect(run.executionTarget).toEqual(approval.executionTarget);
  const envelope = parseAgentToolInput([{ role: "user", text: formatAgentToolInput({
    ...frozen, harness: "opencode", sandboxId: "frozen-sandbox", codingModel: approval.route?.modelId ?? "google/gemini-3.5-flash-lite",
  }) }]);
  expect(envelope.executionTarget).toEqual(approval.executionTarget);
  expect(envelope.expectedDeliverables).toEqual(approval.expectedDeliverables);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveCustom.mockResolvedValue(PROFILE);
});

describe("ephemeral profile intake", () => {
  it.each(["http", "chat"])("preserves the explicit ephemeral workspace through %s profile defaults and freezes executable outputs", async (surface) => {
    const f = fixture();
    if (surface === "http") expect((await f.queue()).status).toBe(200);
    else await expect(f.gate()).resolves.toBe(true);
    const approval = f.instance.state.pendingApprovals?.[0];
    expect(approval).toMatchObject({
      repoUrl: "", publishPullRequest: false, status: "pending", customAgentVersion: 1,
      expectedDeliverables: ["out/marketing/brief.md", "out/sources.json", "out/human.md"],
      executionTarget: { kind: "artifact-workspace", workspaceId: "campaign", expectedDeliverables: ["out/marketing/brief.md", "out/sources.json", "out/human.md"] },
    });
    if (!approval) throw new Error("No approval was frozen");
    expect(approval.task).toContain("Ephemeral workspace required outputs");
    expect(approval.task).toContain("- out/marketing/brief.md");
    expect(approval.task).not.toContain("out/out/sources.json");
    assertFrozenExecutable(approval);
    expect(f.instance.state.runs).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
    mocks.resolveCustom.mockResolvedValue({ ...PROFILE, version: 2, config: { ...PROFILE.config, expectedDeliverables: ["replacement.md"] } });
    expect(approval.expectedDeliverables).toEqual(["out/marketing/brief.md", "out/sources.json", "out/human.md"]);
  });

  it.each(["http", "chat"])("preserves legacy artifact required paths through %s profile merging", async (surface) => {
    const f = fixture();
    const input = { workspaceTarget: undefined, executionTarget: { kind: "artifact-workspace", workspaceName: "Legacy", expectedDeliverables: ["reports/human.md"] }, expectedDeliverables: ["reports/human.md"] };
    if (surface === "http") expect((await f.queue(input)).status).toBe(200);
    else await expect(f.gate(input)).resolves.toBe(true);
    const approval = f.instance.state.pendingApprovals?.[0];
    expect(approval?.expectedDeliverables).toEqual(["marketing/brief.md", "out/sources.json", "reports/human.md"]);
    expect(approval?.executionTarget).toMatchObject({ expectedDeliverables: approval?.expectedDeliverables });
    if (!approval) throw new Error("No legacy approval was frozen");
    expect(approval.task).not.toContain("Ephemeral workspace required outputs");
    assertFrozenExecutable(approval);
  });

  it.each(["http", "chat"])("rejects profile paths that exceed bounds after normalization before %s approval", async (surface) => {
    mocks.resolveCustom.mockResolvedValue({ ...PROFILE, config: { ...PROFILE.config, expectedDeliverables: [`${"a".repeat(235)}.md`] } });
    const f = fixture();
    if (surface === "http") expect((await f.queue()).status).toBe(400);
    else await expect(f.gate()).rejects.toThrow();
    expect(f.instance.state.pendingApprovals ?? []).toEqual([]);
    expect(f.instance.state.runs).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each(["executionTarget", "workspaceTarget"])("pins the human %s instead of the model destination or profile repository", async (field) => {
    const target = { kind: "artifact-workspace", workspaceId: "human-choice", expectedDeliverables: ["out/human.md"] };
    const metadata = {
      task: "Human campaign request", customAgentId: PROFILE.id, expectedDeliverables: ["out/human.md"],
      ...(field === "executionTarget" ? { executionTarget: target } : { workspaceTarget: { type: "ephemeral", workspaceId: "human-choice" } }),
    };
    const f = fixture(metadata);
    await expect(f.gate({
      repoUrl: "https://github.com/model/other", task: "Model changed goal", publishPullRequest: true,
      workspaceTarget: { type: "github", repoUrl: "https://github.com/model/other" },
      executionTarget: { kind: "repository", repoUrl: "https://github.com/model/other", baseBranch: "main" },
    })).resolves.toBe(true);
    const approval = f.instance.state.pendingApprovals?.[0];
    expect(approval).toMatchObject({ repoUrl: "", publishPullRequest: false, executionTarget: { workspaceId: "human-choice" } });
    expect(approval?.task).toContain("Human campaign request");
    expect(approval?.task).not.toContain("Model changed goal");
    if (!approval) throw new Error("No human-pinned approval was frozen");
    assertFrozenExecutable(approval);
  });

  it.each([
    { workspaceTarget: { type: "ephemeral", workspaceId: "../escape" } },
    { executionTarget: { kind: "artifact-workspace", workspaceId: "workspace", expectedDeliverables: ["outside.md"] } },
    { executionTarget: null },
  ])("fails closed on an invalid explicit composer target %j", async (metadata) => {
    const f = fixture(metadata);
    await expect(f.gate()).rejects.toThrow("Invalid composer workspace target");
    expect(f.instance.state.pendingApprovals ?? []).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves an explicit human repository against a model-selected ephemeral workspace", async () => {
    const f = fixture({ executionTarget: { kind: "repository", repoUrl: "https://github.com/human/chosen", baseBranch: "stable" } });
    await expect(f.gate({ expectedDeliverables: undefined })).resolves.toBe(true);
    expect(f.instance.state.pendingApprovals?.[0]).toMatchObject({
      repoUrl: "https://github.com/human/chosen", baseBranch: "stable",
      executionTarget: { kind: "repository", repoUrl: "https://github.com/human/chosen", baseBranch: "stable" },
      expectedDeliverables: ["marketing/brief.md", "out/sources.json"],
    });
  });

  it("rejects conflicting explicit composer destinations before minting an approval", async () => {
    const f = fixture({
      workspaceTarget: { type: "ephemeral", workspaceId: "human-workspace" },
      executionTarget: { kind: "repository", repoUrl: "https://github.com/human/chosen", baseBranch: "main" },
    });
    await expect(f.gate()).rejects.toThrow("conflicts");
    expect(f.instance.state.pendingApprovals ?? []).toEqual([]);
  });

  it("freezes an isolated cloud runtime and its sealed context despite a local deployment default", async () => {
    const metadata: Record<string, unknown> = { workspaceTarget: { type: "ephemeral", workspaceId: "cloud-only" }, expectedDeliverables: ["out/human.md"] };
    const f = fixture(metadata);
    f.instance.name = "human@example.com";
    f.instance.env.RUNTIME = "local";
    const sealed = await sealRunEnv(f.instance.env, f.instance.name, [{ name: "CAMPAIGN_LABEL", value: "summer-campaign" }]);
    metadata.environment = { sealed: sealed.sealed, digest: sealed.digest };
    await expect(f.gate({ runtime: "local" })).resolves.toBe(true);
    expect(f.instance.state.pendingApprovals?.[0]).toMatchObject({
      runtime: "sandbox", repoUrl: "", executionTarget: { workspaceId: "cloud-only" },
      envNames: ["CAMPAIGN_LABEL"], envDigest: sealed.digest,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("applies cloud provider preflight even when both the deployment and model request local execution", async () => {
    mocks.resolveCustom.mockResolvedValue({ ...PROFILE, config: { ...PROFILE.config, sandboxProvider: "e2b" } });
    const f = fixture();
    f.instance.name = "human@example.com";
    f.instance.env.RUNTIME = "local";
    await expect(f.gate({ runtime: "local" })).rejects.toThrow(/e2b|egress|capabilit/i);
    expect(f.instance.state.pendingApprovals ?? []).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
