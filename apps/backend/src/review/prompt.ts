/** Shared reviewer task. Both the v1 reviews route and the PR webhook lane use this. */
export function reviewerTask(input: {
  repoUrl: string;
  pullNumber: number | string;
  headSha: string;
  diffUrl: string;
  headBranch?: string;
  /** Repo AGENTS.md excerpt — steers review focus without entering the sandbox. */
  agentsMd?: string | null;
  inlineSeverityFloor?: "high" | "medium" | "low";
}): string {
  return [
    "Review the pull request diff and post findings. Do not modify code.",
    "Purpose: review",
    `Repository: ${input.repoUrl}`,
    `Pull request: #${input.pullNumber}`,
    `Head SHA: ${input.headSha}`,
    `Diff: ${input.diffUrl}`,
    ...(input.headBranch ? [`Head branch: ${input.headBranch}`] : []),
    ...(input.inlineSeverityFloor
      ? [`Inline comment threshold: findings with severity ${input.inlineSeverityFloor} or higher.`]
      : []),
    ...(input.agentsMd
      ? ["Repository AGENTS.md (follow these instructions):", "---", input.agentsMd, "---"]
      : []),
    "End your result with SHIBA_AI_COWORKER_CODING_RESULT_JSON and a JSON object",
    "{ summary, findings[] }. Each finding has path, line, category (bug|risk|maintainability|refactor),",
    "severity (high|medium|low), confidence (confirmed|investigate), title, failureScenario.",
    "Do not edit, commit, or push.",
  ].join("\n");
}
