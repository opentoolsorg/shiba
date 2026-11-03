/** Private parent dispatch snapshots authorize attachment, never a new execution. */
import { runInputHash, type DelegatedRun } from "@shiba/shared";
import { assertChildDispatchAuthorized } from "./child-dispatch.js";
import type { Env } from "./env.js";
import { formatAgentToolInput, parseAgentToolInput, type CodingTaskInput } from "./opencode-input.js";

export const PARENT_RECOVERY_PREFIX = "execution-recovery:parent:";
const MAX_RECORD_BYTES = 120_000;

export interface ParentExecutionRecovery {
  version: 1;
  owner: string;
  generation: number;
  toolCallId: string;
  input: CodingTaskInput;
}

export function parentRecoveryKey(runId: string): string {
  return `${PARENT_RECOVERY_PREFIX}${runId}`;
}

export async function validateParentExecutionRecovery(
  env: Pick<Env, "INTERNAL_SIGNING_KEY" | "MODEL_CREDENTIAL_KEY">,
  owner: string,
  run: DelegatedRun,
  value: unknown,
  now = Date.now(),
): Promise<ParentExecutionRecovery | null> {
  try {
    if (!value || typeof value !== "object" || new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_RECORD_BYTES) return null;
    const record = value as ParentExecutionRecovery;
    if (record.version !== 1 || record.owner !== owner || record.generation !== run.generation ||
        !record.toolCallId || run.runId !== `agent-tool:${record.toolCallId}` || run.status !== "running" ||
        run.checkpoint !== "executing" || run.runtime === "local" || run.pullUrl || run.forkedFrom ||
        !run.approval || run.approval.approvalId !== record.toolCallId || run.approval.inputHash !== runInputHash(run)) return null;
    const input = parseAgentToolInput([{ role: "user", text: formatAgentToolInput(record.input) }]);
    if (input.accessAgent !== owner || input.dispatchApprovalId !== record.toolCallId ||
        input.dispatchInputHash !== run.approval.inputHash || input.sandboxId !== run.sandboxId ||
        input.runtime !== "sandbox" || (input.sandboxProvider !== undefined && input.sandboxProvider !== "cloudflare") ||
        input.repoUrl !== run.repoUrl || input.task !== run.task || input.baseBranch !== run.baseBranch ||
        input.publishPullRequest !== run.publishPullRequest ||
        (input.publishPullRequest && input.deferPullRequestPublish !== true) || !input.route) return null;
    await assertChildDispatchAuthorized(env, input, now);
    return { ...record, input };
  } catch {
    return null;
  }
}
