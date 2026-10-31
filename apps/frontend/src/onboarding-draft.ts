import type { EmployeeTemplate } from "./employee-templates";

export const OUTCOME_STEPS = ["goal", "audience", "acceptance", "role", "help", "employee", "context", "connections", "review"] as const;
export type OutcomeStepId = typeof OUTCOME_STEPS[number];

/** Browser mirror of the authenticated onboarding-progress DTO. No execution authority. */
export interface OnboardingDraft {
  schemaVersion: 2;
  version: number;
  currentStep: OutcomeStepId;
  goal: string;
  audience: string;
  acceptance: string;
  roleAnswer: string;
  helpAnswer: string;
  employeeAnswer: string;
  contextAnswer: string;
  connectionAnswer: string;
  employeeId: string | null;
  employeeVersion: number | null;
  employeeTemplateId: EmployeeTemplate["id"] | null;
  employeeTemplateVersion: 1 | null;
  sourceIds: string[];
  sourceRefs: { id: string; version: number; sha256: string }[];
  completedSteps: OutcomeStepId[];
  skippedSteps: OutcomeStepId[];
  preparedAt: number | null;
}

export type OnboardingDraftPatch = Partial<Omit<OnboardingDraft, "schemaVersion" | "sourceRefs" | "version" | "preparedAt">>;
export interface SelectedOnboardingDraft {
  draftTaskId: string;
  version: number;
  draftTask: OnboardingDraft;
}
export type OnboardingDraftRef = Pick<SelectedOnboardingDraft, "draftTaskId" | "version">;
export function isOnboardingDraftRef(value: unknown): value is OnboardingDraftRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Partial<OnboardingDraftRef>;
  return typeof ref.draftTaskId === "string" && /^draft_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ref.draftTaskId) && Number.isSafeInteger(ref.version) && Number(ref.version) > 0;
}

export const EMPTY_ONBOARDING_DRAFT: OnboardingDraft = {
  schemaVersion: 2, sourceRefs: [], version: 0, currentStep: "goal", goal: "", audience: "", acceptance: "", roleAnswer: "", helpAnswer: "",
  employeeAnswer: "", contextAnswer: "", connectionAnswer: "", employeeId: null, employeeVersion: null,
  employeeTemplateId: null, employeeTemplateVersion: null, sourceIds: [], completedSteps: [], skippedSteps: [], preparedAt: null,
};

