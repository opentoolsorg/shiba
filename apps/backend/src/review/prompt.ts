/** Shared reviewer task. Both the v1 reviews route and the PR webhook lane use this. */
export function reviewerTask(input: {
  repoUrl: string;
  pullNumber: number | string;
  headSha: string;
  diffUrl: string;
  headBranch?: string;
}): string {
  return [
    "Review the pull request diff and post findings. Do not modify code.",
    "Purpose: review",
    `Repository: ${input.repoUrl}`,
    `Pull request: #${input.pullNumber}`,
    `Head SHA: ${input.headSha}`,
    `Diff: ${input.diffUrl}`,
    ...(input.headBranch ? [`Head branch: ${input.headBranch}`] : []),
    "End your result with SHIBA_AI_COWORKER_CODING_RESULT_JSON and a JSON object",
    "{ summary, findings[] }. Each finding has path, line, category (bug|risk|maintainability|refactor),",
    "severity (high|medium|low), confidence (confirmed|investigate), title, failureScenario.",
    "Do not edit, commit, or push.",
  ].join("\n");
}
