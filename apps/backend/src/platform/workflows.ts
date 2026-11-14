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

export type AutomationRunInput = { automationId: string; runId: string };

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
  async run(_event: WorkflowEvent<AutomationRunInput>, step: WorkflowStep): Promise<void> {
    await step.do("automation-run-stub", async () => ({ ok: true as const }));
  }
}