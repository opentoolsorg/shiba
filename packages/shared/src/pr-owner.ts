/** Cluster-wide PR → orchestrator DO routing (stored on Automations DO). */

export interface PrOwnerRecord {
  agentName: string;
  codingRunId: string;
  updatedAt: number;
}

export function prOwnerStorageKey(repoFullName: string, pullNumber: number): string {
  return `pr-owner:${repoFullName}#${pullNumber}`;
}

/** One review intent per PR head across webhook + pr-lifecycle paths. */
export function prHeadReviewDedupeKey(repoFullName: string, pullNumber: number, headSha: string): string {
  return `pr-head:${repoFullName}#${pullNumber}:${headSha}`;
}
