import {
  canSpawnSubagentAt,
  MAX_SUBAGENT_DEPTH,
  MAX_SUBAGENT_CHILDREN,
  isActiveStatus,
  directChildPaths,
  nextSubagentPath,
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
  captainId?: string;
  /** When set, reuse this approval instead of minting a new card. */
  budgetApproval?: Pick<PendingApproval, "approvalId" | "decidedBy" | "decidedAt" | "subagentBudget">;
  parentBudgetRemaining?: number;
  /** Human approval of this exact frozen child task. Aggregate budget is not approval. */
  childApproval?: ApprovalEvidence;
  decisionTap?: DecisionTap;
}): SpawnSubagentResult {
  const parent = args.parent;
  if (parent.runId !== args.input.parentRunId) {
    return { ok: false, error: "Parent run mismatch.", status: 400 };
  }
  if (!isActiveStatus(parent.status)) {
    return { ok: false, error: "Only active runs can spawn subagents.", status: 409 };
  }
  if (args.input.sandboxMode !== "fresh") {
    return { ok: false, error: "Child agents require an isolated workspace.", status: 400 };
  }
  if (args.input.publishPullRequest === true || args.input.reviewAfterPublish === true) {
    return { ok: false, error: "Child agents cannot publish external writes.", status: 403 };
  }
  const children = args.runs.filter((run) => run.parentRunId === parent.runId);
  if (children.length >= MAX_SUBAGENT_CHILDREN || children.some((run) => isActiveStatus(run.status))) {
    return { ok: false, error: "Child task capacity reached.", status: 429 };
  }
  const parentPath = parent.subagentPath;
  if (parent.parentRunId !== undefined || !canSpawnSubagentAt(parentPath)) {
    return { ok: false, error: `Subagent depth cap (${MAX_SUBAGENT_DEPTH}) reached.`, status: 400 };
  }
  const childPaths = directChildPaths(parentPath, children);
  const path = nextSubagentPath(parentPath, childPaths);
  const freshSandboxId = makeSandboxId(parent.repoUrl, args.input.task, args.callId);
  const sandboxId = resolveSubagentSandboxId(parent, args.input.sandboxMode, freshSandboxId);
  const fields = {
    repoUrl: parent.repoUrl,
    task: args.input.task,
    baseBranch: parent.baseBranch,
    publishPullRequest: args.input.publishPullRequest ?? false,
    parentRunId: parent.runId,
    subagentPath: path,
    subagentSandbox: args.input.sandboxMode,
    ...(args.captainId ? { captainId: args.captainId } : {}),
    ...(parent.route ? { route: parent.route } : {}),
    ...(args.input.role !== undefined ? { role: args.input.role } : {}),
  };
  const approval = args.childApproval;
  if (!approval?.decidedBy || approval.inputHash !== runInputHash({
    repoUrl: fields.repoUrl,
    task: fields.task,
    baseBranch: fields.baseBranch,
    publishPullRequest: false,
    ...(fields.route ? { route: fields.route } : {}),
    parentRunId: fields.parentRunId,
    subagentPath: fields.subagentPath,
    subagentSandbox: fields.subagentSandbox,
    ...(fields.captainId ? { captainId: fields.captainId } : {}),
    ...(fields.role !== undefined ? { role: fields.role } : {}),
  })) {
    return { ok: false, error: "This child task requires explicit human approval of its frozen input.", status: 403 };
  }
  const run = createRun({
    runId: `agent-tool:${args.callId}`,
    sandboxId,
    ...fields,
    approval,
    decisionTap: args.decisionTap,
  });
  return { ok: true, run, callId: args.callId };
}
