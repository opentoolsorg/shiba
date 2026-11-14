/**
 * Workflow entry stubs declared for WS05 (Slack import) and WS09
 * (automation runs). Bodies are intentionally empty until those workstreams land.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env.js";

export type SlackImportInput = { workspaceId: string; channelId: string; cursor?: string };
export type AutomationRunInput = { automationId: string; runId: string };

export class SlackImportWorkflow extends WorkflowEntrypoint<Env, SlackImportInput> {
  async run(_event: WorkflowEvent<SlackImportInput>, step: WorkflowStep): Promise<void> {
    await step.do("slack-import-stub", async () => ({ ok: true as const }));
  }
}

export class AutomationRunWorkflow extends WorkflowEntrypoint<Env, AutomationRunInput> {
  async run(_event: WorkflowEvent<AutomationRunInput>, step: WorkflowStep): Promise<void> {
    await step.do("automation-run-stub", async () => ({ ok: true as const }));
  }
}