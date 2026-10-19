import type { DelegatedRun } from "../runs.js";
import { isActiveStatus } from "../runs.js";

/**
 * Thin policy seam above the Sandbox SDK: shared subagents must not tear
 * down a container still in use by a sibling run on the same sandboxId.
 */
export function shouldDestroySandboxAfterRun(run: DelegatedRun, runs: DelegatedRun[]): boolean {
  return !runs.some(
    (other) => other.runId !== run.runId && other.sandboxId === run.sandboxId && isActiveStatus(other.status),
  );
}
