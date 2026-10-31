import { describe, expect, it, vi } from "vitest";

vi.mock("agents/routing", () => ({ getAgentByName: vi.fn() }));
vi.mock("../src/slack-routes.js", () => ({ ORCHESTRATOR_NAME: "default" }));

import { Automations, type AutomationsState, type OrchestratorStub } from "../src/automations-do.js";
import { createAutomation, reviewedSkillPinSha256, type Automation } from "../src/automations.js";
import type { Env } from "../src/env.js";

class FakeStorage {
  readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }

  async list<T>({ prefix }: { prefix: string }): Promise<Map<string, T>> {
    return new Map(
      [...this.data.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key, structuredClone(value) as T]),
    );
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async transaction<T>(callback: (transaction: FakeStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

const NOW = Date.UTC(2026, 9, 28, 10, 0);
const REPO = "https://github.com/owner/repo";

function makeDo(items: Automation[]) {
  const storage = new FakeStorage();
  storage.data.set("state", { items });
  const env = {
    AUTOMATIONS_ENABLED: "true",
    AI: {},
    ORCHESTRATOR_MODEL: "@cf/test/model",
  } as unknown as Env;
  const automation = new Automations({ storage } as unknown as DurableObjectState, env);
  const fetch = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/approvals") {
      return Response.json({ approvals: [], decided: [{ approvalId: "pending-approval", status: "approved" }] });
    }
    if (request.method === "GET" && url.pathname === "/api/runs") {
      return Response.json({ runs: [{ runId: "agent-tool:pending-approval", status: "completed" }] });
    }
    return Response.json({ approvalId: "pending-approval" });
  });
  const orchestrator: OrchestratorStub = { fetch };
  return { automation, storage, orchestrator, fetch };
}

function addDueBatch(storage: FakeStorage, id: string) {
  storage.data.set(`webhook-batch:${id}`, {
    bodies: ['{"issue":"fix this"}'],
    firstAt: NOW - 60_000,
    windowSeconds: 10,
  });
}

