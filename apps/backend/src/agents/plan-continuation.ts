export interface PlanStep {
  step: string;
  status: "pending" | "in_progress" | "done";
}

export interface ContinuationState {
  requestId: string;
  messageIds: string[];
  count: number;
  plan: PlanStep[];
  lastResponseId?: string;
}

export function continuationDecision(input: {
  text: string;
  plan: readonly PlanStep[];
  count: number;
  pendingApproval: boolean;
  limitReached: boolean;
  completed: boolean;
}): { continue: boolean; reason: string } {
  if (!input.completed) return { continue: false, reason: "turn_not_completed" };
  if (input.pendingApproval) return { continue: false, reason: "pending_approval" };
  if (input.limitReached || /\b(?:budget|usage|rate|token|quota)\b.{0,50}\b(?:limit|exhausted|exceeded|reached)\b/i.test(input.text)) {
    return { continue: false, reason: "usage_limit" };
  }
  if (input.count >= 3) return { continue: false, reason: "continuation_cap" };
  if (/\b(?:proceed|go ahead|approv\w*|confirm\w*|permission)\b/i.test(input.text)) {
    return { continue: false, reason: "approval_language" };
  }
  const lastLine = input.text.trim().split(/\n/).at(-1)?.trim() ?? "";
  const sameWorkQuestion = /^(?:shall I|should I|can I|want me to|would you like me to) (?:continue|keep going)(?: (?:with (?:the )?(?:same work|remaining steps)|the same work))?\?$/i.test(lastLine);
  const otherText = sameWorkQuestion ? input.text.trim().slice(0, -lastLine.length) : input.text;
  if (/\?|\b(?:shall|should|can|may|could) I\b|\b(?:want|like) me to\b/i.test(otherText)) {
    return { continue: false, reason: "new_action_or_question" };
  }
  if (input.plan.some((step) => step.status !== "done")) return { continue: true, reason: "open_plan_steps" };
  if (input.text.trim().length <= 500 && sameWorkQuestion) return { continue: true, reason: "continue_question" };
  return { continue: false, reason: "nothing_to_continue" };
}
