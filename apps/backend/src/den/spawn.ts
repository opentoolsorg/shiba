import {
  canSpawnSubagentAt,
  denIdWireFields,
  directChildPaths,
  nextSubagentPath,
  resolveDenId,
  resolveSubagentSandboxId,
  type SubagentSandboxMode,
} from "@shiba/shared";
import { runInputHash, type ApprovalEvidence, type PendingApproval } from "@shiba/shared";
import { makeSandboxId } from "../security.js";
import { createRun, type DecisionTap, type DelegatedRun } from "../runs.js";

export interface SpawnSubagentInput {
  parentRunId: string;
  task: string;
  sandboxMode: SubagentSandboxMode;
  publishPullRequest?: boolean;
  reviewAfterPublish?: boolean;
  role?: DelegatedRun["role"];
}

export type SpawnSubagentResult =
  | { ok: true; run: DelegatedRun; callId: string }
  | { ok: false; error: string; status: number };

export function mintSubagentRun(args: {
  runs: DelegatedRun[];
  parent: DelegatedRun;
  input: SpawnSubagentInput;
  callId: string;
  denId?: string;
  /** @deprecated Use denId */
  captainId?: string;
  budgetApproval?: Pick<PendingApproval, "approvalId" | "decidedBy" | "decidedAt" | "subagentBudget">;
  parentBudgetRemaining?: number;
  decisionTap?: DecisionTap;
}): SpawnSubagentResult {
  const parent = args.parent;
  if (parent.runId !== args.input.parentRunId) {
    return { ok: false, error: "Parent run mismatch.", status: 400 };
  }
  const parentPath = parent.subagentPath;
  if (!canSpawnSubagentAt(parentPath)) {
    return { ok: false, error: `Subagent depth cap (${3}) reached.`, status: 400 };
  }
  const childPaths = directChildPaths(parentPath, args.runs);
  const path = nextSubagentPath(parentPath, childPaths);
  const freshSandboxId = makeSandboxId(parent.repoUrl, args.input.task, args.callId);
  const sandboxId = resolveSubagentSandboxId(parent, args.input.sandboxMode, freshSandboxId);
  const denId = args.denId ?? args.captainId ?? resolveDenId(parent);
  const fields = {
    repoUrl: parent.repoUrl,
    task: args.input.task,
    baseBranch: parent.baseBranch,
    publishPullRequest: args.input.publishPullRequest ?? false,
    ...(args.input.reviewAfterPublish !== undefined ? { reviewAfterPublish: args.input.reviewAfterPublish } : {}),
    parentRunId: parent.runId,
    subagentPath: path,
    subagentSandbox: args.input.sandboxMode,
    ...denIdWireFields(denId),
    ...(parent.route ? { route: parent.route } : {}),
    ...(args.input.role !== undefined ? { role: args.input.role } : {}),
  };
  let approval: ApprovalEvidence | undefined;
  let subagentBudgetRemaining: number | undefined;
  if (args.budgetApproval && args.parentBudgetRemaining !== undefined && args.parentBudgetRemaining > 0) {
    subagentBudgetRemaining = args.parentBudgetRemaining - 1;
    approval = {
      approvalId: args.budgetApproval.approvalId,
      decidedBy: args.budgetApproval.decidedBy ?? "budget",
      decidedAt: args.budgetApproval.decidedAt ?? Date.now(),
      inputHash: runInputHash({
        repoUrl: fields.repoUrl,
        task: fields.task,
        baseBranch: fields.baseBranch,
        publishPullRequest: fields.publishPullRequest,
        ...(fields.reviewAfterPublish !== undefined ? { reviewAfterPublish: fields.reviewAfterPublish } : {}),
        ...(fields.route ? { route: fields.route } : {}),
        parentRunId: fields.parentRunId,
        subagentPath: fields.subagentPath,
        subagentSandbox: fields.subagentSandbox,
        ...denIdWireFields(denId),
        ...(fields.role !== undefined ? { role: fields.role } : {}),
      }),
    };
  }
  let run = createRun({
    runId: `agent-tool:${args.callId}`,
    sandboxId,
    ...fields,
    ...(approval ? { approval } : {}),
    decisionTap: args.decisionTap,
  });
  if (subagentBudgetRemaining !== undefined) {
    run = { ...run, subagentBudgetRemaining };
  }
  if (!approval) {
    return {
      ok: false,
      error: "Subagent spawn requires approval or a remaining subagent budget on the parent plan.",
      status: 403,
    };
  }
  return { ok: true, run, callId: args.callId };
}
