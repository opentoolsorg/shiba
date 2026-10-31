import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodingOrchestrator, delegateInputSchema } from "../src/agents/orchestrator.js";
import type { OrchestratorState } from "../src/agents/orchestrator.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { HARNESS_IDS } from "@shiba/shared";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { createCustomAgent, updateCustomAgent } from "../src/custom-agents-store.js";
import { replaceEmployeeToolGrants } from "../src/employee-tool-store.js";
import { activateSkill, createSkill, disableSkill, reviewSkill } from "../src/skills-store.js";
import { LocalDispatch } from "../src/local-dispatch.js";
import { createRun, RunStore, RUN_DEADLINE_MS, type DelegatedRun } from "../src/runs.js";
import { formatAgentResult, parseAgentToolInput } from "../src/opencode-input.js";
import { createPendingApproval, resolvePendingApproval } from "../src/pending-approvals.js";
import { artifactIdentity, prepareRunArtifacts } from "../src/artifact-metadata.js";
import { createDurableTask, updateTaskAttempt } from "../src/task-attempts.js";
import { approveDirect } from "./seeding.js";
import {
  addCollaborationMember,
  cancelCollaborationHandoff,
  COLLAB_TENANT_ID,
  COLLAB_WORKSPACE_ID,
  createCollaborationRoom,
  createRootCollaborationHandoff,
  humanActorId,
  linkCollaborationHandoffRun,
} from "../src/collaboration-store.js";
import {
  destroyManagedContainer,
  forgetLeaked,
  leakedContainers,
  setSandboxHandleResolver,
} from "../src/sandbox/lifecycle.js";