describe("automation tick webhook and schedule state", () => {
  it("preserves a pause that arrives while the scheduled queue request is pending", async () => {
    const scheduled = createAutomation({
      id: "pause-during-queue",
      prompt: "Prepare a draft",
      executionTarget: { kind: "artifact-workspace", expectedDeliverables: ["brief.md"] },
      triggers: [{ kind: "schedule", cron: "0 3 * * *", timezone: "America/Los_Angeles" }],
    }).automation;
    const { automation, storage, orchestrator, fetch } = makeDo([scheduled]);
    let enteredQueue!: () => void;
    let releaseQueue!: () => void;
    const queueEntered = new Promise<void>((resolve) => { enteredQueue = resolve; });
    const queueGate = new Promise<void>((resolve) => { releaseQueue = resolve; });
    fetch.mockImplementation(async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/approvals") return Response.json({ approvals: [], decided: [{ approvalId: "pending-approval", status: "approved" }] });
      if (request.method === "GET" && url.pathname === "/api/runs") return Response.json({ runs: [{ runId: "agent-tool:pending-approval", status: "completed" }] });
      enteredQueue();
      await queueGate;
      return Response.json({ approvalId: "pending-approval" });
    });

    const tick = automation.tick(orchestrator, NOW);
    await queueEntered;
    const paused = await automation.fetch(new Request("https://internal/api/automations/pause-during-queue", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }));
    expect(paused.status).toBe(200);
    releaseQueue();
    expect(await tick).toEqual({ fired: 1 });

    const latest = (await storage.get<AutomationsState>("state"))?.items[0];
    expect(latest).toMatchObject({ enabled: false, runCount: 1, runsToday: 1 });
    expect(await automation.tick(orchestrator, NOW + 60_000)).toEqual({ fired: 0 });
    expect(fetch.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
    expect((await storage.get<AutomationsState>("state"))?.items[0]?.occurrences?.[0]).toMatchObject({ outcome: "completed", status: "completed" });
  });

  it("does not resurrect an automation deleted while its queue request is pending", async () => {
    const scheduled = createAutomation({
      id: "delete-during-queue",
      prompt: "Prepare a draft",
      executionTarget: { kind: "artifact-workspace", expectedDeliverables: ["brief.md"] },
      triggers: [{ kind: "schedule", cron: "0 3 * * *", timezone: "America/Los_Angeles" }],
    }).automation;
    const { automation, storage, orchestrator, fetch } = makeDo([scheduled]);
    let enteredQueue!: () => void;
    let releaseQueue!: () => void;
    const queueEntered = new Promise<void>((resolve) => { enteredQueue = resolve; });
    const queueGate = new Promise<void>((resolve) => { releaseQueue = resolve; });
    fetch.mockImplementation(async () => {
      enteredQueue();
      await queueGate;
      return Response.json({ approvalId: "pending-approval" });
    });

    const tick = automation.tick(orchestrator, NOW);
    await queueEntered;
    const deleted = await automation.fetch(new Request("https://internal/api/automations/delete-during-queue", {
      method: "DELETE",
    }));
    expect(deleted.status).toBe(200);
    releaseQueue();
    expect(await tick).toEqual({ fired: 1 });
    expect((await storage.get<AutomationsState>("state"))?.items).toEqual([]);
  });

  it("persists a timezone-aware repo-free target and dispatches the exact frozen target once", async () => {
    const { automation, storage, orchestrator, fetch } = makeDo([]);
    const target = {
      kind: "artifact-workspace",
      workspaceName: "Weekly sales",
      expectedDeliverables: ["sales/account-brief.md", "sales/outreach-draft.md"],
    };
    const created = await automation.fetch(new Request("https://internal/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "weekly-sales",
        prompt: "Prepare a grounded weekly account brief",
        executionTarget: target,
        triggers: [{ kind: "schedule", cron: "0 3 * * *", timezone: "America/Los_Angeles" }],
      }),
    }));
    expect(created.status).toBe(201);
    expect((await created.json() as { automation: Automation }).automation.executionTarget).toEqual(target);
    const duplicate = await automation.fetch(new Request("https://internal/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "weekly-sales",
        prompt: "Replace the approved schedule",
        executionTarget: { kind: "artifact-workspace", workspaceName: "Changed", expectedDeliverables: ["different.md"] },
        triggers: [{ kind: "schedule", cron: "0 4 * * *", timezone: "UTC" }],
      }),
    }));
    expect(duplicate.status).toBe(409);
    expect((await storage.get<AutomationsState>("state"))?.items[0]).toMatchObject({
      prompt: "Prepare a grounded weekly account brief",
      executionTarget: target,
      triggers: [{ kind: "schedule", cron: "0 3 * * *", timezone: "America/Los_Angeles" }],
      runCount: 0,
    });
    expect(await automation.tick(orchestrator, NOW)).toEqual({ fired: 1 });
    expect(fetch.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
    const queued = await fetch.mock.calls[0]![0].clone().json() as Record<string, unknown>;
    expect(queued).toMatchObject({ repoUrl: "", executionTarget: target, publishPullRequest: false });
    expect(queued.commandId).toBe("automation:weekly-sales:sched:2026-10-28T10:00");

    // A retried cron tick in the same occurrence window must not queue a second approval.
    expect(await automation.tick(orchestrator, NOW + 4 * 60_000)).toEqual({ fired: 0 });
    expect(fetch.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
    const stored = (await storage.get<AutomationsState>("state"))?.items[0];
    expect(stored?.runCount).toBe(1);
    expect(stored?.occurrences).toHaveLength(1);
    expect(stored?.occurrences?.[0]).toMatchObject({
      status: "completed",
      outcome: "completed",
      approvalId: "pending-approval",
      runId: "agent-tool:pending-approval",
      commandId: "automation:weekly-sales:sched:2026-10-28T10:00",
    });
  });

  it("pause suppresses scheduled dispatch and resume allows the next occurrence", async () => {
    const scheduled = createAutomation({
      id: "pause-resume",
      prompt: "Prepare a draft",
      executionTarget: { kind: "artifact-workspace", expectedDeliverables: ["brief.md"] },
      triggers: [{ kind: "schedule", cron: "0 3 * * *", timezone: "America/Los_Angeles" }],
    }).automation;
    const { automation, storage, orchestrator, fetch } = makeDo([scheduled]);
    const patch = (enabled: boolean) => automation.fetch(new Request("https://internal/api/automations/pause-resume", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }));
    const mutateTarget = await automation.fetch(new Request("https://internal/api/automations/pause-resume", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ executionTarget: { kind: "artifact-workspace", expectedDeliverables: ["other.md"] } }),
    }));
    expect(mutateTarget.status).toBe(400);
    expect((await storage.get<AutomationsState>("state"))?.items[0]?.executionTarget)
      .toEqual(scheduled.executionTarget);
    expect((await patch(false)).status).toBe(200);
    expect(await automation.tick(orchestrator, NOW)).toEqual({ fired: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect((await patch(true)).status).toBe(200);
    expect(await automation.tick(orchestrator, NOW)).toEqual({ fired: 1 });
    expect(fetch.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
    expect(await automation.tick(orchestrator, NOW + 60_000)).toEqual({ fired: 0 });
    expect(fetch.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
  });

  it("requires an explicit skill review to re-enable a scheduled skill snapshot", async () => {
    const instructions = "Use supplied sources only.";
    const skillIdentity = { id: "skill-1", version: "1", source: "saved-library", instructions };
    const sha256 = await reviewedSkillPinSha256(skillIdentity);
    const scheduled = createAutomation({
      id: "review-skill",
      prompt: "Prepare a cited draft",
      executionTarget: { kind: "artifact-workspace", expectedDeliverables: ["brief.md"] },
      triggers: [{ kind: "schedule", cron: "0 3 * * *", timezone: "America/Los_Angeles" }],
      skillPins: [{ id: "skill-1", version: "1", source: "saved-library", instructions, sha256, enabled: false }],
    }).automation;
    const { automation, storage, orchestrator, fetch } = makeDo([scheduled]);
    const replacementBase = { ...scheduled.skillPins![0]!, version: "reviewed-2", enabled: true };
    const replacement = { ...replacementBase, sha256: await reviewedSkillPinSha256(replacementBase) };
    const patch = (body: unknown) => automation.fetch(new Request("https://internal/api/automations/review-skill", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));
    expect((await patch({ skillPins: [replacement] })).status).toBe(400);
    expect(await automation.tick(orchestrator, NOW)).toEqual({ fired: 0 });
    expect(fetch).not.toHaveBeenCalled();

    expect((await patch({ skillPins: [replacement], reviewSkillPins: true })).status).toBe(200);
    expect(await automation.tick(orchestrator, NOW)).toEqual({ fired: 1 });
    const stored = (await storage.get<AutomationsState>("state"))?.items[0];
    expect(stored?.skillPins?.[0]).toMatchObject({ version: "reviewed-2", enabled: true });
    expect(stored?.occurrences?.[0]).toMatchObject({ outcome: "approval-pending", approvalId: "pending-approval" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("recovers an unknown queue result with the same occurrence command and persists its approval link", async () => {
    const scheduled = createAutomation({
      id: "recover-unknown",
      prompt: "Prepare a draft",
      executionTarget: { kind: "artifact-workspace", expectedDeliverables: ["brief.md"] },
      triggers: [{ kind: "schedule", cron: "0 3 * * *", timezone: "America/Los_Angeles" }],
    }).automation;
    const { automation, storage, orchestrator, fetch } = makeDo([scheduled]);
    fetch.mockRejectedValueOnce(new Error("connection dropped after write"));
    expect(await automation.tick(orchestrator, NOW)).toEqual({ fired: 0 });
    const uncertain = (await storage.get<AutomationsState>("state"))?.items[0]?.occurrences?.[0];
    expect(uncertain).toMatchObject({ status: "queue-unknown", outcome: "queue-outcome-unknown" });

    expect(await automation.tick(orchestrator, NOW + 4 * 60_000)).toEqual({ fired: 1 });
    const recovered = (await storage.get<AutomationsState>("state"))?.items[0]?.occurrences;
    expect(recovered).toHaveLength(1);
    expect(recovered?.[0]).toMatchObject({
      status: "queued", outcome: "approval-pending", approvalId: "pending-approval", runId: "agent-tool:pending-approval",
    });
    const queuedCalls = fetch.mock.calls.filter(([request]) => request.method === "POST");
    expect(queuedCalls).toHaveLength(2);
    const commands = await Promise.all(queuedCalls.map(async ([request]) => (await request.clone().json() as { commandId: string }).commandId));
    expect(commands[0]).toBe(commands[1]);
  });

  it("charges a flushed webhook against the daily budget before evaluating schedules", async () => {
    const item: Automation = {
      ...createAutomation({
        id: "combined",
        prompt: "Triage",
        repoUrl: REPO,
        triggers: [
          { kind: "webhook", batchWindowSeconds: 10 },
          { kind: "schedule", cron: "0 * * * *" },
        ],
      }).automation,
      dailyRunLimit: 1,
      // This schedule has its own prior firing; a webhook firing must not
      // overwrite that cursor or erase the shared daily run charge.
      scheduleFiredAt: { t1: NOW - 3_600_000 },
    };
    const { automation, storage, orchestrator, fetch } = makeDo([item]);
    addDueBatch(storage, item.id);

    expect(await automation.tick(orchestrator, NOW)).toEqual({ fired: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const saved = (await storage.get<AutomationsState>("state"))?.items[0];
    expect(saved?.runCount).toBe(1);
    expect(saved?.runsToday).toBe(1);
    expect(saved?.lastSkip?.reason).toContain("Daily run budget");
    expect(saved?.scheduleFiredAt).toEqual(item.scheduleFiredAt);
  });

  it("preserves a webhook's durable counters when another automation's schedule fires", async () => {
    const webhook = createAutomation({
      id: "webhook",
      prompt: "Triage",
      repoUrl: REPO,
      triggers: [{ kind: "webhook", batchWindowSeconds: 10 }],
    }).automation;
    const schedule = createAutomation({
      id: "scheduled",
      prompt: "Check repository",
      repoUrl: REPO,
      triggers: [{ kind: "schedule", cron: "0 * * * *" }],
    }).automation;
    const { automation, storage, orchestrator, fetch } = makeDo([webhook, schedule]);
    addDueBatch(storage, webhook.id);

    expect(await automation.tick(orchestrator, NOW)).toEqual({ fired: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
    const state = await storage.get<AutomationsState>("state");
    expect(state?.items.map(({ id, runCount, runsToday }) => ({ id, runCount, runsToday }))).toEqual([
      { id: "webhook", runCount: 1, runsToday: 1 },
      { id: "scheduled", runCount: 1, runsToday: 1 },
    ]);

    // The persisted cursors must also survive the next cron invocation.
    expect(await automation.tick(orchestrator, NOW + 60_000)).toEqual({ fired: 0 });
    expect(fetch.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(2);
  });
});
