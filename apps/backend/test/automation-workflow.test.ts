import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { createAutomation } from "../src/automations.js";
import { startAutomationRunWorkflow } from "../src/platform/automation-run-runner.js";
import { listAutomationWorkflowRuns } from "../src/platform/automation-workflow-store.js";
import type { Env } from "../src/env.js";
import { fireAutomation } from "../src/automation-runner.js";
import * as workflowStore from "../src/platform/automation-workflow-store.js";

describe("automation workflow runs", () => {
  it("charges a replay once when the workflow failed after queueing but before recording a charge", async () => {
    const db = customAgentD1();
    db.sqlite.exec(readFileSync(new URL("../migrations/0055_automation_workflow_runs.sql", import.meta.url), "utf8"));
    const automation = createAutomation({ id: "charge-replay", prompt: "Task", repoUrl: "https://github.com/o/r", triggers: [{ kind: "webhook" }] }).automation;
    const env = { AGENT_AUDIT: db.database } as unknown as Env;
    const originalPatch = workflowStore.patchAutomationWorkflowRun;
    let failDispatch = true;
    const patch = vi.spyOn(workflowStore, "patchAutomationWorkflowRun").mockImplementation(async (...args) => {
      if (args[2].status === "dispatched" && failDispatch) { failDispatch = false; throw new Error("dispatch receipt write failed"); }
      return originalPatch(...args);
    });
    try {
      const queueRun = vi.fn().mockResolvedValueOnce({ approvalId: "accepted" }).mockResolvedValue({ approvalId: "accepted", deduped: true });
      const deps = { env, ai: {} as import("../src/automations.js").RunWhenAi, model: "test", globalEnabled: true, queueRun };
      const event = { kind: "hook" as const, deliveryId: "retry", body: "" };
      const first = await fireAutomation(automation, event, deps);
      expect(first.fired).toBe(false);
      expect(first.automation.runCount).toBe(0);
      const retry = await fireAutomation(first.automation, event, deps);
      expect(retry.fired).toBe(true);
      expect(retry.approvalId).toBe("accepted");
      expect(retry.automation.runCount).toBe(1);
      expect(retry.automation.runsToday).toBe(1);
      const replay = await fireAutomation(retry.automation, event, deps);
      expect(replay.automation.runCount).toBe(1);
      expect(replay.automation.runsToday).toBe(1);
      expect(replay.automation.chargedHookCommands).toHaveLength(1);
    } finally { patch.mockRestore(); }
  });
  it("propagates replay metadata from the approval queue", async () => {
    const db = customAgentD1();
    db.sqlite.exec(readFileSync(new URL("../migrations/0055_automation_workflow_runs.sql", import.meta.url), "utf8"));
    const automation = createAutomation({ id: "replay", prompt: "Task", repoUrl: "https://github.com/o/r", triggers: [{ kind: "webhook" }] }).automation;
    const result = await startAutomationRunWorkflow({ AGENT_AUDIT: db.database } as unknown as Env, {
      automation, commandId: "same-command", threadKey: "automation:replay", repoUrl: automation.repoUrl,
      task: automation.prompt, publishPullRequest: false, unattendedApproved: false,
      queueRun: async () => ({ approvalId: "same-approval", deduped: true }),
    });
    expect(result.approvalId).toBe("same-approval");
    expect(result.deduped).toBe(true);
  });
  it("records a dispatched workflow row when D1 is available", async () => {
    const db = customAgentD1();
    db.sqlite.exec(readFileSync(new URL("../migrations/0055_automation_workflow_runs.sql", import.meta.url), "utf8"));
    const env = { AGENT_AUDIT: db.database } as unknown as Env;
    const automation = createAutomation({
      id: "auto-1",
      prompt: "Nightly task",
      repoUrl: "https://github.com/o/r",
      triggers: [{ kind: "manual" }],
    }).automation;
    const queueRun = vi.fn(async () => ({ approvalId: "appr_1" }));
    const result = await startAutomationRunWorkflow(env, {
      automation,
      commandId: "cmd-1",
      threadKey: "automation:auto-1",
      repoUrl: automation.repoUrl,
      task: automation.prompt,
      publishPullRequest: false,
      unattendedApproved: false,
      queueRun,
    });
    expect(result.status).toBe("dispatched");
    const rows = await listAutomationWorkflowRuns(env, automation.id);
    expect(rows[0]?.approval_id).toBe("appr_1");
    expect(queueRun).toHaveBeenCalledOnce();
  });
});