const mocks = vi.hoisted(() => ({
  destroy: vi.fn(),
  execute: vi.fn(),
  keepAliveWhile: vi.fn((fn: () => Promise<unknown>) => fn()),
  schedule: vi.fn(async (..._args: unknown[]) => ({})),
  triage: vi.fn(),
  quality: vi.fn(),
}));
vi.mock("../src/session-triage.js", () => ({ evaluateSessionTriage: mocks.triage }));
vi.mock("../src/result-quality.js", () => ({ evaluateResultQuality: mocks.quality }));
vi.mock("@cloudflare/think", () => ({ Think: class {
  onStart() {}
  getTools() { return {}; }
  onRequest() { return new Response(null, { status: 404 }); }
  keepAliveWhile(fn: () => Promise<unknown>) { return mocks.keepAliveWhile(fn); }
  schedule(...args: unknown[]) { return mocks.schedule(...args); }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
// Resolver seam, not vi.mock: detached continuations (an aborted child's
// finally) can bypass vi.mock's dynamic-import interception and load the
// real SDK.
setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

function agent() {
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: { ...productionEnvStubs(), Sandbox: {}, GITHUB_TOKEN: "test-token" }, state: { runs: [] } as OrchestratorState,
    setState(state: OrchestratorState) { setStateLikeProduction(this, state); },
  });
  return instance;
}

function retained(status: "running" | "completed" = "running") {
  return { ...createRun({ runId: "r1", sandboxId: "s1", repoUrl: "https://github.com/o/r",
    task: "fix", baseBranch: "main", publishPullRequest: false, now: Date.now() - RUN_DEADLINE_MS - 1 }), status };
}

beforeEach(() => { vi.resetAllMocks(); mocks.destroy.mockResolvedValue(undefined); });
afterEach(() => {
  for (const leak of leakedContainers()) forgetLeaked(leak.sandboxId);
});

describe("local run cleanup", () => {
  function mailbox(instance: ReturnType<typeof agent>, run: DelegatedRun, status: "claimed" | "settled" = "claimed") {
    const records = new Map<string, unknown>([[`run:${run.sandboxId}`, {
      envelope: { sandboxId: run.sandboxId }, status, claimToken: "old-claim", claimedAt: Date.now(),
      ...(status === "settled" ? { result: { exitCode: 0 }, settledAt: Date.now() } : {}),
    }]]);
    const storage = {
      get: async (key: string) => records.get(key),
      put: async (key: string, value: unknown) => void records.set(key, value),
      delete: async (key: string) => records.delete(key),
      list: async ({ prefix }: { prefix: string }) => new Map([...records].filter(([key]) => key.startsWith(prefix))),
    };
    const dispatch = new LocalDispatch({ storage } as never, {} as never);
    const fetch = vi.fn((request: Request) => dispatch.fetch(request));
    Object.assign(instance.env, { LocalDispatch: { idFromName: () => ({}), get: () => ({ fetch }) } });
    return { records, fetch, dispatch };
  }

  it("prunes another actor's copied leak using positive mailbox identity without a retained local run", async () => {
    const instance = agent();
    const run = { ...retained("completed"), runtime: "local" as const };
    const local = mailbox(instance, run, "settled");
    const leak = { sandboxId: run.sandboxId, leakedAt: 1, error: "copied legacy local leak", selection: { taskProviderId: "cloudflare" } };
    instance.setState({ runs: [], leakedContainers: { [run.sandboxId]: leak } });

    await instance.reclaimRuns();

    expect(local.fetch).toHaveBeenCalledOnce();
    expect(local.fetch.mock.calls[0]?.[0].method).toBe("GET");
    expect(instance.state.leakedContainers?.[run.sandboxId]).toBeUndefined();
    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(local.records.get(`run:${run.sandboxId}`)).toMatchObject({ status: "settled", result: { exitCode: 0 } });
  });

  it.each(["not-found", "unavailable", "invalid-status"])("preserves cloud retries when local proof is %s", async (proof) => {
    const instance = agent();
    const run = retained();
    const local = mailbox(instance, run);
    local.records.clear();
    if (proof === "unavailable") local.fetch.mockRejectedValueOnce(new Error("mailbox down"));
    if (proof === "invalid-status") local.fetch.mockResolvedValueOnce(Response.json({ status: "unrecognized" }));
    instance.setState({ runs: [], leakedContainers: {
      [run.sandboxId]: { sandboxId: run.sandboxId, leakedAt: 1, error: "cloud", selection: { taskProviderId: "cloudflare" } },
    } });

    await instance.reclaimRuns();

    expect(local.fetch).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(instance.state.leakedContainers?.[run.sandboxId]).toBeUndefined();
  });

  it("serves dashboard reads while cloud cleanup is held and permits only one retry sweep", async () => {
    const instance = agent();
    const held: Promise<unknown>[] = [];
    Object.assign(instance, { ctx: { waitUntil: (promise: Promise<unknown>) => held.push(promise) } });
    const leak = { sandboxId: "held-cloud", leakedAt: 1, error: "cloud", selection: { taskProviderId: "cloudflare" } };
    instance.setState({ runs: [], leakedContainers: { [leak.sandboxId]: leak } });
    let finish!: () => void;
    mocks.destroy.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const read = instance.onRequest(new Request("https://internal/api/runs"));
    try {
      await vi.waitFor(() => expect(mocks.destroy).toHaveBeenCalledOnce());
      let response: Response | undefined;
      void read.then((value) => { response = value; });
      await vi.waitFor(() => expect(response?.status).toBe(200));
      Object.assign(instance, { lastReclaimSweepAt: undefined });
      expect((await instance.onRequest(new Request("https://internal/api/runs"))).status).toBe(200);
      expect(mocks.destroy).toHaveBeenCalledOnce();
    } finally {
      finish();
      await read;
      await Promise.all(held);
    }
    expect(instance.state.leakedContainers?.[leak.sandboxId]).toBeUndefined();
  });

  it("releases the background sweep after a cloud failure so the next read retries successfully", async () => {
    const instance = agent();
    const held: Promise<unknown>[] = [];
    Object.assign(instance, { ctx: { waitUntil: (promise: Promise<unknown>) => held.push(promise) } });
    const leak = { sandboxId: "recovering-cloud", leakedAt: 1, error: "cloud", selection: { taskProviderId: "cloudflare" } };
    instance.setState({ runs: [], leakedContainers: { [leak.sandboxId]: leak } });
    mocks.destroy.mockRejectedValueOnce(new Error("provider temporarily unavailable"));

    expect((await instance.onRequest(new Request("https://internal/api/runs"))).status).toBe(200);
    await Promise.all(held);
    expect(instance.state.leakedContainers?.[leak.sandboxId]).toBeDefined();
    Object.assign(instance, { lastReclaimSweepAt: undefined });
    expect((await instance.onRequest(new Request("https://internal/api/runs"))).status).toBe(200);
    await Promise.all(held);

    expect(mocks.destroy).toHaveBeenCalledTimes(2);
    expect(instance.state.leakedContainers?.[leak.sandboxId]).toBeUndefined();
  });

  it("finishes a local run without touching a cloud container or cancelling its settled result", async () => {
    const instance = agent();
    Object.assign(instance, { name: "local-operator" });
    Object.assign(instance.env, { SHIBA_LOCAL_RUNTIME: "1" });
    const input = { repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false, runtime: "local" as const };
    approveDirect(instance, "local-finish", input);
    const local = mailbox(instance, instance.state.runs[0]!, "settled");
    mocks.execute.mockResolvedValue(formatAgentResult({
      status: "completed", summary: "Done", exitCode: 0, stderrTail: "", changedFiles: [], diff: "", files: [],
    }));
    const delegate = instance.getTools()["delegate_coding_task"] as { execute: (input: unknown, options?: unknown) => Promise<unknown> };

    await delegate.execute(input, { toolCallId: "local-finish" });

    expect(instance.state.runs[0]?.status).toBe("completed");
    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(local.fetch).not.toHaveBeenCalled();
    expect(leakedContainers()).toHaveLength(0);
  });

  it("cancels a local mailbox claim without touching cloud and fences a late native result", async () => {
    const instance = agent();
    const run = { ...retained(), runtime: "local" as const, updatedAt: Date.now() };
    instance.setState({ runs: [run] });
    const local = mailbox(instance, run);

    await instance.cancelRun(run.runId);

    expect(instance.state.runs[0]?.status).toBe("cancelled");
    expect(local.records.get(`run:${run.sandboxId}`)).toMatchObject({ status: "cancelled", claimToken: undefined });
    const late = await local.dispatch.fetch(new Request("https://local-dispatch/result", {
      method: "POST", body: JSON.stringify({ sandboxId: run.sandboxId, claimToken: "old-claim", result: {} }),
    }));
    expect(late.status).toBe(409);
    expect(mocks.destroy).not.toHaveBeenCalled();
  });

  it("revokes a local claim after restart without blocking start or creating cloud leaks", async () => {
    const instance = agent();
    const run = { ...retained(), runtime: "local" as const, checkpoint: "executing" as const };
    instance.setState({ runs: [run] });
    const local = mailbox(instance, run);
    const held: Promise<unknown>[] = [];
    Object.assign(instance, { ctx: { waitUntil: (promise: Promise<unknown>) => held.push(promise) } });

    await instance.onStart();
    await Promise.all(held);

    expect(instance.state.runs[0]?.status).toBe("unknown");
    expect(local.records.get(`run:${run.sandboxId}`)).toMatchObject({ status: "cancelled", claimToken: undefined });
    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(leakedContainers()).toHaveLength(0);
  });

  it.each(["claimed", "settled"] as const)("reclaims a stale local run while preserving a %s mailbox outcome", async (status) => {
    const instance = agent();
    const run = { ...retained(), runtime: "local" as const };
    instance.setState({ runs: [run] });
    const local = mailbox(instance, run, status);

    await instance.reclaimRuns();

    expect(instance.state.runs[0]?.status).toBe("unknown");
    expect(local.records.get(`run:${run.sandboxId}`)).toMatchObject({ status: status === "settled" ? "settled" : "cancelled" });
    if (status === "settled") expect(local.records.get(`run:${run.sandboxId}`)).toMatchObject({ result: { exitCode: 0 } });
    expect(mocks.destroy).not.toHaveBeenCalled();
  });

  it("forgets proven local cloud-leak mistakes while retaining unknown leaks and retrying real cloud leaks", async () => {
    const instance = agent();
    const run = { ...retained("completed"), runtime: "local" as const };
    const selection = { taskProviderId: "cloudflare" };
    mocks.destroy.mockRejectedValueOnce(new Error("old incorrect local cloud cleanup"));
    await destroyManagedContainer(instance.env, run.sandboxId, undefined, selection);
    instance.setState({ runs: [run], leakedContainers: {
      [run.sandboxId]: { sandboxId: run.sandboxId, leakedAt: 1, error: "local", selection },
      "real-cloud": { sandboxId: "real-cloud", leakedAt: 1, error: "cloud", selection },
      unknown: { sandboxId: "unknown", leakedAt: 1, error: "unknown" },
    } });
    mocks.destroy.mockClear();

    await instance.reclaimRuns();

    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(instance.state.leakedContainers?.[run.sandboxId]).toBeUndefined();
    expect(leakedContainers().some((leak) => leak.sandboxId === run.sandboxId)).toBe(false);
    expect(instance.state.leakedContainers?.unknown).toBeDefined();
    expect(instance.state.leakedContainers?.["real-cloud"]).toBeUndefined();
  });
});

describe("room handoff dispatch fences", () => {
  it("does not dispatch an approval after the linked room lineage was cancelled", async () => {
    const instance = agent();
    const db = customAgentD1();
    Object.assign(instance.env, { AGENT_AUDIT: db.database });
    const collaborationEnv = { AGENT_AUDIT: db.database };
    const scope = { tenantId: COLLAB_TENANT_ID, workspaceId: COLLAB_WORKSPACE_ID, userId: "owner@example.test" };
    const roomId = "room-dispatch-fence";
    const handoffId = "handoff-dispatch-fence";
    const employeeId = "employee-dispatch-fence";
    await createCollaborationRoom(collaborationEnv, scope, {
      roomId, title: "Dispatch fence", visibility: "private", createdAt: Date.now(),
    });
    await addCollaborationMember(collaborationEnv, scope, roomId, {
      userId: scope.userId, displayName: "Employee", actorId: `agent:${employeeId}`,
      kind: "agent", profileVersion: 1, createdAt: Date.now(),
    });
    await createRootCollaborationHandoff(collaborationEnv, scope, {
      handoffId, tenantId: scope.tenantId, workspaceId: scope.workspaceId, roomId,
      taskId: "task-fence", senderUserId: scope.userId, senderActorId: humanActorId(scope.userId),
      recipientUserId: scope.userId, recipientActorId: `agent:${employeeId}`, parentHandoffId: null,
      rootHandoffId: handoffId, depth: 0, ancestorHandoffIds: [], remainingBudget: 1,
      grantedCapabilities: ["room.read", "handoff.create"], profileVersion: 1,
      status: "active", createdAt: Date.now(), cancelledAt: null,
    });
    await linkCollaborationHandoffRun(collaborationEnv, scope, handoffId, "approval-fence", "agent-tool:approval-fence");
    const run = createRun({
      runId: "agent-tool:approval-fence", sandboxId: "sandbox-fence", repoUrl: "",
      executionTarget: { kind: "artifact-workspace", expectedDeliverables: ["reports/out.md"] },
      task: "Write a report", baseBranch: "main", publishPullRequest: false,
      customAgentId: employeeId, customAgentVersion: 1, collaborationHandoffId: handoffId,
    });
    instance.setState({ runs: [run] });
    await cancelCollaborationHandoff(collaborationEnv, scope, handoffId, Date.now());
    const dispatch = Reflect.get(instance, "dispatchApprovedRun") as (
      run: DelegatedRun,
      approval: Record<string, unknown>,
      approvalId: string,
    ) => void;
    dispatch.call(instance, run, { approvalId: "approval-fence", status: "approved", threadKey: scope.userId }, "approval-fence");
    await vi.waitFor(() => expect(instance.state.runs[0]?.status).toBe("cancelled"));
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("reports an in-flight linked run as unknown after room cancellation", async () => {
    const instance = agent();
    const run = createRun({
      runId: "agent-tool:in-flight-room", sandboxId: "sandbox-in-flight-room", repoUrl: "https://github.com/o/r",
      task: "Work", baseBranch: "main", publishPullRequest: false,
      customAgentId: "employee", customAgentVersion: 1, collaborationHandoffId: "handoff-in-flight",
    });
    instance.setState({ runs: [{ ...run, checkpoint: "executing" }] });
    Object.assign(instance, { runControllersMap: new Map(), releaseSandboxForRun: vi.fn(async () => {}) });
    const response = await instance.onRequest(new Request("https://internal/internal/collaboration-handoff-cancel", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ handoffId: "handoff-in-flight" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: false, executorCancellationPending: false, outcomeUnknown: true });
    expect(instance.state.runs[0]?.status).toBe("unknown");
    const replay = await instance.onRequest(new Request("https://internal/internal/collaboration-handoff-cancel", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ handoffId: "handoff-in-flight" }),
    }));
    expect(await replay.json()).toEqual({ cancelled: false, executorCancellationPending: false, outcomeUnknown: true });
  });

  it("fences descendants below a terminal intermediary and preserves in-flight uncertainty", async () => {
    const instance = agent();
    const root = createRun({
      runId: "room-root-completed", sandboxId: "room-root-box", repoUrl: "https://github.com/o/r",
      task: "Root", baseBranch: "main", publishPullRequest: false,
      collaborationHandoffId: "handoff-tree-cancel",
    });
    const intermediary = {
      ...createRun({
      runId: "room-intermediary-completed", sandboxId: "room-intermediary-box", repoUrl: "https://github.com/o/r",
      task: "Intermediary", baseBranch: "main", publishPullRequest: false,
      parentRunId: root.runId,
      }),
      status: "completed" as const,
    };
    const descendant = createRun({
      runId: "room-grandchild-active", sandboxId: "room-grandchild-box", repoUrl: "https://github.com/o/r",
      task: "Grandchild", baseBranch: "main", publishPullRequest: false,
      parentRunId: intermediary.runId,
    });
    const inFlight = {
      ...createRun({
        runId: "room-grandchild-in-flight", sandboxId: "room-grandchild-live-box", repoUrl: "https://github.com/o/r",
        task: "In-flight grandchild", baseBranch: "main", publishPullRequest: false,
        parentRunId: intermediary.runId,
      }),
      checkpoint: "executing" as const,
    };
    const release = vi.fn(async () => {});
    instance.setState({ runs: [root, intermediary, descendant, inFlight] });
    Object.assign(instance, { releaseSandboxForRun: release });

    const response = await instance.onRequest(new Request("https://internal/internal/collaboration-handoff-cancel", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ handoffId: "handoff-tree-cancel" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: false, executorCancellationPending: false, outcomeUnknown: true });
    expect(instance.state.runs?.find((run) => run.runId === "room-grandchild-active")?.status).toBe("cancelled");
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ runId: "room-grandchild-active" }));
    expect(instance.state.runs?.find((run) => run.runId === "room-grandchild-in-flight")?.status).toBe("unknown");
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ runId: "room-grandchild-in-flight" }));
    expect(instance.state.runs?.find((run) => run.runId === root.runId)?.status).toBe("cancelled");
    expect(instance.state.runs?.find((run) => run.runId === intermediary.runId)?.status).toBe("completed");
  });

  it("reports executor cleanup failures as pending instead of claiming room cancellation completed", async () => {
    const instance = agent();
    const run = createRun({
      runId: "room-cleanup-pending", sandboxId: "room-cleanup-pending-box", repoUrl: "https://github.com/o/r",
      task: "Room run", baseBranch: "main", publishPullRequest: false,
      collaborationHandoffId: "handoff-cleanup-pending",
    });
    instance.setState({ runs: [run] });
    Object.assign(instance, {
      releaseSandboxForRun: vi.fn(async () => { throw new Error("sandbox still reachable"); }),
    });

    const response = await instance.onRequest(new Request("https://internal/internal/collaboration-handoff-cancel", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ handoffId: "handoff-cleanup-pending" }),
    }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ cancelled: false, executorCancellationPending: true, outcomeUnknown: false });
    expect(instance.state.runs?.[0]?.status).toBe("cancelled");
  });

  it("rejects the linked pending approval when the Worker propagates lineage cancellation", async () => {
    const instance = agent();
    const pendingApprovals = createPendingApproval([], {
      threadKey: "owner@example.test",
      approvalId: "approval-pending-room",
      repoUrl: "https://github.com/o/r",
      task: "Write a report.",
      collaborationHandoffId: "handoff-pending-room",
      createdAt: Date.now(),
    });
    instance.setState({ runs: [], pendingApprovals });
    const response = await instance.onRequest(new Request("https://internal/internal/collaboration-handoff-cancel", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ handoffId: "handoff-pending-room" }),
    }));
    expect(response.status).toBe(200);
    expect(instance.state.pendingApprovals?.[0]).toMatchObject({
      approvalId: "approval-pending-room",
      status: "rejected",
      decidedBy: "collaboration-cancellation",
    });
  });
});

describe("employee tool policy in normal chat turns", () => {
  it("preserves never-managed Code Mode but keeps managed-empty policy deny-all after revoke", async () => {
    const instance = agent();
    const { database } = customAgentD1();
    Object.assign(instance, {
      env: { ...instance.env, AGENT_AUDIT: database },
      name: "owner@example.test",
    });
    const employee = await createCustomAgent(instance.env, "owner@example.test", "run-status-employee", {
      name: "Run status employee", instructions: "Read only the approved run status.", harness: "opencode",
    });
    Object.assign(instance, { messages: [{
      role: "user",
      metadata: { shibaTask: { customAgentId: employee.id, orgId: "owner@example.test" } },
    }] });
    const tools = { run_code: {}, employee_tool_catalog: {}, employee_tool_call: {}, delegate_coding_task: {} };
    const turn = () => instance.beforeTurn({ tools, system: "base system" } as never);

    const legacy = await turn();
    expect(legacy.activeTools).toContain("run_code");
    expect(legacy.activeTools).not.toContain("employee_tool_catalog");

    const configured = await updateCustomAgent(instance.env, "owner@example.test", employee.id, {
      ...employee.config, toolScopes: ["mcp:shiba:run_status"],
    }, employee.version);
    await replaceEmployeeToolGrants(instance.env, {
      orgId: "owner@example.test", employeeId: employee.id, employeeVersion: configured.version,
      actorId: "owner@example.test", role: "operator", capabilityIds: ["mcp:shiba:run_status"],
      resourcesByCapability: { "mcp:shiba:run_status": ["run-1"] },
    });
    const configuredTurn = await turn();
    expect(configuredTurn.activeTools).not.toContain("run_code");
    expect(configuredTurn.activeTools).toContain("employee_tool_catalog");
    expect(configuredTurn.activeTools).toContain("employee_tool_call");

    const cleared = await updateCustomAgent(instance.env, "owner@example.test", employee.id, {
      ...configured.config, toolScopes: [],
    }, configured.version);
    await replaceEmployeeToolGrants(instance.env, {
      orgId: "owner@example.test", employeeId: employee.id, employeeVersion: cleared.version,
      actorId: "owner@example.test", role: "operator", capabilityIds: [], resourcesByCapability: {},
    });
    const revokedTurn = await turn();
    expect(revokedTurn.activeTools).not.toContain("run_code");
    expect(revokedTurn.activeTools).not.toContain("employee_tool_catalog");
    expect(revokedTurn.activeTools).not.toContain("employee_tool_call");
  });
});

