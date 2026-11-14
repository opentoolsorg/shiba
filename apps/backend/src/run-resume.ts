/**
 * What a Durable Object restart may do with an active run. Pre-sandbox
 * checkpoints are re-dispatched under the same frozen approval. Anything
 * that may have touched git or a container becomes unknown.
 */
import type { DelegatedRun } from "@shiba/shared";
import { isActiveStatus } from "@shiba/shared";

const PRE_SANDBOX = new Set<NonNullable<DelegatedRun["checkpoint"]>>(["queued", "dispatching"]);

const SIDE_EFFECT_SIGNALS = new Set([
  "sandbox.ready",
  "clone.complete",
  "pr.opened",
  "exec.invoked",
  "local.dispatched",
  "local.claimed",
]);

export type RestartDisposition = "resume" | "unknown";

export function restartDisposition(run: DelegatedRun): RestartDisposition {
  if (!isActiveStatus(run.status)) return "unknown";
  if (run.resumeAttemptedAt !== undefined) return "unknown";
  if (run.pullUrl) return "unknown";
  if (run.signals?.some((signal) => SIDE_EFFECT_SIGNALS.has(signal.kind))) return "unknown";
  if (run.checkpoint !== undefined && PRE_SANDBOX.has(run.checkpoint)) return "resume";
  return "unknown";
}

/** ask_user pause marker stored on the run until the operator answers. */
export interface AskUserPauseState {
  askId: string;
  pausedAt: number;
}

export function runPausedForAskUser(run: DelegatedRun): AskUserPauseState | null {
  const signal = [...(run.signals ?? [])].reverse().find((item) => item.kind === "ask_user.pending");
  if (!signal) return null;
  const askId = typeof signal.detail === "string" && signal.detail.trim() ? signal.detail.trim() : null;
  if (!askId) return null;
  return { askId, pausedAt: signal.at };
}

/**
 * Whether a resumed run may dispatch after an ask_user answer.
 * Fail-closed when the run already left the active lane or has side effects.
 */
export function askUserResumeDisposition(
  run: DelegatedRun,
  answeredAskId: string,
): RestartDisposition {
  const pause = runPausedForAskUser(run);
  if (!pause || pause.askId !== answeredAskId) return "unknown";
  if (!isActiveStatus(run.status)) return "unknown";
  if (run.signals?.some((signal) => SIDE_EFFECT_SIGNALS.has(signal.kind))) return "unknown";
  return "resume";
}
