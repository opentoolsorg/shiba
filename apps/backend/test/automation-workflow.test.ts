import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { createAutomation } from "../src/automations.js";
import { startAutomationRunWorkflow } from "../src/platform/automation-run-runner.js";
import { listAutomationWorkflowRuns } from "../src/platform/automation-workflow-store.js";
import type { Env } from "../src/env.js";
import { insertAutomationWorkflowRun, settleRoutineWorkflowRun, patchAutomationWorkflowRun } from "../src/platform/automation-workflow-store.js";
import type { DelegatedRun } from "@shiba/shared";
import { Automations } from "../src/automations-do.js";

describe("automation workflow runs", () => {
  it("exposes recent outcomes on a routine detail, and handles empty and missing routines", async () => {
    const db = customAgentD1();
    for (const migration of ["0055_automation_workflow_runs.sql", "0066_routine_outcomes.sql"]) db.sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    const env = { AGENT_AUDIT: db.database } as unknown as Env;
    const automation = createAutomation({ id: "nightly", prompt: "Check", repoUrl: "https://github.com/o/r", triggers: [{ kind: "manual" }] }).automation;
    const ctx = { storage: { get: async () => ({ items: [automation] }) } } as unknown as DurableObjectState;
    const service = new Automations(ctx, env);
    const get = (id: string) => service.fetch(new Request(`https://internal/api/automations/${id}`));
    expect(await (await get("nightly")).json()).toMatchObject({ automation: { id: "nightly" }, runs: [] });
    expect((await get("missing")).status).toBe(404);
    await insertAutomationWorkflowRun(env, { automationId: "nightly", commandId: "command" });
    expect(await (await get("nightly")).json()).toMatchObject({ runs: [{ outcome: "normal", failure_reason: null, answer_summary: null }] });
  });
  it.each([
    [false, false, undefined, "normal"], [true, false, undefined, "quiet"], [true, true, undefined, "normal"],
    [false, false, "failed", "failed"], [true, false, "failed", "failed"],
  ])("persists precedence and redacted history (%s, %s, %s)", async (noUpdate, test, failureReason, outcome) => {
    const db = customAgentD1();
    for (const migration of ["0055_automation_workflow_runs.sql", "0066_routine_outcomes.sql"]) db.sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    const env = { AGENT_AUDIT: db.database } as unknown as Env;
    const row = await insertAutomationWorkflowRun(env, { automationId: "nightly", commandId: "command" });
    await patchAutomationWorkflowRun(env, row.id, { approval_id: "approved" });
    await settleRoutineWorkflowRun(env, { routineRun: { automationId: "nightly", test },
      routineOutcome: { noUpdate, ...(failureReason ? { failureReason: "failed ghp_abcdefgh12345678" } : {}) },
      status: "completed", runId: "agent-tool:approved", approval: { approvalId: "approved" },
    } as DelegatedRun, "Answer ghp_abcdefgh12345678");
    await patchAutomationWorkflowRun(env, row.id, { status: "preparing" });
    const [stored] = await listAutomationWorkflowRuns(env, "nightly");
    expect(stored).toMatchObject({ outcome, status: outcome === "failed" ? "failed" : "terminal", run_id: "agent-tool:approved" });
    expect(stored?.answer_summary).toContain("Answer");
    expect(JSON.stringify(stored)).not.toContain("ghp_abcdefgh");
    expect(stored?.failure_reason).toBe(failureReason ? "failed [redacted]" : null);
  });
  it("keeps harness errors failed even when no-update was requested", async () => {
    const db = customAgentD1();
    for (const migration of ["0055_automation_workflow_runs.sql", "0066_routine_outcomes.sql"]) db.sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    const env = { AGENT_AUDIT: db.database } as unknown as Env;
    const row = await insertAutomationWorkflowRun(env, { automationId: "nightly", commandId: "command" });
    await patchAutomationWorkflowRun(env, row.id, { run_id: "run-1" });
    await settleRoutineWorkflowRun(env, { runId: "run-1", status: "error", error: "Harness unavailable",
      routineRun: { automationId: "nightly", test: false }, routineOutcome: { noUpdate: true } } as DelegatedRun);
    expect((await listAutomationWorkflowRuns(env, "nightly"))[0]).toMatchObject({ status: "failed", outcome: "failed", failure_reason: "Harness unavailable" });
  });
  it("records a dispatched workflow row when D1 is available", async () => {
    const db = customAgentD1();
    db.sqlite.exec(readFileSync(new URL("../migrations/0055_automation_workflow_runs.sql", import.meta.url), "utf8"));
    db.sqlite.exec(readFileSync(new URL("../migrations/0066_routine_outcomes.sql", import.meta.url), "utf8"));
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