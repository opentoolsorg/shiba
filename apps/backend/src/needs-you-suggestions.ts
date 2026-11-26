import type { OnboardingStatus } from "@shiba/shared";

export const SUGGESTION_LIMIT = 3;
export const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_APPROVAL_MS = 24 * 60 * 60 * 1000;
const ROUTINE_MIN_RUNS = 3;
const ROUTINE_SIMILARITY = 0.8;

export interface SuggestionRun { runId: string; task: string; status: string; createdAt: number; archivedAt?: number; queuedBy?: string; parentRunId?: string; reviewOf?: string; slackCommandOrigin?: string }

export interface NeedsYouSuggestion {
  id: string;
  kind: "retry" | "routine" | "setup" | "approvals";
  title: string;
  detail: string;
  /** compose prefills the task composer (still approval-gated); open navigates to a view. */
  action: { kind: "compose" | "open"; payload: Record<string, string> };
}

export interface SuggestionInput {
  runs: readonly SuggestionRun[];
  approvals: ReadonlyArray<{ createdAt?: number }>;
  onboarding: OnboardingStatus | null;
  dismissedIds: ReadonlySet<string>;
  now: number;
}

const clip = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const words = (text: string) => new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean));

function similar(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared) >= ROUTINE_SIMILARITY;
}

function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0;
  return hash.toString(36);
}

export function buildSuggestions(input: SuggestionInput): NeedsYouSuggestion[] {
  const { now } = input;
  const out: NeedsYouSuggestion[] = [];
  const live = input.runs.filter((run) => !run.archivedAt && run.task.trim());

  const stale = input.approvals.filter((a) => typeof a.createdAt === "number" && now - a.createdAt > STALE_APPROVAL_MS);
  if (stale.length > 0) {
    out.push({
      id: "approvals:stale", kind: "approvals",
      title: `${stale.length} approval${stale.length === 1 ? " is" : "s are"} waiting`,
      detail: "Waiting for more than a day. Nothing runs until you approve.",
      action: { kind: "open", payload: { view: "threads" } },
    });
  }

  for (const run of live) {
    if ((run.status !== "error" && run.status !== "cancelled" && run.status !== "aborted") || now - run.createdAt > RETRY_WINDOW_MS) continue;
    out.push({
      id: `retry:${run.runId}`, kind: "retry", title: `Retry "${clip(run.task)}"?`,
      detail: `This task ${run.status === "error" ? "failed" : "was cancelled"}. Retrying opens the composer; you still approve it.`,
      action: { kind: "compose", payload: { task: run.task } },
    });
  }

  const groups: Array<{ seed: string; tokens: Set<string>; count: number }> = [];
  for (const run of live) {
    if (run.queuedBy || run.parentRunId || run.reviewOf || run.slackCommandOrigin) continue;
    const tokens = words(run.task);
    const group = groups.find((g) => similar(g.tokens, tokens));
    if (group) group.count += 1; else groups.push({ seed: run.task, tokens, count: 1 });
  }
  for (const group of groups) {
    if (group.count < ROUTINE_MIN_RUNS) continue;
    out.push({
      id: `routine:${fnv([...group.tokens].sort().join(" "))}`, kind: "routine", title: `Make "${clip(group.seed)}" a routine?`,
      detail: `You ran this ${group.count} times. A routine still asks for approval before each run.`,
      action: { kind: "compose", payload: { task: group.seed, automation: "1" } },
    });
  }

  const next = input.onboarding && !input.onboarding.complete ? input.onboarding.nextStep : null;
  if (next) {
    out.push({
      id: `setup:${next.id}`, kind: "setup", title: `Finish setup: ${next.label}`,
      detail: "One step left on your setup checklist.",
      action: { kind: "open", payload: { view: next.target.kind === "view" ? next.target.view : "home", step: next.id } },
    });
  }

  return out.filter((item) => !input.dismissedIds.has(item.id)).slice(0, SUGGESTION_LIMIT);
}

export interface NeedsYouDismissalStore {
  readDismissedIds(ownerId: string, now: number): Promise<Set<string>>;
  dismissSuggestion(ownerId: string, suggestionId: string, now: number): Promise<void>;
}
