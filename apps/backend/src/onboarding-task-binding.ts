import {
  draftTaskReferenceSchema, onboardingSourceSnapshotSchema, onboardingTaskText,
  type OnboardingRunFields,
} from "@shiba/shared";
import type { Env } from "./env.js";
import { ownerMemoryStub } from "./memory-do.js";
import { resolvePreparedOnboardingDraft } from "./onboarding-progress.js";

/** Explicit malformed hints must fail, never fall back to an ordinary task. */
export function readDraftTaskReference(value: unknown): { draftTaskId: string; draftTaskVersion: number } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const body = value as Record<string, unknown>;
  if (!Object.hasOwn(body, "draftTaskId") && !Object.hasOwn(body, "draftTaskVersion")) return undefined;
  const parsed = draftTaskReferenceSchema.safeParse({ draftTaskId: body.draftTaskId, draftTaskVersion: body.draftTaskVersion });
  if (!parsed.success) throw new Error("Invalid onboarding goal reference. Resume setup and prepare the first task again.");
  return parsed.data;
}

export async function resolveOnboardingTaskBinding(
  env: Env, owner: string | undefined, task: unknown, raw: unknown, selectedEmployeeId?: unknown,
): Promise<(OnboardingRunFields & { customAgentId: string; canonicalTask: string }) | undefined> {
  const reference = readDraftTaskReference(raw);
  if (!reference) return undefined;
  if (!owner) throw new Error("An onboarding goal requires an authenticated owner.");
  const draft = await resolvePreparedOnboardingDraft(env, owner, { draftTaskId: reference.draftTaskId, version: reference.draftTaskVersion });
  if (!draft) throw new Error("The onboarding goal, employee or selected sources changed. Resume setup and prepare it again.");
  const canonicalTask = onboardingTaskText(draft.draftTask);
  if (task !== canonicalTask) throw new Error("The task must exactly match the prepared onboarding brief. Edit and prepare the goal before retrying.");
  const employeeId = draft.draftTask.employeeId;
  if (!employeeId || (selectedEmployeeId !== undefined && selectedEmployeeId !== employeeId)) {
    throw new Error("The selected employee does not match the prepared onboarding goal.");
  }
  let onboardingSourceSnapshot = { sources: [] } as ReturnType<typeof onboardingSourceSnapshotSchema.parse>;
  if (draft.draftTask.sourceIds.length) {
    const stub = await ownerMemoryStub(env, owner);
    const response = await stub.fetch("https://internal/internal/memory/sources/snapshot", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceIds: draft.draftTask.sourceIds, expectedRefs: draft.draftTask.sourceRefs }),
    });
    const body = await response.json().catch(() => ({})) as { snapshot?: unknown };
    if (!response.ok) throw new Error("Selected sources changed or are unavailable. Review the sources and prepare the goal again.");
    const snapshot = onboardingSourceSnapshotSchema.safeParse(body.snapshot);
    if (!snapshot.success) throw new Error("Selected source context is invalid or exceeds 8 KiB. Choose fewer sources and prepare again.");
    onboardingSourceSnapshot = snapshot.data;
    const refs = snapshot.data.sources.map(({ id, version, sha256 }) => ({ id, version, sha256 }));
    if (JSON.stringify(refs) !== JSON.stringify(draft.draftTask.sourceRefs)) throw new Error("Selected source versions changed.");
    if (!await resolvePreparedOnboardingDraft(env, owner, { draftTaskId: reference.draftTaskId, version: reference.draftTaskVersion })) {
      throw new Error("The onboarding goal changed while sources were read. Prepare it again.");
    }
  }
  return { ...reference, onboardingSourceSnapshot, customAgentId: employeeId, canonicalTask };
}

/** Revalidate authority without replacing approved source bytes with newer content. */
export async function revalidateOnboardingBinding(env: Env, owner: string | undefined, binding: OnboardingRunFields): Promise<void> {
  const reference = readDraftTaskReference(binding);
  if (!reference) {
    if (binding.onboardingSourceSnapshot !== undefined) throw new Error("Source context requires a validated onboarding goal.");
    return;
  }
  if (!owner) throw new Error("An onboarding goal requires an authenticated owner.");
  const draft = await resolvePreparedOnboardingDraft(env, owner, { draftTaskId: reference.draftTaskId, version: reference.draftTaskVersion });
  const snapshot = onboardingSourceSnapshotSchema.safeParse(binding.onboardingSourceSnapshot);
  if (!draft || !snapshot.success || JSON.stringify(snapshot.data.sources.map(({ id, version, sha256 }) => ({ id, version, sha256 }))) !== JSON.stringify(draft.draftTask.sourceRefs)) {
    throw new Error("The approved onboarding goal or source versions changed. Prepare a new task for review.");
  }
}