describe("durable artifact review state", () => {
  it("stores reviewer decisions in the owning run record and returns version history without bodies", async () => {
    const instance = agent();
    const first: DelegatedRun = { ...retained("completed"), runId: "r1", createdAt: 100, deliverables: [{
      path: "reports/brief.md", mediaType: "text/markdown", bytes: 4, sha256: "a".repeat(64),
      version: 1, sourceRunId: "r1",
      review: { status: "pending_review" as const, updatedAt: 100 },
    }] };
    first.deliverables = await prepareRunArtifacts(first, first.deliverables ?? [], "task-root", 100);
    const latest: DelegatedRun = { ...first, runId: "r2", createdAt: 200, deliverables: [{ ...first.deliverables![0]!, version: 2, sourceRunId: "r2" }] };
    const attempts = [first, latest].map((run, index) => ({
      attempt: index + 1,
      commandId: `task-root:${index + 1}`,
      approvalId: `approval-${index + 1}`,
      runId: run.runId,
      status: "completed" as const,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      frozen: { body: { repoUrl: run.repoUrl, task: run.task }, inputHash: `hash-${index + 1}`, threadKey: "default" },
    }));
    instance.setState({ ...instance.state, runs: [first, latest], tasks: [{
      taskId: "task-root", artifactLineageId: "task-root", ownerId: "default", title: "brief",
      createdAt: 100, updatedAt: 200, attempts,
    }] });
    const update = await instance.onRequest(new Request("https://internal/api/runs/r2/deliverables/0/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "changes_requested", note: "Add citations", expectedRevision: 0 }),
    }));
    expect(update.status).toBe(200);
    expect(instance.state.runs?.find((item) => item.runId === "r2")?.deliverables?.[0]?.review)
      .toEqual({ status: "changes_requested", revision: 1, updatedAt: expect.any(Number), note: "Add citations" });
    const staleDecision = await instance.onRequest(new Request("https://internal/api/runs/r2/deliverables/0/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved", expectedRevision: 0 }),
    }));
    expect(staleDecision.status).toBe(409);
    expect(await staleDecision.json()).toMatchObject({
      currentReview: { status: "changes_requested", note: "Add citations", revision: 1 },
    });
    const history = await instance.onRequest(new Request("https://internal/api/runs/r2/deliverables/0/history"));
    const payload = await history.json() as { artifactId: string; versions: Array<Record<string, unknown>> };
    expect(payload.artifactId).toBe(first.deliverables?.[0]?.artifactId);
    expect(payload.versions.map((version) => version.version)).toEqual([1, 2]);
    expect(payload.versions[1]?.review).toMatchObject({ status: "changes_requested", note: "Add citations" });
    expect(JSON.stringify(payload)).not.toContain("content");
  });

  it("rejects a revision request without a note and refuses review updates to active runs", async () => {
    const instance = agent();
    const active = { ...retained("running"), deliverables: [{ path: "reports/brief.md", mediaType: "text/markdown", bytes: 4, sha256: "a".repeat(64) }] };
    instance.setState({ ...instance.state, runs: [active] });
    const request = (body: unknown) => instance.onRequest(new Request("https://internal/api/runs/r1/deliverables/0/review", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    expect((await request({ status: "changes_requested", expectedRevision: 0 })).status).toBe(400);
    expect((await request({ status: "approved", expectedRevision: 0 })).status).toBe(404);
  });

  it("creates an explicit fresh revision approval with artifact lineage and never dispatches it", async () => {
    const instance = agent();
    const source: DelegatedRun = {
      ...retained("completed"),
      runId: "artifact-source-run",
      repoUrl: "",
      task: "Create a report",
      expectedDeliverables: ["reports/brief.md"],
      deliverables: [{
        path: "reports/brief.md", mediaType: "text/markdown", bytes: 4, sha256: "a".repeat(64),
        version: 3, sourceRunId: "artifact-source-run",
        review: { status: "changes_requested" as const, revision: 4, updatedAt: 20, note: "Add citations" },
      }],
    };
    const approvalBody = {
      threadKey: "default", approvalId: "original-approval", repoUrl: "", task: "Create a report",
      baseBranch: "main", publishPullRequest: false, expectedDeliverables: ["reports/brief.md"],
      status: "approved" as const, createdAt: 10,
    };
    const sourceTask = updateTaskAttempt(createDurableTask({
      taskId: "task-source", ownerId: "default", title: "Create a report", commandId: "source-command",
      approvalId: "original-approval", frozen: { body: approvalBody, inputHash: "source-hash", threadKey: "default" }, now: 10,
    }), 1, { runId: source.runId, status: "completed", updatedAt: 20 });
    sourceTask.artifactLineageId = sourceTask.taskId;
    const sourceArtifact = source.deliverables?.[0];
    if (!sourceArtifact) throw new Error("Expected source artifact.");
    sourceArtifact.artifactId = await artifactIdentity(source, sourceArtifact.path, "task-source");
    instance.setState({ ...instance.state, runs: [source], tasks: [sourceTask] });

    const request = () => instance.onRequest(new Request(`https://internal/api/runs/${source.runId}/deliverables/0/revision`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        commandId: "artifact-revision:source-1234",
        artifactId: sourceArtifact.artifactId,
        artifactVersion: 3,
        reviewRevision: 4,
      }),
    }));
    const staleBinding = await instance.onRequest(new Request(`https://internal/api/runs/${source.runId}/deliverables/0/revision`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        commandId: "artifact-revision:stale-12345",
        artifactId: sourceArtifact.artifactId,
        artifactVersion: 3,
        reviewRevision: 3,
      }),
    }));
    expect(staleBinding.status).toBe(409);
    expect(await staleBinding.json()).toMatchObject({ currentReview: { revision: 4, note: "Add citations" } });
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
    const created = await request();
    expect(created.status).toBe(200);
    const payload = await created.json() as { approvalId: string; started: boolean; task: { taskId: string; revisionOf: Record<string, unknown> } };
    expect(payload.started).toBe(false);
    expect(payload.approvalId).not.toBe("original-approval");
    expect(payload.task.revisionOf).toMatchObject({
      taskId: "task-source", runId: source.runId, artifactId: source.deliverables?.[0]?.artifactId,
      artifactVersion: 3, reviewRevision: 4, path: "reports/brief.md",
    });
    expect(instance.state.pendingApprovals?.at(-1)).toMatchObject({
      approvalId: payload.approvalId, task: expect.stringContaining("Add citations"), status: "pending",
    });
    expect(instance.state.tasks?.at(-1)).toMatchObject({ artifactLineageId: "task-source", revisionOf: payload.task.revisionOf });
    const replay = await request().then((response) => response.json()) as { approvalId: string; deduped?: boolean };
    expect(replay).toMatchObject({ approvalId: payload.approvalId, deduped: true });
    const reloadRetry = await instance.onRequest(new Request(`https://internal/api/runs/${source.runId}/deliverables/0/revision`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        commandId: "artifact-revision:after-reload",
        artifactId: sourceArtifact.artifactId,
        artifactVersion: 3,
        reviewRevision: 4,
      }),
    })).then((response) => response.json()) as { approvalId: string; deduped?: boolean };
    expect(reloadRetry).toMatchObject({ approvalId: payload.approvalId, deduped: true });
    expect(instance.state.pendingApprovals).toHaveLength(1);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("requires a new room handoff instead of carrying an old handoff into a revision approval", async () => {
    const instance = agent();
    const source: DelegatedRun = {
      ...retained("completed"), runId: "room-artifact-source", repoUrl: "",
      task: "Create a room report", collaborationHandoffId: "room-source-handoff",
      expectedDeliverables: ["reports/room.md"],
      deliverables: [{
        path: "reports/room.md", mediaType: "text/markdown", bytes: 4, sha256: "b".repeat(64),
        version: 1, sourceRunId: "room-artifact-source",
        review: { status: "changes_requested" as const, revision: 1, updatedAt: 20, note: "Add one detail" },
      }],
    };
    const approvalBody = {
      threadKey: "default", approvalId: "room-source-approval", repoUrl: "", task: "Create a room report",
      baseBranch: "main", publishPullRequest: false, expectedDeliverables: ["reports/room.md"],
      collaborationHandoffId: "room-source-handoff", status: "approved" as const, createdAt: 10,
    };
    const sourceTask = updateTaskAttempt(createDurableTask({
      taskId: "task-room-source", ownerId: "default", title: "Create a room report", commandId: "room-source-command",
      approvalId: "room-source-approval", frozen: { body: approvalBody, inputHash: "room-source-hash", threadKey: "default" }, now: 10,
    }), 1, { runId: source.runId, status: "completed", updatedAt: 20 });
    sourceTask.artifactLineageId = sourceTask.taskId;
    const artifact = source.deliverables?.[0];
    if (!artifact) throw new Error("Expected the room artifact.");
    artifact.artifactId = await artifactIdentity(source, artifact.path, sourceTask.taskId);
    instance.setState({ ...instance.state, runs: [source], tasks: [sourceTask] });

    const response = await instance.onRequest(new Request(`https://internal/api/runs/${source.runId}/deliverables/0/revision`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        commandId: "artifact-revision:room-source-1", artifactId: artifact.artifactId,
        artifactVersion: 1, reviewRevision: 1,
      }),
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("new room handoff") });
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
  });
});

