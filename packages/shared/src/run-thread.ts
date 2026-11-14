/**
 * Every task and run has a thread: an instant acknowledgement, milestone
 * updates (result, decision, blocker), then a final result that is the
 * deliverable. Approvals sit inline with a frozen payload. A denial is final.
 * Questions carry two to four one-line options.
 */
export type ThreadOwnerKind = "human" | "agent";

export interface ThreadOwner {
  kind: ThreadOwnerKind;
  id: string;
  label: string;
}

export type ThreadMilestone = "result" | "decision" | "blocker";

export interface ThreadAck {
  id: string;
  kind: "ack";
  at: number;
  text: string;
  owner: ThreadOwner;
}

export interface ThreadMilestoneMessage {
  id: string;
  kind: "milestone";
  at: number;
  milestone: ThreadMilestone;
  text: string;
}

export interface ThreadResultMessage {
  id: string;
  kind: "result";
  at: number;
  text: string;
}

export interface ThreadApprovalMessage {
  id: string;
  kind: "approval";
  at: number;
  approvalId: string;
  frozenPayload: unknown;
  status: "pending" | "approved" | "denied";
}

export interface ThreadQuestionMessage {
  id: string;
  kind: "question";
  at: number;
  askId: string;
  prompt: string;
  options: [string, string, ...string[]];
}

export interface ThreadDenialMessage {
  id: string;
  kind: "denial";
  at: number;
  approvalId: string;
  final: true;
  text: string;
}

export type RunThreadMessage =
  | ThreadAck
  | ThreadMilestoneMessage
  | ThreadResultMessage
  | ThreadApprovalMessage
  | ThreadQuestionMessage
  | ThreadDenialMessage;

export interface RunThreadSource {
  runId: string;
  task: string;
  createdAt: number;
  updatedAt: number;
  status: string;
  summary?: string;
  owner: ThreadOwner;
  signals?: ReadonlyArray<{ kind: string; at: number; detail?: string }>;
  approvals?: ReadonlyArray<{
    approvalId: string;
    createdAt: number;
    status: string;
    payload: unknown;
  }>;
  question?: { askId: string; prompt: string; options: string[]; at: number } | null;
}

const MILESTONE_SIGNALS = new Set(["pr.opened", "checkpoint.captured", "run.failed", "ask_user.pending"]);

function milestoneFromSignal(kind: string): ThreadMilestone | null {
  if (kind === "pr.opened" || kind === "checkpoint.captured") return "result";
  if (kind === "ask_user.pending") return "decision";
  if (kind === "run.failed" || kind === "e2e.failed") return "blocker";
  return null;
}

/** Denial closes the approval. The same payload cannot be re-opened. */
export function denialIsFinal(status: string): boolean {
  return status === "denied" || status === "rejected";
}

export function projectRunThread(source: RunThreadSource): RunThreadMessage[] {
  const messages: RunThreadMessage[] = [
    {
      id: `${source.runId}:ack`,
      kind: "ack",
      at: source.createdAt,
      text: `Got it. Working on: ${source.task}`,
      owner: source.owner,
    },
  ];
  for (const signal of source.signals ?? []) {
    if (!MILESTONE_SIGNALS.has(signal.kind) && milestoneFromSignal(signal.kind) === null) continue;
    const milestone = milestoneFromSignal(signal.kind);
    if (!milestone) continue;
    messages.push({
      id: `${source.runId}:${signal.kind}:${signal.at}`,
      kind: "milestone",
      at: signal.at,
      milestone,
      text: signal.detail?.trim() || signal.kind,
    });
  }
  for (const approval of source.approvals ?? []) {
    const denied = denialIsFinal(approval.status);
    messages.push({
      id: `${source.runId}:approval:${approval.approvalId}`,
      kind: "approval",
      at: approval.createdAt,
      approvalId: approval.approvalId,
      frozenPayload: approval.payload,
      status: denied ? "denied" : approval.status === "approved" ? "approved" : "pending",
    });
    if (denied) {
      messages.push({
        id: `${source.runId}:denial:${approval.approvalId}`,
        kind: "denial",
        at: approval.createdAt,
        approvalId: approval.approvalId,
        final: true,
        text: "Denied. This decision is final.",
      });
    }
  }
  const question = source.question;
  if (question && question.options.length >= 2 && question.options.length <= 4) {
    messages.push({
      id: `${source.runId}:question:${question.askId}`,
      kind: "question",
      at: question.at,
      askId: question.askId,
      prompt: question.prompt,
      options: question.options as [string, string, ...string[]],
    });
  }
  if (source.status === "completed" && source.summary?.trim()) {
    messages.push({
      id: `${source.runId}:result`,
      kind: "result",
      at: source.updatedAt,
      text: source.summary.trim(),
    });
  }
  return messages.sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
}