import { stableHash } from "./approvals.js";

export type FindingCategory = "bug" | "risk" | "maintainability" | "refactor";
export type FindingSeverity = "high" | "medium" | "low";
export type FindingConfidence = "confirmed" | "investigate";
export type FindingTriage = "open" | "resolved" | "irrelevant";

export interface ReviewFinding {
  id: string;
  path: string;
  line: number;
  category: FindingCategory;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  title: string;
  failureScenario: string;
  triage: FindingTriage;
}

export interface ReviewPull {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  url: string;
}

/** Persisted v1 review-loop settings for one coding thread (run id). */
export interface ReviewLoopSettings {
  threadId: string;
  enabled: boolean;
  autoMerge: boolean;
  pullRequestId?: string;
  updatedAt: number;
}

export interface ReviewRound {
  roundId: string;
  codingRunId: string;
  reviewRunId: string;
  pull: ReviewPull;
  status: "queued" | "running" | "posted" | "failed" | "skipped";
  findings: ReviewFinding[];
  summary: string;
  githubReviewId?: number;
  postedAt?: number;
  error?: string;
  /** Reviewer-run generation that wrote this round. A lower generation cannot replace a terminal round. */
  generation?: number;
}

const CATEGORIES = new Set<FindingCategory>(["bug", "risk", "maintainability", "refactor"]);
const SEVERITIES = new Set<FindingSeverity>(["high", "medium", "low"]);
const CONFIDENCE = new Set<FindingConfidence>(["confirmed", "investigate"]);
const RANK: Record<FindingSeverity, number> = { low: 0, medium: 1, high: 2 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safePath(path: unknown): string | null {
  if (typeof path !== "string" || path === "" || path.startsWith("/") || path.split("/").includes("..")) return null;
  return path;
}

export function findingId(path: string, line: number, title: string): string {
  return stableHash(`${path}\n${line}\n${title}`).slice(0, 16);
}

function oneFinding(value: unknown): ReviewFinding | null {
  if (!isRecord(value)) return null;
  const path = safePath(value.path);
  const line = value.line;
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const failureScenario = typeof value.failureScenario === "string" ? value.failureScenario.trim() : "";
  if (
    path === null ||
    typeof line !== "number" ||
    !Number.isInteger(line) ||
    line < 1 ||
    title === "" ||
    failureScenario === "" ||
    !CATEGORIES.has(value.category as FindingCategory) ||
    !SEVERITIES.has(value.severity as FindingSeverity) ||
    !CONFIDENCE.has(value.confidence as FindingConfidence)
  ) {
    return null;
  }
  return {
    id: findingId(path, line, title),
    path,
    line,
    category: value.category as FindingCategory,
    severity: value.severity as FindingSeverity,
    confidence: value.confidence as FindingConfidence,
    title,
    failureScenario,
    triage: "open",
  };
}

function envelopeRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    const marker = "SHIBA_AI_COWORKER_CODING_RESULT_JSON\n";
    const index = raw.lastIndexOf(marker);
    const json = index >= 0 ? raw.slice(index + marker.length) : raw;
    try {
      const parsed: unknown = JSON.parse(json);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isRecord(raw) ? raw : null;
}

/** Never throws. Invalid findings increment `rejected` and are dropped. */
export function parseReviewEnvelope(raw: unknown): { summary: string; findings: ReviewFinding[]; rejected: number } {
  const record = envelopeRecord(raw);
  if (record === null) return { summary: "", findings: [], rejected: 0 };
  const summary = typeof record.summary === "string" ? record.summary : "";
  const items = Array.isArray(record.findings) ? record.findings : [];
  const findings: ReviewFinding[] = [];
  let rejected = 0;
  for (const item of items) {
    const finding = oneFinding(item);
    if (finding === null) rejected += 1;
    else findings.push(finding);
  }
  return { summary, findings, rejected };
}

/** Findings at or above `threshold` become inline comments. The rest stay in the review body. */
export function selectPostable(
  findings: ReviewFinding[],
  threshold: FindingSeverity,
): { inline: ReviewFinding[]; bodyOnly: ReviewFinding[] } {
  const floor = RANK[threshold];
  const inline: ReviewFinding[] = [];
  const bodyOnly: ReviewFinding[] = [];
  for (const finding of findings) {
    if (RANK[finding.severity] >= floor) inline.push(finding);
    else bodyOnly.push(finding);
  }
  return { inline, bodyOnly };
}

const TRIAGE_VALUES = new Set<FindingTriage>(["open", "resolved", "irrelevant"]);

export function isFindingTriage(value: unknown): value is FindingTriage {
  return typeof value === "string" && TRIAGE_VALUES.has(value as FindingTriage);
}

/** Update one finding's triage on a round; returns null when the id is missing. */
export function patchFindingTriage(
  round: ReviewRound,
  findingId: string,
  triage: FindingTriage,
): ReviewRound | null {
  let touched = false;
  const findings = round.findings.map((finding) => {
    if (finding.id !== findingId) return finding;
    touched = true;
    return { ...finding, triage };
  });
  if (!touched) return null;
  return { ...round, findings };
}

/** Latest round for a coding run, preferring the highest headSha round when multiple exist. */
export function latestRoundForCodingRun(rounds: ReviewRound[], codingRunId: string): ReviewRound | undefined {
  const mine = rounds.filter((round) => round.codingRunId === codingRunId);
  if (mine.length === 0) return undefined;
  return mine.reduce((best, round) => (round.postedAt ?? 0) >= (best.postedAt ?? 0) ? round : best);
}

export function roundForHead(rounds: ReviewRound[], codingRunId: string, headSha: string): ReviewRound | undefined {
  return rounds.find((round) => round.codingRunId === codingRunId && round.pull.headSha === headSha);
}

/** Failed/skipped rounds do not block a new chained review for the same head. */
export function roundBlocksReviewChain(round: ReviewRound): boolean {
  return round.status !== "failed" && round.status !== "skipped";
}

/** Latest round for a head that still prevents queueing another chained review. */
export function blockingRoundForHead(
  rounds: ReviewRound[],
  codingRunId: string,
  headSha: string,
): ReviewRound | undefined {
  const round = roundForHead(rounds, codingRunId, headSha);
  if (!round || !roundBlocksReviewChain(round)) return undefined;
  return round;
}

export function parseInlineSeverityThreshold(raw: string | undefined): FindingSeverity {
  if (raw === "high" || raw === "medium" || raw === "low") return raw;
  return "medium";
}

const TERMINAL_ROUND_STATUSES = new Set<ReviewRound["status"]>(["posted", "failed", "skipped"]);

/** True when an incoming write must be dropped to protect a terminal round. */
export function reviewRoundWriteRejected(current: ReviewRound | undefined, incoming: ReviewRound): boolean {
  if (!current || !TERMINAL_ROUND_STATUSES.has(current.status)) return false;
  if (incoming.generation === undefined) return true;
  if (current.generation !== undefined && incoming.generation <= current.generation) return true;
  return false;
}