describe("orchestrator run routes", () => {
  it("still reclaims stale containers when draining the outbox fails", async () => {
    const instance = agent();
    instance.setState({ runs: [retained()] });
    Object.assign(instance, { drainEffectOutboxOnce: vi.fn().mockRejectedValue(new Error("outbox unavailable")) });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(instance.reclaimRuns()).resolves.toBeUndefined();
      expect(instance.state.runs[0]?.status).toBe("unknown");
      expect(mocks.destroy).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("records a pre-start failure on an approved run without starting a sandbox", async () => {
    const instance = agent();
    instance.env.GITHUB_TOKEN = "";
    const input = { repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: true };
    approveDirect(instance, "pre-start", input);
    const delegate = instance.getTools()["delegate_coding_task"] as {
      execute: (input: unknown, options?: unknown) => Promise<unknown>;
    };
    await expect(delegate.execute(input, { toolCallId: "pre-start" })).rejects.toMatchObject({
      code: "internal_error",
    });
    expect(instance.state.runs[0]).toMatchObject({ status: "error", errorCode: "internal_error" });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.destroy).not.toHaveBeenCalled();
  });

  it("aborts in-flight triage HTTP work when the parent run finishes", async () => {
    const instance = agent();
    const held: Promise<unknown>[] = [];
    Object.assign(instance, { ctx: { waitUntil: (promise: Promise<unknown>) => held.push(promise) } });
    Object.assign(instance.env, { TYPESAFE_API_KEY: "test-key" });
    approveDirect(instance, "triage-lifetime");
    let triageStarted!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => { triageStarted = resolve; });
    let finishRun!: (output: string) => void;
    mocks.execute.mockReturnValue(new Promise<string>((resolve) => { finishRun = resolve; }));
    mocks.triage.mockImplementation((_key, _task, _repo, fetchImpl: typeof fetch) => fetchImpl("https://api.typesafe.ai/test"));
    vi.stubGlobal("fetch", vi.fn((_url: unknown, init: RequestInit) => {
      const signal = init.signal!;
      triageStarted(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const delegate = instance.getTools()["delegate_coding_task"] as {
      execute: (input: unknown, options?: unknown) => Promise<unknown>;
    };
    try {
      const execution = delegate.execute(
        { repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false },
        { toolCallId: "triage-lifetime" },
      );
      const signal = await started;
      finishRun(formatAgentResult({
        status: "completed", summary: "Done", exitCode: 0, stderrTail: "", changedFiles: [], diff: "", files: [],
      }));
      await execution;
      await Promise.all(held);
      expect(signal.aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      log.mockRestore();
    }
  });

  it("registers independent quality grading with the host lifetime without blocking completion", async () => {
    const instance = agent();
    const held: Promise<unknown>[] = [];
    Object.assign(instance, { ctx: { waitUntil: (promise: Promise<unknown>) => held.push(promise) } });
    Object.assign(instance.env, { TYPESAFE_API_KEY: "test-key" });
    approveDirect(instance, "quality-lifetime");
    let finishQuality!: (value: null) => void;
    mocks.quality.mockReturnValue(new Promise<null>((resolve) => { finishQuality = resolve; }));
    mocks.execute.mockResolvedValue(formatAgentResult({
      status: "completed", summary: "Done", exitCode: 0, stderrTail: "", changedFiles: [], diff: "", files: [],
    }));
    const delegate = instance.getTools()["delegate_coding_task"] as {
      execute: (input: unknown, options?: unknown) => Promise<unknown>;
    };
    try {
      await delegate.execute(
        { repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false },
        { toolCallId: "quality-lifetime" },
      );
      await vi.waitFor(() => expect(mocks.quality).toHaveBeenCalledOnce());
      expect(instance.state.runs[0]?.status).toBe("completed");
      // Result distillation already uses waitUntil; grading needs its own hold
      // that stays open until grading settles.
      const settled = held.map(() => false);
      held.forEach((promise, index) => void promise.then(() => { settled[index] = true; }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toContain(false);
    } finally {
      finishQuality(null);
      await Promise.all(held);
    }
  });

  it("bounds cleanup concurrency when clearing a batch of active runs", async () => {
    const instance = agent();
    instance.setState({ runs: Array.from({ length: 8 }, (_, index) => ({
      ...retained(), runId: `run-${index}`, sandboxId: `sandbox-${index}`, updatedAt: Date.now(),
    })) });
    let active = 0;
    let peak = 0;
    mocks.destroy.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
    });
    await instance.clearRuns();
    expect(mocks.destroy).toHaveBeenCalledTimes(8);
    expect(peak).toBeLessThanOrEqual(4);
    expect(instance.state.runs).toEqual([]);
  });

  describe("pre-start failure fence", () => {
    const input = { repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: true };
    const spies = (instance: CodingOrchestrator) => {
      const host = instance as unknown as { postToThread: (text: string) => void; dispatchSessionDistill: (run: DelegatedRun) => void };
      return {
        post: vi.spyOn(host, "postToThread").mockImplementation(() => {}),
        distill: vi.spyOn(host, "dispatchSessionDistill").mockImplementation(() => {}),
      };
    };
    const delegateOf = (instance: CodingOrchestrator) => instance.getTools()["delegate_coding_task"] as {
      execute: (input: unknown, options?: unknown) => Promise<unknown>;
    };

    it("records an abort before start as cancelled without distilling", async () => {
      const instance = agent();
      const { post, distill } = spies(instance);
      approveDirect(instance, "abort-start", input);
      const controller = new AbortController();
      mocks.schedule.mockImplementation(async () => { controller.abort(); return {}; });
      await expect(delegateOf(instance).execute(input, { toolCallId: "abort-start", abortSignal: controller.signal })).rejects.toBeDefined();
      expect(instance.state.runs[0]?.status).toBe("cancelled");
      expect(mocks.execute).not.toHaveBeenCalled();
      expect(distill).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledTimes(2); // started + failed notice
    });

    it("drops the failure side effects when another writer already won the fence", async () => {
      const instance = agent();
      instance.env.GITHUB_TOKEN = "";
      const { post, distill } = spies(instance);
      approveDirect(instance, "fence-lost", input);
      vi.spyOn(RunStore.prototype, "transition").mockReturnValue(null);
      await expect(delegateOf(instance).execute(input, { toolCallId: "fence-lost" })).rejects.toBeDefined();
      expect(post).not.toHaveBeenCalled();
      expect(distill).not.toHaveBeenCalled();
    });

    it("leaves the store untouched when the failure precedes the run reservation", async () => {
      const instance = agent();
      const { post, distill } = spies(instance);
      approveDirect(instance, "pre-reserve", input);
      const before = JSON.stringify(instance.state.runs);
      const controller = new AbortController();
      Object.assign(instance, { reclaimRuns: async () => { controller.abort(); } });
      const transition = vi.spyOn(RunStore.prototype, "transition");
      await expect(delegateOf(instance).execute(input, { toolCallId: "pre-reserve", abortSignal: controller.signal })).rejects.toBeDefined();
      expect(transition).not.toHaveBeenCalled();
      expect(JSON.stringify(instance.state.runs)).toBe(before);
      expect(post).not.toHaveBeenCalled();
      expect(distill).not.toHaveBeenCalled();
    });
  });

  it("aborts never-resolving triage and quality grading after 15s while the run completes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const instance = agent();
    const held: Promise<unknown>[] = [];
    Object.assign(instance, { ctx: { waitUntil: (promise: Promise<unknown>) => held.push(promise) } });
    Object.assign(instance.env, { TYPESAFE_API_KEY: "test-key" });
    approveDirect(instance, "advisory-timeout");
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: unknown, init: RequestInit) => {
      signals.push(init.signal!);
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }));
    const hang = (...args: unknown[]) => (args.find((arg) => typeof arg === "function") as typeof fetch)("https://api.typesafe.ai/test");
    mocks.triage.mockImplementation(hang);
    mocks.quality.mockImplementation(hang);
    mocks.execute.mockResolvedValue(formatAgentResult({
      status: "completed", summary: "Done", exitCode: 0, stderrTail: "", changedFiles: [], diff: "", files: [],
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const delegate = instance.getTools()["delegate_coding_task"] as {
      execute: (input: unknown, options?: unknown) => Promise<unknown>;
    };
    try {
      await delegate.execute(
        { repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false },
        { toolCallId: "advisory-timeout" },
      );
      await vi.waitFor(() => expect(mocks.quality).toHaveBeenCalledOnce());
      expect(instance.state.runs[0]?.status).toBe("completed");
      await vi.advanceTimersByTimeAsync(15_000);
      await Promise.all(held);
      expect(signals.length).toBeGreaterThan(0);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(instance.state.runs[0]?.status).toBe("completed");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      log.mockRestore();
    }
  });

  describe("cleanup loops", () => {
    const stale = (count: number) => Array.from({ length: count }, (_, index) => ({
      ...retained(), runId: `run-${index}`, sandboxId: `sandbox-${index}`,
    }));

    it("aborts controllers and posts outcome-unknown for every reclaimed run before any destroy", async () => {
      const instance = agent();
      instance.setState({ runs: stale(2) });
      const events: string[] = [];
      const host = instance as unknown as {
        runControllers: Map<string, AbortController>;
        postOutcomeUnknown: (run: DelegatedRun) => void;
      };
      for (const run of stale(2)) {
        const controller = new AbortController();
        controller.signal.addEventListener("abort", () => events.push(`abort:${run.runId}`));
        host.runControllers.set(run.runId, controller);
      }
      vi.spyOn(host, "postOutcomeUnknown").mockImplementation((run) => { events.push(`post:${run.runId}`); });
      mocks.destroy.mockImplementation(async () => { events.push("destroy"); });
      await instance.reclaimRuns();
      const firstDestroy = events.indexOf("destroy");
      expect(firstDestroy).toBe(4);
      expect(events.filter((event) => event === "destroy")).toHaveLength(2);
    });

    it("keeps destroying the rest when one destroy throws", async () => {
      const instance = agent();
      instance.setState({ runs: stale(3) });
      const destroySandbox = vi.fn()
        .mockRejectedValueOnce(new Error("boom Bearer secret-token"))
        .mockResolvedValue(undefined);
      Object.assign(instance, { destroySandbox });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await instance.reclaimRuns();
        expect(destroySandbox).toHaveBeenCalledTimes(3);
        expect(JSON.stringify(log.mock.calls)).not.toContain("secret-token");
      } finally {
        log.mockRestore();
      }
    });

    it("bounds a hung destroy so the remaining sandboxes are still destroyed", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const instance = agent();
      instance.setState({ runs: stale(2) });
      const destroySandbox = vi.fn()
        .mockImplementationOnce(() => new Promise<void>(() => {}))
        .mockResolvedValue(undefined);
      Object.assign(instance, { destroySandbox });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const sweep = instance.reclaimRuns();
        await vi.advanceTimersByTimeAsync(30_000);
        await sweep;
        expect(destroySandbox).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
        log.mockRestore();
      }
    });

    it("keeps cancelling the remaining runs when clearing and one cancel throws", async () => {
      const instance = agent();
      instance.setState({ runs: stale(3).map((run) => ({ ...run, updatedAt: Date.now() })) });
      const destroySandbox = vi.fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue(undefined);
      Object.assign(instance, { destroySandbox });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await instance.clearRuns();
        expect(destroySandbox).toHaveBeenCalledTimes(3);
        expect(instance.state.runs).toEqual([]);
      } finally {
        log.mockRestore();
      }
    });
  });

  it.each(["triage", "quality"] as const)("logs %s failures without failing the run or exposing secrets", async (stage) => {
    const instance = agent();
    Object.assign(instance.env, { TYPESAFE_API_KEY: "test-key" });
    approveDirect(instance, `advisory-${stage}`);
    mocks.execute.mockResolvedValue(formatAgentResult({
      status: "completed", summary: "Done", exitCode: 0, stderrTail: "", changedFiles: [], diff: "", files: [],
    }));
    mocks[stage].mockRejectedValue(new Error("provider failed Bearer secret-token"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const delegate = instance.getTools()["delegate_coding_task"] as {
        execute: (input: unknown, options?: unknown) => Promise<unknown>;
      };
      await delegate.execute(
        { repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false },
        { toolCallId: `advisory-${stage}` },
      );
      await vi.waitFor(() => expect(log).toHaveBeenCalled());
      const output = JSON.stringify(log.mock.calls);
      expect(output).toContain(stage);
      expect(output).not.toContain("secret-token");
      expect(instance.state.runs[0]?.status).toBe("completed");
    } finally {
      log.mockRestore();
    }
  });

  it("reclaims stale runs on GET and destroys their sandbox", async () => {
    const instance = agent();
    instance.setState({ runs: [retained()] });
    const response = await instance.onRequest(new Request("https://internal/api/runs"));
    const body = (await response.json()) as { runs: { status: string; errorCode?: string }[] };
    expect(body.runs[0]?.status).toBe("unknown");
    expect(body.runs[0]?.errorCode).toBe("outcome_unknown");
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("does not destroy completed runs when cancelling", async () => {
    const instance = agent();
    instance.setState({ runs: [retained("completed")] });
    const response = await instance.onRequest(new Request("https://internal/api/runs/r1", { method: "DELETE" }));
    expect(response.status).toBe(200);
    expect(mocks.destroy).not.toHaveBeenCalled();
  });

  it("cancels active sandboxes before clearing history", async () => {
    const instance = agent();
    instance.setState({ runs: [{ ...retained(), updatedAt: Date.now() }] });
    const response = await instance.onRequest(new Request("https://internal/api/runs", { method: "DELETE" }));
    expect(response.status).toBe(200);
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(instance.state.runs).toEqual([]);
  });

  it("rejects malformed run IDs without throwing", async () => {
    expect((await agent().onRequest(new Request("https://internal/api/runs/%ZZ"))).status).toBe(400);
  });

  it("returns 404 for missing runs and refuses ungated POST requests", async () => {
    expect((await agent().onRequest(new Request("https://internal/api/runs/missing"))).status).toBe(404);
    expect((await agent().onRequest(new Request("https://internal/api/runs/r1", { method: "POST" }))).status).toBe(405);
    // POST /api/runs is the queue route now; an empty body fails validation.
    expect((await agent().onRequest(new Request("https://internal/api/runs", { method: "POST" }))).status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("posts run cancellation back to the originating Slack thread", async () => {
    const instance = agent();
    Object.assign(instance, {
      name: "slack:T1:C9:1700.0001",
      ctx: { waitUntil: vi.fn((p: Promise<unknown>) => p) },
    });
    Object.assign(instance.env, { SLACK_BOT_TOKEN: "xoxb-test" });
    instance.setState({ runs: [{ ...retained(), updatedAt: Date.now() }] });
    const fetchMock = vi.fn(async (_url: unknown, _init?: { body?: unknown }) =>
      new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await instance.onRequest(
        new Request("https://internal/api/runs/r1", { method: "DELETE" }),
      );
      expect(response.status).toBe(200);
      const postCalls = fetchMock.mock.calls.filter((call) =>
        String(call[0]).includes("chat.postMessage"));
      expect(postCalls).toHaveLength(1);
      const body = JSON.parse(String(postCalls[0]![1]?.body)) as Record<string, string>;
      expect(body.channel).toBe("C9");
      expect(body.thread_ts).toBe("1700.0001");
      expect(body.text).toContain("cancelled");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("skips post-back for non-Slack orchestrators", async () => {
    const instance = agent();
    Object.assign(instance, {
      name: "default",
      ctx: { waitUntil: vi.fn((p: Promise<unknown>) => p) },
    });
    Object.assign(instance.env, { SLACK_BOT_TOKEN: "xoxb-test" });
    instance.setState({ runs: [{ ...retained(), updatedAt: Date.now() }] });
    const fetchMock = vi.fn(async (_url: unknown) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await instance.onRequest(new Request("https://internal/api/runs/r1", { method: "DELETE" }));
      expect(
        fetchMock.mock.calls.filter((call) => String(call[0]).includes("chat.postMessage")),
      ).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("propagates cancellation to the running child execution", async () => {
    const instance = agent();
    mocks.execute.mockImplementation(async (_input, options: { abortSignal?: AbortSignal }) => {
      // The child hangs like a real container run until its signal aborts —
      // T42: no timer fallback; only the abort resolves this promise.
      await new Promise((_resolve, reject) => {
        options?.abortSignal?.addEventListener("abort", () => {
          reject(new Error("Run cancelled."));
        });
      });
      return "unreachable";
    });
    approveDirect(instance, "tc1");
    const delegate = instance.getTools()["delegate_coding_task"] as {
      execute: (input: unknown, options?: unknown) => Promise<string>;
    };
    const execution = delegate.execute(
      { repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false },
      { toolCallId: "tc1" },
    );
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    await instance.cancelRun("agent-tool:tc1");
    await expect(execution).rejects.toThrow("Run cancelled");
    expect((instance.state.runs as DelegatedRun[])[0]?.status).toBe("cancelled");
  });

  it("cancels the whole subagent tree through completed intermediates and releases shared sandboxes once", async () => {
    const instance = agent();
    const makeRun = (runId: string, extra: Partial<DelegatedRun> = {}): DelegatedRun => ({
      ...retained(), runId, sandboxId: "shared-tree", updatedAt: Date.now(), ...extra,
    });
    const controllers = new Map(["root", "child", "grandchild", "reviewer"].map((id) => [id, new AbortController()]));
    Object.assign(instance, { runControllersMap: controllers });
    instance.setState({ runs: [
      makeRun("root"),
      makeRun("child", { parentRunId: "root", subagentPath: "1" }),
      makeRun("completed-child", { parentRunId: "child", status: "completed", subagentPath: "1.1" }),
      makeRun("grandchild", { parentRunId: "completed-child", subagentPath: "1.1.1" }),
      makeRun("reviewer", { reviewOf: "grandchild", sandboxId: "review-sandbox" }),
      makeRun("unrelated", { sandboxId: "unrelated-sandbox" }),
    ] });

    await instance.cancelRun("root");

    const runs = new Map(instance.state.runs.map((run) => [run.runId, run]));
    for (const id of ["root", "child", "grandchild", "reviewer"]) {
      expect(runs.get(id)?.status).toBe("cancelled");
      expect(controllers.get(id)?.signal.aborted).toBe(true);
    }
    expect(runs.get("completed-child")?.status).toBe("completed");
    expect(runs.get("unrelated")?.status).toBe("running");
    expect(mocks.destroy).toHaveBeenCalledTimes(2);
  });

  it("fences and aborts every descendant before waiting for provider cleanup", async () => {
    const instance = agent();
    const controllers = new Map(["root", "child", "grandchild"].map((id) => [id, new AbortController()]));
    Object.assign(instance, { runControllersMap: controllers });
    instance.setState({ runs: [
      { ...retained(), runId: "root", sandboxId: "root-sandbox" },
      { ...retained(), runId: "child", parentRunId: "root", sandboxId: "child-sandbox" },
      { ...retained(), runId: "grandchild", parentRunId: "child", sandboxId: "grandchild-sandbox" },
    ] });
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    mocks.destroy.mockReturnValue(cleanup);
    const cancellation = instance.cancelRun("root");
    try {
      for (const run of instance.state.runs) {
        expect(run.status).toBe("cancelled");
        expect(controllers.get(run.runId)?.signal.aborted).toBe(true);
      }
    } finally {
      finishCleanup();
      await cancellation;
    }
  });

  it("refuses subagent spawn after session teardown", async () => {
    const instance = agent();
    instance.setState({ runs: [retained()], sessionDeletedAt: Date.now() });
    const response = await instance.onRequest(new Request("https://internal/api/runs/subagents/spawn", {
      method: "POST", body: JSON.stringify({ parentRunId: "r1", task: "inspect", sandboxMode: "fresh" }),
    }));
    expect(response.status).toBe(410);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each(["/api/runs/subagents/spawn", "/api/runs/r1/subagents"])("hides another principal's subagent parent at %s", async (path) => {
    const instance = agent();
    instance.setState({ runs: [{ ...retained(), queuedBy: "owner", subagentBudgetRemaining: 2,
      approval: { approvalId: "parent-plan", decidedBy: "human", decidedAt: Date.now(), inputHash: "parent-input" } }] });
    const response = await instance.onRequest(new Request(`https://internal${path}`, {
      method: "POST", headers: { "X-Agent-Principal": "intruder" },
      body: JSON.stringify({ parentRunId: "r1", task: "inspect", sandboxMode: "fresh" }),
    }));
    expect(response.status).toBe(404);
    expect(instance.state.runs).toHaveLength(1);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "completed", "error", "unknown", "aborted"] as const)("refuses subagent spawn from a %s parent", async (status) => {
    const instance = agent();
    instance.setState({ runs: [{ ...retained(), status, subagentBudgetRemaining: 2,
      approval: { approvalId: "parent-plan", decidedBy: "human", decidedAt: Date.now(), inputHash: "parent-input" } }] });
    const response = await instance.onRequest(new Request("https://internal/api/runs/r1/subagents", {
      method: "POST", body: JSON.stringify({ task: "inspect", sandboxMode: "fresh" }),
    }));
    expect(response.status).toBe(409);
    expect(instance.state.runs[0]?.subagentBudgetRemaining).toBe(2);
    expect(instance.state.runs).toHaveLength(1);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("returns a validation error for a malformed subagent parent id", async () => {
    const response = await agent().onRequest(new Request("https://internal/api/runs/%E0%A4%A/subagents", {
      method: "POST", body: JSON.stringify({ task: "inspect", sandboxMode: "fresh" }),
    }));
    expect(response.status).toBe(400);
  });

  it("preserves the owning principal when spending an approved subagent budget", async () => {
    const instance = agent();
    const dispatch = vi.fn();
    Object.assign(instance, { dispatchApprovedRun: dispatch });
    instance.setState({ runs: [{ ...retained(), queuedBy: "owner", subagentBudgetRemaining: 2,
      approval: { approvalId: "parent-plan", decidedBy: "human", decidedAt: Date.now(), inputHash: "parent-input" } }] });
    const response = await instance.onRequest(new Request("https://internal/api/runs/r1/subagents", {
      method: "POST", headers: { "X-Agent-Principal": "owner" },
      body: JSON.stringify({ task: "inspect", sandboxMode: "fresh", queuedBy: "forged" }),
    }));
    expect(response.status).toBe(200);
    expect(instance.state.runs).toHaveLength(2);
    expect(instance.state.runs[0]?.subagentBudgetRemaining).toBe(1);
    expect(instance.state.runs[1]).toMatchObject({ queuedBy: "owner", parentRunId: "r1", subagentPath: "1",
      approval: { approvalId: "parent-plan", decidedBy: "human" } });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("reclaims a stale run and aborts its child execution", async () => {
    const instance = agent();
    const signals: (AbortSignal | undefined)[] = [];
    mocks.execute.mockImplementation(async (_input, options: { abortSignal?: AbortSignal }) => {
      signals.push(options?.abortSignal);
      await new Promise(() => {}); // never resolves; only cancellation ends it
      return "unreachable";
    });
    approveDirect(instance, "tc2");
    const delegate = instance.getTools()["delegate_coding_task"] as {
      execute: (input: unknown, options?: unknown) => Promise<unknown>;
    };
    const execution = delegate.execute(
      { repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false },
      { toolCallId: "tc2" },
    );
    execution.catch(() => {});
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    // Age the run past its deadline, then touch a route — reclaim on
    // access is floored per DO lifetime, and starting this run already
    // swept once, so let the interval lapse before the read.
    const stale = { ...(instance.state.runs as DelegatedRun[])[0]!, updatedAt: Date.now() - RUN_DEADLINE_MS - 1 };
    instance.setState({ ...instance.state, runs: [stale] });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 60_000);
      await instance.onRequest(new Request("https://internal/api/runs"));
      expect(signals[0]?.aborted).toBe(true);
      expect((instance.state.runs as DelegatedRun[])[0]?.status).toBe("unknown");
      expect(mocks.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a leaked container's destroy during reclaim", async () => {
    const instance = agent();
    const selection = { orgId: "org-leaked", taskProviderId: "computesdk" };
    // Seed the leak registry: a failed destroy records the sandbox for retry.
    mocks.destroy.mockRejectedValueOnce(new Error("destroy failed"));
    await destroyManagedContainer(instance.env, "leaked-sbx", undefined, selection);
    expect(leakedContainers().map((leak) => leak.sandboxId)).toEqual(["leaked-sbx"]);
    expect(leakedContainers()[0]?.selection).toEqual(selection);
    const response = await instance.onRequest(new Request("https://internal/api/runs"));
    expect(response.status).toBe(200);
    // The reclaim pass re-destroyed the leaked sandbox and cleared its entry.
    expect(mocks.destroy).toHaveBeenCalledTimes(2);
    expect(leakedContainers()).toHaveLength(0);
  });

  it("mirrors a failed reclaim-destroy into this DO's state only", async () => {
    const instance = agent();
    const selection = { orgId: "org-leaked", taskProviderId: "computesdk" };
    mocks.destroy.mockRejectedValueOnce(new Error("destroy failed"));
    await destroyManagedContainer(instance.env, "leaked-sbx", undefined, selection);
    // The reclaim retry fails again — the leak hooks passed with that call
    // persist it into this DO's state (not a module-global sink that could
    // write into a sibling DO's state in the same isolate).
    mocks.destroy.mockRejectedValueOnce(new Error("still down"));
    await instance.reclaimRuns();
    expect(instance.state.leakedContainers?.["leaked-sbx"]).toMatchObject({ selection });
  });

  it("does not destroy a legacy leaked sandbox without provider context", async () => {
    const instance = agent();
    instance.setState({
      runs: [],
      leakedContainers: {
        "legacy-leak": { sandboxId: "legacy-leak", leakedAt: Date.now(), error: "old record" },
      },
    });

    await instance.reclaimRuns();

    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(instance.state.leakedContainers?.["legacy-leak"]).toBeDefined();
  });

  it("approve at the concurrency cap stays pending and returns 409, no execution", async () => {
    const instance = agent();
    // Five active runs: one slot past MAX_CONCURRENT_RUNS.
    instance.setState({ runs: Array.from({ length: 5 }, (_, i) =>
      ({ ...createRun({ runId: `r${i}`, sandboxId: `s${i}`, repoUrl: "https://github.com/o/r", task: "t", baseBranch: "main", publishPullRequest: false }), status: "running" as const, updatedAt: Date.now() }),
    ) as DelegatedRun[] });
    const queued = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "cap check" }),
    }));
    const { approvalId } = await queued.json() as { approvalId: string };
    mocks.execute.mockResolvedValue("ok");
    const response = await instance.onRequest(new Request("https://internal/api/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadKey: "default", approvalId, approved: true, decidedBy: "U1" }),
    }));
    expect(response.status).toBe(409);
    // Pointer survives: a later approve after a slot frees can still start it.
    const approvals = (instance.state.pendingApprovals ?? []) as { approvalId: string; status: string }[];
    expect(approvals.find((a) => a.approvalId === approvalId)?.status).toBe("pending");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects non-object JSON bodies on queue and approval routes", async () => {
    const instance = agent();
    for (const body of ["null", "[]", '"str"', "5"]) {
      const queueRes = await instance.onRequest(new Request("https://internal/api/runs", {
        method: "POST", headers: { "Content-Type": "application/json" }, body,
      }));
      expect(queueRes.status).toBe(400);
      const approvalRes = await instance.onRequest(new Request("https://internal/api/approvals", {
        method: "POST", headers: { "Content-Type": "application/json" }, body,
      }));
      expect(approvalRes.status).toBe(400);
    }
  });

  it("rejects a Slack-sourced request with no task fields and records no approval", async () => {
    const instance = agent();
    const response = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "slack" }),
    }));
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toMatch(/repo|url/i);
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
    expect(instance.state.runs).toEqual([]);
  });

  it("queues a slash-command run as a pending approval without executing", async () => {
    const instance = agent();
    const response = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "fix it", source: "slack" }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as { approvalId?: string };
    expect(body.approvalId).toBeTruthy();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(instance.state.runs).toEqual([]); // no container, no run record yet
    expect(instance.state.pendingApprovals).toHaveLength(1);
    expect(instance.state.pendingApprovals?.[0]?.threadKey).toBe("default");
  });

  it("stores the provided threadKey on a queued mention approval", async () => {
    const instance = agent();
    const threadKey = "slack:T:C:1758217392.000100";
    const response = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "fix it", threadKey, source: "slack" }),
    }));
    expect(response.status).toBe(200);
    expect(instance.state.pendingApprovals?.[0]?.threadKey).toBe(threadKey);
  });

  it("resolves an approval exactly once; approve runs the frozen input, reject runs nothing", async () => {
    const instance = agent();
    const queued = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "fix it", baseBranch: "develop" }),
    }));
    const { approvalId } = await queued.json() as { approvalId: string };
    mocks.execute.mockResolvedValue("ok");
    const pointer = { threadKey: "default", approvalId };
    const post = (approved: boolean) => instance.onRequest(new Request("https://internal/api/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...pointer, approved, decidedBy: "U1" }),
    }));

    const rejected = await post(false);
    expect((await rejected.json() as { result: string }).result).toBe("rejected");
    expect(mocks.execute).not.toHaveBeenCalled();

    // Rejected is terminal: an approve replay reads the receipt's
    // recorded answer (T41) and runs nothing.
    const replay = await post(true);
    expect((await replay.json() as { result: string }).result).toBe("rejected");
    expect(mocks.execute).not.toHaveBeenCalled();

    // A fresh approval runs the exact frozen input through the gated path.
    const second = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "second", baseBranch: "develop", publishPullRequest: true, source: "slack" }),
    }));
    const { approvalId: freshId } = await second.json() as { approvalId: string };
    const approved = await instance.onRequest(new Request("https://internal/api/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadKey: "default", approvalId: freshId, approved: true, decidedBy: "U1" }),
    }));
    expect((await approved.json() as { result: string }).result).toBe("approved");
    // Dispatch rides keepAliveWhile — the approval response returns before the
    // delegated run starts; wait for the async dispatch instead of racing it.
    await vi.waitFor(() => { expect(mocks.execute).toHaveBeenCalledOnce(); });
    const calls = mocks.execute.mock.calls as unknown as [[string, { toolCallId: string }]];
    expect(parseAgentToolInput([{ role: "user", text: calls[0]![0]! }])).toMatchObject({ task: "second", baseBranch: "develop", publishPullRequest: true });
  });
});

