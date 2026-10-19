/**
 * Deterministic coding/review completion for verify-shiba when containers are
 * off. Produces real PR + review posts against the mock GitHub stub.
 */
import type { CodingTaskInput, CodingTaskResult } from "./opencode-input.js";
import { RESULT_MARKER } from "./opencode-input.js";
import type { ProgressEmitter } from "./runtime.js";

const STAND_IN_FINDING = {
  path: "README.md",
  line: 1,
  category: "maintainability" as const,
  severity: "medium" as const,
  confidence: "investigate" as const,
  title: "verify-shiba stand-in finding",
  failureScenario: "Mock review round for local/CI evidence — not a live model review.",
};

export function isReviewerStandIn(input: CodingTaskInput): boolean {
  return input.role === "reviewer";
}

export function buildStandInCodingResult(): CodingTaskResult {
  const line = "verify-shiba stand-in change\n";
  return {
    status: "completed",
    exitCode: 0,
    stderrTail: "",
    changedFiles: ["README.md"],
    diff: `--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n+${line}`,
    files: [{ path: "README.md", content: `# verify-shiba\n${line}`, encoding: "utf8" }],
    summary: "verify-shiba stand-in coding run completed.",
  };
}

export function buildStandInReviewResult(): CodingTaskResult & { findings: unknown[] } {
  return {
    status: "completed",
    exitCode: 0,
    stderrTail: "",
    changedFiles: [],
    diff: "",
    files: [],
    summary: "verify-shiba stand-in review completed.",
    findings: [STAND_IN_FINDING],
  };
}

/** Marker block the orchestrator's parseReviewEnvelope reads from child output. */
export function formatStandInReviewOutput(result: CodingTaskResult & { findings: unknown[] }): string {
  return `${RESULT_MARKER}\n${JSON.stringify(result)}`;
}

export async function runVerifyStandInTask(
  input: CodingTaskInput,
  emit: ProgressEmitter,
): Promise<CodingTaskResult> {
  await emit({ phase: "configure", message: "verify-shiba stand-in (no container)", fraction: 0.1 });
  await emit({ phase: "code", message: "synthetic task", fraction: 0.5 });
  await emit({ phase: "collect", message: "collecting stand-in artifacts", fraction: 0.9 });
  return isReviewerStandIn(input) ? buildStandInReviewResult() : buildStandInCodingResult();
}
