/**
 * Slack history import (paged) and the automation-run placeholder.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env.js";
import {
  getSlackImportJob,
  mockSlackHistoryPager,
  processSlackImportPage,
  type SlackImportJobRow,
} from "../slack-import/store.js";

export type SlackImportWorkflowParams = {
  jobId: string;
  tenantId: string;
  workspaceId: string;
};

export type AutomationRunInput = { automationId: string; runId: string; commandId?: string };

export class SlackImportWorkflow extends WorkflowEntrypoint<Env, SlackImportWorkflowParams> {
  async run(event: WorkflowEvent<SlackImportWorkflowParams>, step: WorkflowStep): Promise<void> {
    const { jobId, tenantId, workspaceId } = event.payload;
    let job: SlackImportJobRow | null = await getSlackImportJob(this.env, tenantId, workspaceId, jobId);
    if (!job) return;
    for (let guard = 0; guard < 64; guard += 1) {
      const current: SlackImportJobRow = job;
      job = await step.do(`page-${guard}`, async (): Promise<SlackImportJobRow> =>
        processSlackImportPage(
          this.env,
          current,
          mockSlackHistoryPager,
          Date.now(),
          async (message) => `slack_import_${message.ts.replace(/\./g, "_")}`,
        ),
      );
      if (job.status === "completed" || job.status === "cancelled" || job.status === "failed") break;
      if (!job.cursorTs) break;
    }
  }
}

export class AutomationRunWorkflow extends WorkflowEntrypoint<Env, AutomationRunInput> {
  async run(event: WorkflowEvent<AutomationRunInput>, step: WorkflowStep): Promise<void> {
    const commandId = event.payload.commandId ?? event.payload.runId;
    await step.do("prepare", async () => {
      const { patchAutomationWorkflowRun } = await import("./automation-workflow-store.js");
      const rows = await this.env.AGENT_AUDIT.prepare(
        `SELECT id FROM automation_workflow_runs WHERE automation_id=? AND command_id=? ORDER BY created_at DESC LIMIT 1`,
      ).bind(event.payload.automationId, commandId).all<{ id: string }>();
      const id = rows.results?.[0]?.id;
      if (id) {
        await patchAutomationWorkflowRun(this.env, id, {
          workflow_instance_id: event.instanceId,
          status: "preparing",
        });
      }
      return { ok: true as const };
    });
    await step.do("await-approval-gate", async () => ({ ok: true as const }));
    await step.do("dispatch-run", async () => ({ ok: true as const }));
    await step.do("wait-for-terminal", async () => ({ ok: true as const }));
    await step.do("record-terminal", async () => {
      const { patchAutomationWorkflowRun } = await import("./automation-workflow-store.js");
      const rows = await this.env.AGENT_AUDIT.prepare(
        `SELECT id FROM automation_workflow_runs WHERE automation_id=? AND command_id=? ORDER BY created_at DESC LIMIT 1`,
      ).bind(event.payload.automationId, commandId).all<{ id: string }>();
      const id = rows.results?.[0]?.id;
      if (id) await patchAutomationWorkflowRun(this.env, id, { status: "terminal" });
      return { ok: true as const };
    });
  }
}