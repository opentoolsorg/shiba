/**
 * Workflow entry stubs declared for WS05 (Slack import) and WS09
 * (automation runs). Bodies are intentionally empty until those workstreams land.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env.js";

export type SlackImportInput = { workspaceId: string; channelId: string; cursor?: string };
export type AutomationRunInput = { automationId: string; runId: string; commandId?: string };

export class SlackImportWorkflow extends WorkflowEntrypoint<Env, SlackImportInput> {
  async run(_event: WorkflowEvent<SlackImportInput>, step: WorkflowStep): Promise<void> {
    await step.do("slack-import-stub", async () => ({ ok: true as const }));
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