describe("approval handoff recovery", () => {
  it.each(["chat", "app-tools"])("dispatches a frozen API approval after the latest turn switches to %s", async (mode) => {
    const instance = agent();
    const queued = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "approved work" }),
    }));
    const { approvalId } = await queued.json() as { approvalId: string };
    const messages = [{ role: "user", metadata: mode === "chat"
      ? { shibaMode: "chat" }
      : { shibaMode: "work", shibaWorkTarget: "app-tools" } }];
    Object.assign(instance, { messages });
    expect(instance.getTools()["delegate_coding_task"]).toBeUndefined();
    mocks.execute.mockResolvedValue(formatAgentResult({
      status: "completed", exitCode: 0, stderrTail: "", changedFiles: [], diff: "", files: [], summary: "done",
    }));
    const approve = () => new Request("https://internal/api/approvals", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadKey: "default", approvalId, approved: true, decidedBy: "U1" }),
    });
    expect((await instance.onRequest(approve())).status).toBe(200);
    await vi.waitFor(() => expect(instance.state.runs[0]?.status).toBe("completed"));
    const restarted = agent();
    Object.assign(restarted, { messages });
    restarted.setState(structuredClone(instance.state));
    await restarted.onStart();
    expect((await restarted.onRequest(approve())).status).toBe(200);
    expect(restarted.getTools()["delegate_coding_task"]).toBeUndefined();
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it("persists decision and run together before dispatch, then fails interrupted work on restart", async () => {
    const instance = agent();
    const queued = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "fix" }),
    }));
    const { approvalId } = await queued.json() as { approvalId: string };
    let crashState: OrchestratorState | undefined;
    const writes: OrchestratorState[] = [];
    instance.setState = (state) => {
      setStateLikeProduction(instance, state);
      // Record what production would have committed — post-spine flush.
      writes.push(structuredClone(instance.state));
    };
    Object.assign(instance, { messages: [{ role: "user", metadata: { shibaMode: "chat" } }] });
    expect(instance.getTools()["delegate_coding_task"]).toBeUndefined();
    // Snapshot exactly at dispatch entry, before any child execution can start.
    Object.assign(instance, { approvedRunDelegate: () => {
      crashState = structuredClone(instance.state);
      throw new Error("Simulated process interruption before dispatch");
    } });
    const request = () => new Request("https://internal/api/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadKey: "default", approvalId, approved: true, decidedBy: "U1" }),
    });
    expect((await instance.onRequest(request())).status).toBe(200);
    expect(writes[0]?.pendingApprovals?.[0]?.status).toBe("approved");
    expect(writes[0]?.runs[0]?.status).toBe("pending");
    expect(crashState?.runs).toHaveLength(1);
    expect(crashState?.runs[0]?.status).toBe("pending");
    expect(mocks.execute).not.toHaveBeenCalled();

    expect(crashState?.runs[0]?.checkpoint).toBe("dispatching");
    const restarted = agent();
    Object.assign(restarted, { messages: [{ role: "user", metadata: { shibaMode: "chat" } }] });
    restarted.setState(JSON.parse(JSON.stringify(crashState)) as OrchestratorState);
    mocks.execute.mockResolvedValue(formatAgentResult({
      status: "completed", exitCode: 0, stderrTail: "", changedFiles: [], diff: "", files: [], summary: "resumed",
    }));
    await restarted.onStart();
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalled());
    expect(restarted.state.runs[0]?.error ?? "").not.toContain("orchestrator restart");
    expect(restarted.state.runs[0]?.status).not.toBe("unknown");
    expect(restarted.state.pendingApprovals?.[0]?.status).toBe("approved");
    // The replayed resolve answers from the committed command receipt
    // (T41) — the decision was recorded; it is not re-litigated.
    expect(await (await restarted.onRequest(request())).json()).toEqual({ result: "approved" });
    expect(restarted.state.runs).toHaveLength(1);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it("starts when the durable object has no state yet", async () => {
    const instance = agent();
    delete (instance as { state?: OrchestratorState }).state;
    await instance.onStart();
    expect(instance.state).toBeUndefined();
  });

  it("leaves an executing checkpoint unknown after restart", async () => {
    const instance = agent();
    const approvalId = "ap-exec";
    const approvals = resolvePendingApproval(createPendingApproval([], {
      threadKey: "default", approvalId, repoUrl: "https://github.com/o/r", task: "fix", createdAt: Date.now(),
    }), { threadKey: "default", approvalId, approved: true, decidedBy: "U1" }, Date.now()).approvals;
    instance.setState({
      runs: [{
        ...createRun({
          runId: `agent-tool:${approvalId}`,
          sandboxId: "s-exec",
          repoUrl: "https://github.com/o/r",
          task: "fix",
          baseBranch: "main",
          publishPullRequest: false,
        }),
        status: "running",
        checkpoint: "executing",
      }],
      pendingApprovals: approvals,
    });
    await instance.onStart();
    expect(instance.state.runs[0]?.status).toBe("unknown");
    expect(instance.state.runs[0]?.error).toContain("orchestrator restart");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe("combined cancellation signals", () => {
  it.each(["caller", "run"])("aborts child from %s cancellation and releases controller", async (source) => {
    const instance = agent();
    const caller = new AbortController();
    mocks.execute.mockImplementation(async (_input, options: { abortSignal: AbortSignal }) => {
      await new Promise((_resolve, reject) => {
        options.abortSignal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    });
    approveDirect(instance, "combined");
    const delegate = instance.getTools()["delegate_coding_task"] as {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };
    const execution = delegate.execute({ repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false },
      { toolCallId: "combined", abortSignal: caller.signal });
    const outcome = expect(execution).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    if (source === "caller") caller.abort();
    else await instance.cancelRun("agent-tool:combined");
    await outcome;
    expect((instance as unknown as { runControllersMap: Map<string, AbortController> }).runControllersMap.size).toBe(0);
  });

  it("does not dispatch or retain a run for an already-aborted caller", async () => {
    const instance = agent();
    const caller = new AbortController();
    caller.abort(new Error("already cancelled"));
    const delegate = instance.getTools()["delegate_coding_task"] as {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };
    await expect(delegate.execute({ repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false },
      { toolCallId: "pre-abort", abortSignal: caller.signal })).rejects.toThrow("already cancelled");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(instance.state.runs).toEqual([]);
  });
});

describe("slack thread wiring", () => {
  it("freezes the queued harness and thread into the executed envelope", async () => {
    const threadKey = "slack:T1:C1:1758217400.000100";
    const instance = agent();
    // In production this DO instance is resolved by thread name; the
    // fabricated test instance gets the same name pinned on directly.
    Object.assign(instance, { name: threadKey });
    const queued = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "fix", harness: "claude-code", threadKey }),
    }));
    expect(queued.status).toBe(200);
    const { approvalId } = await queued.json() as { approvalId: string };
    const approved = await instance.onRequest(new Request("https://internal/api/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadKey: "slack:T1:C1:1758217400.000100", approvalId, approved: true, decidedBy: "U1" }),
    }));
    expect(approved.status).toBe(200);
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalled());
    const calls = mocks.execute.mock.calls as unknown as [[string]];
    expect(parseAgentToolInput([{ role: "user", text: calls[0]![0]! }])).toMatchObject({
      harness: "claude-code",
      slackThread: { channelId: "C1", threadTs: "1758217400.000100" },
    });
  });

  it("rejects a queue request naming an unknown harness", async () => {
    const instance = agent();
    const queued = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "fix", harness: "bogus-agent" }),
    }));
    expect(queued.status).toBe(400);
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
  });

  it.each(HARNESS_IDS)("delegate tool schema accepts harness %s", (harness) => {
    const parsed = delegateInputSchema.safeParse({
      repoUrl: "https://github.com/o/r",
      task: "fix",
      harness,
    });
    expect(parsed.success).toBe(true);
  });

  it("delegate tool schema still rejects a bogus harness name", () => {
    const parsed = delegateInputSchema.safeParse({
      repoUrl: "https://github.com/o/r",
      task: "fix",
      harness: "bogus-agent",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("run reliability", () => {
  const INPUT = { repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false };

  /** Slack-thread orchestrator whose post-backs and waitUntil work are captured. */
  function slackAgent(slackReply: Record<string, unknown> = { ok: true }) {
    const instance = agent();
    const pending: Promise<unknown>[] = [];
    const waitUntil = vi.fn((p: Promise<unknown>) => { pending.push(p); });
    Object.assign(instance, { name: "slack:T1:C9:1700.0001", ctx: { waitUntil } });
    Object.assign(instance.env, { SLACK_BOT_TOKEN: "xoxb-test" });
    const posts: { text: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      posts.push(JSON.parse(String(init?.body)) as { text: string });
      return Response.json(slackReply);
    }));
    return { instance, posts, waitUntil, settled: () => Promise.all(pending) };
  }

  afterEach(() => { vi.unstubAllGlobals(); });

  it("runs an approved dispatch under keepAliveWhile so the DO cannot idle out mid-run", async () => {
    const instance = agent();
    let held = false;
    let heldDuringExecute: boolean | undefined;
    mocks.keepAliveWhile.mockImplementation(async (fn: () => Promise<unknown>) => {
      held = true;
      try { return await fn(); } finally { held = false; }
    });
    mocks.execute.mockImplementation(async () => { heldDuringExecute = held; return "ok"; });
    const queued = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "fix" }),
    }));
    const { approvalId } = await queued.json() as { approvalId: string };
    const approved = await instance.onRequest(new Request("https://internal/api/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadKey: "default", approvalId, approved: true, decidedBy: "U1" }),
    }));
    expect((await approved.json() as { result: string }).result).toBe("approved");
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    expect(mocks.keepAliveWhile).toHaveBeenCalledOnce();
    expect(heldDuringExecute).toBe(true);
    await vi.waitFor(() => expect(held).toBe(false));
  });

  it("schedules a deadline reclaim when a run starts, targeting a real method", async () => {
    const instance = agent();
    mocks.execute.mockResolvedValue(formatAgentResult({
      status: "completed", exitCode: 0, stderrTail: "", changedFiles: [], diff: "", files: [], summary: "done",
    }));
    approveDirect(instance, "sched");
    const delegate = instance.getTools()["delegate_coding_task"] as {
      execute: (input: unknown, options?: unknown) => Promise<unknown>;
    };
    await delegate.execute(INPUT, { toolCallId: "sched" });
    expect(mocks.schedule).toHaveBeenCalledWith(Math.ceil(RUN_DEADLINE_MS / 1000) + 60, "reclaimRuns");
    const callback = mocks.schedule.mock.calls[0]![1] as keyof CodingOrchestrator;
    expect(typeof instance[callback]).toBe("function");
  });

  it("the scheduled reclaim reaps a stale run without traffic and tells its Slack thread", async () => {
    const { instance, posts } = slackAgent();
    instance.setState({ runs: [retained()] });
    await instance.reclaimRuns();
    expect(instance.state.runs[0]?.status).toBe("unknown");
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain("not sure how the o/r run ended");
    expect(posts[0]!.text).toContain("deadline");
  });

  it("on restart, posts outcome unknown to the Slack thread and tears down without blocking start", async () => {
    const { instance, posts, waitUntil } = slackAgent();
    const approvalId = "ap-restart";
    const approvals = resolvePendingApproval(createPendingApproval([], {
      threadKey: "default", approvalId, repoUrl: "https://github.com/o/r", task: "fix", createdAt: Date.now(),
    }), { threadKey: "default", approvalId, approved: true, decidedBy: "U1" }, Date.now()).approvals;
    instance.setState({
      runs: [{ ...createRun({ runId: `agent-tool:${approvalId}`, sandboxId: "s-restart", repoUrl: "https://github.com/o/r",
        task: "fix", baseBranch: "main", publishPullRequest: false }), status: "running" }],
      pendingApprovals: approvals,
    });
    // A hung destroy must not hold onStart open.
    mocks.destroy.mockImplementation(() => new Promise(() => {}));
    await instance.onStart();
    expect(instance.state.runs[0]?.status).toBe("unknown");
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalled();
    const notice = posts.find((post) => post.text.includes("not sure how the o/r run ended"));
    expect(notice?.text).toContain("orchestrator restart");
  });

  it("posts the PR link and a short summary even when a long diff precedes it in the log", async () => {
    const { instance, posts } = slackAgent();
    const pullUrl = "https://github.com/o/r/pull/7";
    const diff = "+line\n".repeat(5000);
    mocks.execute.mockResolvedValue(`Diff:\n${diff}\n${formatAgentResult({
      status: "completed", exitCode: 0, stderrTail: "", changedFiles: ["a.ts"], diff, files: [],
      summary: "OpenCode completed for https://github.com/o/r (main): 1 changed files.", pullUrl,
    })}`);
    approveDirect(instance, "pr");
    const delegate = instance.getTools()["delegate_coding_task"] as {
      execute: (input: unknown, options?: unknown) => Promise<unknown>;
    };
    await delegate.execute(INPUT, { toolCallId: "pr" });
    const run = instance.state.runs[0]!;
    expect(run.status).toBe("completed");
    expect(run.pullUrl).toBe(pullUrl);
    expect(run.summary).not.toContain(pullUrl);
    const completed = posts.find((post) => post.text.startsWith("done — here's what changed in o/r"));
    expect(completed?.text).toContain(`PR: ${pullUrl}`);
    expect(completed?.text).toContain("1 changed files.");
    expect(completed!.text.length).toBeLessThan(1200);
  });

  it("redacts malformed structured child output before posting failure details", async () => {
    const { instance, posts, settled } = slackAgent();
    mocks.execute.mockResolvedValue({ error: "Bearer secret-output-token" });
    approveDirect(instance, "bad-output", INPUT);
    const delegate = instance.getTools()["delegate_coding_task"] as unknown as {
      execute: (input: unknown, options?: unknown) => Promise<unknown>;
    };
    await expect(delegate.execute(INPUT, { toolCallId: "bad-output" })).rejects.toThrow();
    await settled();
    expect(JSON.stringify(posts)).not.toContain("secret-output-token");
  });

  it("settles a post-back without ctx instead of leaving its outbox claim stuck", async () => {
    const { instance, posts } = slackAgent();
    Object.assign(instance, { ctx: undefined });
    instance.setState({ runs: [{ ...retained(), updatedAt: Date.now() }] });
    await expect(instance.cancelRun("r1")).resolves.toMatchObject({ status: "cancelled" });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    await vi.waitFor(() => {
      expect(Reflect.get(instance, "inFlightEffects").size).toBe(0);
    });
  });

  it("logs Slack ok:false post-back failures that arrive as HTTP 200", async () => {
    const { instance, settled } = slackAgent({ ok: false, error: "not_in_channel" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      instance.setState({ runs: [{ ...retained(), updatedAt: Date.now() }] });
      await instance.cancelRun("r1");
      await settled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("not_in_channel"));
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("complete skill prompt approval boundary", () => {
  const queue = (instance: CodingOrchestrator, task: string, count: number) => instance.onRequest(new Request("https://internal/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shiba-Intake": "dashboard" },
    body: JSON.stringify({
      repoUrl: "https://github.com/o/r",
      task,
      skillPins: Array.from({ length: count }, (_, index) => ({
        skillId: `skill-${String(index + 1).padStart(24, "a")}`,
        version: 1,
        name: `Skill ${index + 1}`,
      })),
      orgId: "self-hosted",
    }),
  }));

  it.each([
    ["a long single skill", `Task\n\nSkills:\nSkill: Long (skill-${"a".repeat(24)}@1)\nReviewed instructions:\n${"x".repeat(4100)}`, 1],
    ["multiple selected skills", `Task\n\n${Array.from({ length: 3 }, (_, index) => `Skill ${index + 1}\n${"x".repeat(1400)}`).join("\n\n")}`, 3],
    ["an already long task plus skill text", `${"User task. ".repeat(350)}\n\nSkills:\nReviewed instructions:\n${"Skill detail. ".repeat(20)}`, 1],
  ])("rejects overflow for %s without minting a truncated approval", async (_label, task, count) => {
    const instance = agent();
    const response = await queue(instance, task, count);
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toMatch(/complete task and selected skill instructions/);
    expect(instance.state.pendingApprovals ?? []).toEqual([]);
  });

  it("freezes the full effective prompt when it fits the limit", async () => {
    const instance = agent();
    const task = `User task\n\nSkill instructions\n${"x".repeat(3950)}`;
    expect(task.length).toBeLessThanOrEqual(4000);
    const response = await queue(instance, task, 1);
    expect(response.status).toBe(200);
    expect(instance.state.pendingApprovals?.[0]?.task).toBe(task);
    expect((await response.json() as { task: string }).task).toBe(task);
  });

  it("rejects project context from non-dashboard intake", async () => {
    const instance = agent();
    const response = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "Fix it", projectContextId: "memproj_aaaaaaaaaaaaaaaaaaaaaaaa" }),
    }));
    expect(response.status).toBe(403);
    expect(instance.state.pendingApprovals ?? []).toEqual([]);
  });

  it("blocks a disabled pin before execution while leaving the frozen text and provenance intact", async () => {
    const instance = agent();
    Object.assign(instance, { name: "owner@example.test" });
    const db = customAgentD1();
    instance.env.AGENT_AUDIT = db.database;
    const content = { name: "Revocable", instructions: "Keep this exact approved guidance." };
    const skill = await createSkill(instance.env, "owner@example.test", "owner@example.test", content);
    await reviewSkill(instance.env, "owner@example.test", "owner@example.test", skill.id, 1, content.instructions);
    await activateSkill(instance.env, "owner@example.test", "owner@example.test", skill.id, 1, content.instructions);
    const pin = { skillId: skill.id, version: 1, name: content.name };
    const approvedText = `Fix the issue\n\nSkills:\n${content.instructions}`;
    approveDirect(instance, "disabled-skill", {
      repoUrl: "https://github.com/o/r", task: approvedText, orgId: "owner@example.test", skillPins: [pin],
    });
    await disableSkill(instance.env, "owner@example.test", "owner@example.test", skill.id);
    const delegate = instance.getTools()["delegate_coding_task"] as { execute: (input: unknown, options: unknown) => Promise<unknown> };

    await expect(delegate.execute({ repoUrl: "https://github.com/o/r", task: "changed caller input" }, { toolCallId: "disabled-skill" }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(instance.state.runs[0]).toMatchObject({ status: "error", task: approvedText, skillPins: [pin] });
  });
});

