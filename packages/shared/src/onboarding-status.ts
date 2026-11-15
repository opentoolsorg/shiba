export type OnboardingNudgeStepId =
  | "goal" | "audience" | "acceptance" | "employee" | "review"
  | "provider" | "first-run" | "accept-deliverable";

export type OnboardingNudgeTarget =
  | { kind: "setup"; outcomeStep: "goal" | "audience" | "acceptance" | "employee" | "review" }
  | { kind: "view"; view: "providers" | "custom-agents" | "threads" | "work" };

export interface OnboardingStepStatus {
  id: OnboardingNudgeStepId;
  label: string;
  complete: boolean;
  optional?: boolean;
  target: OnboardingNudgeTarget;
}

export interface OnboardingStatus {
  complete: boolean;
  nextStep: OnboardingStepStatus | null;
  remaining: OnboardingStepStatus[];
  steps: OnboardingStepStatus[];
}

/** Structural input shared by the authenticated route and its browser snapshot. */
export interface OnboardingStatusInput {
  draftTaskId?: string | null;
  draftTask?: {
    goal: string;
    audience: string;
    acceptance: string;
    completedSteps: readonly string[];
    skippedSteps: readonly string[];
    employeeId: string | null;
    employeeVersion: number | null;
    employeeTemplateId: string | null;
    preparedAt: number | null;
  } | null;
  dismissedAt: number | null;
  connectionVerifiedAt: number | null;
  firstSuccessfulRunAt: number | null;
  activatedAt: number | null;
  evidence: {
    connectedProvider: boolean | null;
    successfulRun: boolean | null;
    acceptedDeliverable: boolean | null;
  };
}

/** Dismissal never earns activation; only the server's accepted-artifact timestamp does. */
export function deriveOnboardingStatus(input: OnboardingStatusInput): OnboardingStatus {
  const draft = input.draftTask;
  const complete = input.activatedAt != null;
  const briefSteps = ([
    ["goal", "Describe your goal"],
    ["audience", "Choose your audience"],
    ["acceptance", "Define a good result"],
  ] as const).map(([id, label]): OnboardingStepStatus => ({
    id, label,
    complete: Boolean(draft && (draft[id].trim() || draft.completedSteps.includes(id))),
    target: { kind: "setup", outcomeStep: id },
  }));
  const employee: OnboardingStepStatus = {
    id: "employee", label: "Save your chosen employee", optional: true,
    complete: Boolean(draft?.employeeId && draft.employeeVersion != null),
    target: draft?.employeeTemplateId
      ? { kind: "view", view: "custom-agents" }
      : { kind: "setup", outcomeStep: "employee" },
  };
  const steps: OnboardingStepStatus[] = [
    ...briefSteps,
    employee,
    { id: "review", label: "Review your first task", complete: Boolean(draft?.preparedAt != null && input.draftTaskId), target: { kind: "setup", outcomeStep: "review" } },
    { id: "provider", label: "Connect a provider", complete: input.evidence?.connectedProvider === true || input.connectionVerifiedAt != null, target: { kind: "view", view: "providers" } },
    { id: "first-run", label: "Run your first task", complete: input.evidence?.successfulRun === true || input.firstSuccessfulRunAt != null, target: { kind: "view", view: "threads" } },
    { id: "accept-deliverable", label: "Approve your first deliverable", complete, target: { kind: "view", view: "work" } },
  ];
  const remaining = complete ? [] : steps.filter((step) => !step.optional && !step.complete);
  // A pending choice offers employee creation before preparation, unless it was skipped.
  const pendingEmployee = !complete && !employee.complete && draft?.employeeTemplateId
    && !draft.skippedSteps.includes("employee") && briefSteps.every((step) => step.complete)
    && draft.preparedAt === null;
  return { complete, steps, remaining, nextStep: complete ? null : pendingEmployee ? employee : remaining[0] ?? null };
}
