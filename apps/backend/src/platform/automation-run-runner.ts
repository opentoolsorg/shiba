/**
 * Automation run workflow steps (prepare → approval gate → dispatch → terminal).
 * When AUTOMATION_RUN_WORKFLOW is bound (WS01), starts a durable instance;
 * otherwise runs inline for tests and pre-WS01 deploys.
 */
import type { Env } from "../env.js";
import { automationsEnabled, type Automation } from "../automations.js";
import { insertAutomationWorkflowRun, patchAutomationWorkflowRun } from "./automation-workflow-store.js";
import { emitWebhookEvent } from "../webhooks/producer.js";

export interface AutomationRunWorkflowInput {
  automation: Automation;
  commandId: string;
  threadKey: string;
  repoUrl: string;
  task: string;
  publishPullRequest: boolean;
  unattendedApproved: boolean;
  queueRun: (input: {
    repoUrl: string;
    task: string;
    publishPullRequest: boolean;
    threadKey: string;
    commandId?: string;
  }) => Promise<{ approvalId: string; runId?: string }>;
}

export interface AutomationRunWorkflowResult {
  workflowRunId: string;
  approvalId?: string;
  runId?: string;
  status: "awaiting_approval" | "dispatched" | "failed";
}

export async function startAutomationRunWorkflow(
  env: Env,
  input: AutomationRunWorkflowInput,
): Promise<AutomationRunWorkflowResult> {
  const workflowRun = await insertAutomationWorkflowRun(env, {
    automationId: input.automation.id,
    commandId: input.commandId,
    workflowInstanceId: env.AUTOMATION_RUN_WORKFLOW
      ? await tryStartWorkflowBinding(env, input)
      : undefined,
  });
  if (!automationsEnabled(env.AUTOMATIONS_ENABLED)) {
    await patchAutomationWorkflowRun(env, workflowRun.id, { status: "failed", error: "automations_disabled" });
    return { workflowRunId: workflowRun.id, status: "failed" };
  }
  if (!input.unattendedApproved) {
    await patchAutomationWorkflowRun(env, workflowRun.id, { status: "awaiting_approval" });
  }
  try {
    const queued = await input.queueRun({
      repoUrl: input.repoUrl,
      task: input.task,
      publishPullRequest: input.publishPullRequest,
      threadKey: input.threadKey,
      commandId: input.commandId,
    });
    await patchAutomationWorkflowRun(env, workflowRun.id, {
      status: "dispatched",
      approval_id: queued.approvalId,
      run_id: queued.runId ?? null,
    });
    if (input.automation.terminalWebhook) {
      await emitWebhookEvent(env, "self-hosted", "automation.finished", {
        automationId: input.automation.id,
        commandId: input.commandId,
        approvalId: queued.approvalId,
      });
    }
    return { workflowRunId: workflowRun.id, approvalId: queued.approvalId, runId: queued.runId, status: "dispatched" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await patchAutomationWorkflowRun(env, workflowRun.id, { status: "failed", error: message });
    return { workflowRunId: workflowRun.id, status: "failed" };
  }
}

async function tryStartWorkflowBinding(env: Env, input: AutomationRunWorkflowInput): Promise<string | undefined> {
  if (!env.AUTOMATION_RUN_WORKFLOW?.create) return undefined;
  try {
    const instance = await env.AUTOMATION_RUN_WORKFLOW.create({
      params: {
        automationId: input.automation.id,
        runId: input.commandId,
        commandId: input.commandId,
      },
    });
    return instance.id;
  } catch {
    return undefined;
  }
}