describe("chat approval gate", () => {
  const INPUT = { repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false };
  type DelegateTool = {
    needsApproval: (input: unknown, options: { toolCallId: string }) => Promise<boolean>;
    execute: (input: unknown, options?: unknown) => Promise<unknown>;
  };
  const delegateOf = (instance: CodingOrchestrator) =>
    instance.getTools()["delegate_coding_task"] as unknown as DelegateTool;

  it.each([
    ["one long skill", "fix", ["x".repeat(4_100)]],
    ["multiple skills", "fix", Array.from({ length: 3 }, () => "x".repeat(1_400))],
    ["a long user task plus a skill", "x".repeat(3_900), ["y".repeat(200)]],
  ])("rejects the full oversized chat prompt for %s before minting an approval", async (_label, task, texts) => {
    const instance = agent();
    Object.assign(instance, { name: "owner@example.test" });
    const db = customAgentD1();
    instance.env.AGENT_AUDIT = db.database;
    const pins: Array<{ skillId: string; version: number }> = [];
    for (const [index, instructions] of texts.entries()) {
      const content = { name: `Chat skill ${index + 1}`, instructions };
      const skill = await createSkill(instance.env, "owner@example.test", "owner@example.test", content);
      await reviewSkill(instance.env, "owner@example.test", "owner@example.test", skill.id, 1, instructions);
      await activateSkill(instance.env, "owner@example.test", "owner@example.test", skill.id, 1, instructions);
      pins.push({ skillId: skill.id, version: 1 });
    }
    Object.assign(instance, { composerPin: () => ({ skillPins: pins }) });
    await expect(delegateOf(instance).needsApproval({ ...INPUT, task }, { toolCallId: "chat-overflow" }))
      .rejects.toThrow(/complete task and selected skill instructions exceed the 4000-character limit/);
    expect(instance.state.pendingApprovals ?? []).toEqual([]);
  });

  it("mints the durable pointer at gate time so chat Approve can mint its run", async () => {
    const instance = agent();
    mocks.execute.mockResolvedValue(formatAgentResult({
      status: "completed", exitCode: 0, stderrTail: "", changedFiles: [], diff: "", files: [], summary: "done",
    }));
    const delegate = delegateOf(instance);

    await expect(delegate.needsApproval(INPUT, { toolCallId: "chat-1" })).resolves.toBe(true);
    const minted = instance.state.pendingApprovals?.find((a) => a.approvalId === "chat-1");
    expect(minted?.status).toBe("pending");
    expect(minted?.route?.modelId).toBeTruthy();
    // The SDK re-evaluates needsApproval after the response lands — idempotent.
    await expect(delegate.needsApproval(INPUT, { toolCallId: "chat-1" })).resolves.toBe(true);
    expect(instance.state.pendingApprovals?.filter((a) => a.approvalId === "chat-1")).toHaveLength(1);

    // The card Approve lands through the authenticated resolve path —
    // execute itself never decides an approval — and its fire-and-forget
    // dispatch drives the reserved run to completion.
    const resolved = await instance.onRequest(
      new Request("https://internal/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadKey: "default",
          approvalId: "chat-1",
          approved: true,
          decidedBy: "human",
        }),
      }),
    );
    expect(resolved.status).toBe(200);
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    const pointer = instance.state.pendingApprovals?.find((a) => a.approvalId === "chat-1");
    expect(pointer?.status).toBe("approved");
    expect(pointer?.decidedBy).toBe("human");
    await vi.waitFor(() => {
      const r = instance.state.runs.find((run) => run.runId === "agent-tool:chat-1");
      expect(r?.status).toBe("completed");
    });
    const run = instance.state.runs.find((r) => r.runId === "agent-tool:chat-1");
    expect(run?.approval?.approvalId).toBe("chat-1");
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it("freezes owner project provenance into approval and run context", async () => {
    const instance = agent();
    Object.assign(instance, { name: "owner@example.test", messages: [{ role: "user", metadata: { shibaTask: { projectContextId: "memproj_aaaaaaaaaaaaaaaaaaaaaaaa" } } }] });
    mocks.execute.mockResolvedValue(formatAgentResult({ status: "completed", exitCode: 0, stderrTail: "", changedFiles: [], diff: "", files: [], summary: "done" }));
    let currentText = "launch checklist and QA owner";
    const partitionNames: string[] = [];
    Object.assign(instance.env, { Memory: {
      idFromName(name: string) { partitionNames.push(name); return name; },
      get() { return { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { id: string };
        if (body.id !== "memproj_aaaaaaaaaaaaaaaaaaaaaaaa") return Response.json({ error: "missing" }, { status: 404 });
        return Response.json({ snapshot: {
          project: { id: body.id, name: "Launch", purpose: "Ship safely", version: 3, defaultCustomAgentId: null, defaultHarness: null },
          sources: [{ id: "memsrc_1", title: "Checklist", kind: "document", referenceUrl: "https://docs.example.test/launch", updatedAt: 7, content: currentText }],
        } });
      } }; },
    } });
    const delegate = delegateOf(instance);
    await expect(delegate.needsApproval(INPUT, { toolCallId: "project-chat-1" })).resolves.toBe(true);
    const frozen = instance.state.pendingApprovals?.find((record) => record.approvalId === "project-chat-1")?.task ?? "";
    expect(frozen).toContain("SELECTED PROJECT CONTEXT (UNTRUSTED REFERENCE DATA");
    expect(frozen).toContain('"version":3');
    expect(frozen).toContain("launch checklist and QA owner");
    expect(frozen).toContain("https://docs.example.test/launch");
    expect(partitionNames).toHaveLength(1);
    expect(partitionNames[0]).toMatch(/^owner-memory:[a-f0-9]{64}$/);
    currentText = "edited after approval";
    const resolved = await instance.onRequest(new Request("https://internal/api/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadKey: "owner@example.test", approvalId: "project-chat-1", approved: true, decidedBy: "human" }),
    }));
    expect(resolved.status).toBe(200);
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(instance.state.runs.find((run) => run.runId === "agent-tool:project-chat-1")?.status).toBe("completed"));
    const approval = instance.state.pendingApprovals?.find((record) => record.approvalId === "project-chat-1");
    expect(approval?.status).toBe("approved");
    const approvedRun = instance.state.runs.find((run) => run.runId === "agent-tool:project-chat-1");
    expect(approvedRun?.task).toBe(frozen);
    expect(approvedRun?.task).not.toContain("edited after approval");
  });

  it("still refuses an execute that no gate ever minted", async () => {
    const instance = agent();
    const out = await delegateOf(instance).execute(INPUT, { toolCallId: "never-gated" });
    expect(out).toBe("Run is not approved to execute.");
    expect(instance.state.runs).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("an inadmissible route fails before the card is minted", async () => {
    const instance = agent();
    const delegate = delegateOf(instance);
    await expect(
      delegate.needsApproval(
        { ...INPUT, connectionId: "conn_missing" },
        { toolCallId: "chat-bad-route" },
      ),
    ).rejects.toThrow("Unknown model connection");
    expect(instance.state.pendingApprovals ?? []).toEqual([]);
  });
});
