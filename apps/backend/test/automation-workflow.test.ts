import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { createAutomation } from "../src/automations.js";
import { startAutomationRunWorkflow } from "../src/platform/automation-run-runner.js";
import { listAutomationWorkflowRuns } from "../src/platform/automation-workflow-store.js";
import type { Env } from "../src/env.js";

describe("automation workflow runs", () => {
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