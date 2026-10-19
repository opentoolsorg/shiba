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
