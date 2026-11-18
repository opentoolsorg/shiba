import type { DelegatedRun } from "@shiba/shared";
import { memoryScopeForConversation } from "../../memory-scope.js";
import { DASHBOARD_ORG_ID } from "../../org-request-auth.js";

/** Workspace setting: review after this many completed turns, or never. */
export type LearningTurnSetting = 10 | 20 | 40 | "off";
export const LEARNING_TURN_OPTIONS: readonly LearningTurnSetting[] = [10, 20, 40, "off"];
export const DEFAULT_LEARNING_TURNS: LearningTurnSetting = 20;
export const LEARNING_IDLE_MS = 15 * 60_000;
export const LEARNING_IDLE_MIN_TURNS = 3;

export type LearningTrigger = "turns" | "idle" | "closed";
export type LearningEvent = "turn" | "idle" | "closed";

export interface LearningThreadRef {
  threadKey: string;
  orgId: string;
  workspaceId: string;
  ownerId: string;
  employeeId: string;
}

export interface LearningThreadState extends LearningThreadRef {
  turnsTotal: number;
  reviewedThrough: number;
  lastTurnAt: number;
  closedAt?: number;
}

export interface LearningTurn {
  seq: number;
  runId: string;
  text: string;
  completedAt: number;
}

export interface LearningUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LearningSkillProposal {
  skillId: string;
  skillVersion: number;
  name: string;
  description: string;
  instructions: string;
  droppedShare: number;
}

export interface LearningSuggestion extends LearningSkillProposal {
  id: string;
  threadKey: string;
  workspaceId: string;
  ownerId: string;
  employeeId: string;
  status: "pending" | "applied" | "dismissed";
  createdAt: number;
}

/** Persistence for the background learning review. */
export interface LearningPort {
  getSetting(workspaceId: string): Promise<LearningTurnSetting>;
  setSetting(workspaceId: string, value: LearningTurnSetting, now: number): Promise<void>;
  /** Idempotent on runId: a replayed completion is not a second turn. */
  recordTurn(
    ref: LearningThreadRef,
    turn: { runId: string; text: string; completedAt: number },
  ): Promise<LearningThreadState>;
  getThread(threadKey: string): Promise<LearningThreadState | null>;
  closeThread(threadKey: string, now: number): Promise<LearningThreadState | null>;
  /** Threads idle since `before` with unreviewed turns. */
  idleThreads(before: number, limit: number): Promise<LearningThreadState[]>;
  turnsSince(threadKey: string, afterSeq: number, limit: number): Promise<LearningTurn[]>;
  /** Lease the review so concurrent triggers run it once. */
  claimReview(threadKey: string, now: number, leaseMs: number): Promise<boolean>;
  completeReview(threadKey: string, throughSeq: number): Promise<void>;
  releaseReview(threadKey: string): Promise<void>;
  recordUsage(ref: LearningThreadRef, usage: LearningUsage, now: number): Promise<void>;
  usageByEmployee(
    workspaceId: string,
  ): Promise<
    Array<{ employeeId: string; inputTokens: number; outputTokens: number; reviews: number }>
  >;
  addSuggestion(
    ref: LearningThreadRef,
    proposal: LearningSkillProposal,
    now: number,
  ): Promise<LearningSuggestion>;
  listSuggestions(workspaceId: string, ownerId: string): Promise<LearningSuggestion[]>;
  getSuggestion(id: string, ownerId: string): Promise<LearningSuggestion | null>;
  resolveSuggestion(id: string, ownerId: string, status: "applied" | "dismissed"): Promise<boolean>;
}

export function parseLearningTurnSetting(value: unknown): LearningTurnSetting | null {
  if (value === "off") return "off";
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return n === 10 || n === 20 || n === 40 ? n : null;
}

/** Which trigger, if any, an event fires for a thread under a setting. */
export function learningTrigger(
  state: Pick<LearningThreadState, "turnsTotal" | "reviewedThrough" | "lastTurnAt">,
  setting: LearningTurnSetting,
  event: LearningEvent,
  now: number,
): LearningTrigger | null {
  if (setting === "off") return null;
  const pending = state.turnsTotal - state.reviewedThrough;
  if (pending <= 0) return null;
  if (event === "closed") return "closed";
  if (event === "turn") return pending >= setting ? "turns" : null;
  return now - state.lastTurnAt >= LEARNING_IDLE_MS && pending >= LEARNING_IDLE_MIN_TURNS
    ? "idle"
    : null;
}

const INTAKE_CONVERSATION = /^(?:slack|teams|msteams|discord|telegram|whatsapp|email)[:_-]/i;
const ROUTINE_DECIDER = /^(?:automation|routine|schedule|system)(?::|$)/;

/**
 * The learning thread a settled run counts toward, or null when the run is
 * not reviewable: chat intake, routine runs and channel/collaboration threads
 * are skipped. Side threads (subagent runs) count separately from the main
 * thread they branch from.
 */
export function learningThreadFor(
  conversationName: string | undefined,
  run: Pick<
    DelegatedRun,
    | "runId"
    | "parentRunId"
    | "collaborationHandoffId"
    | "personalExecution"
    | "orgId"
    | "customAgentId"
    | "approval"
    | "forkedFrom"
  >,
  rootRunId?: string,
): LearningThreadRef | null {
  const ownerId = memoryScopeForConversation(conversationName);
  if (!ownerId || !conversationName || INTAKE_CONVERSATION.test(conversationName)) return null;
  if (run.collaborationHandoffId || run.personalExecution) return null;
  const decidedBy = run.approval?.decidedBy;
  if (typeof decidedBy === "string" && ROUTINE_DECIDER.test(decidedBy)) return null;
  const thread = run.parentRunId
    ? `side:${run.parentRunId}`
    : `main:${rootRunId ?? run.forkedFrom?.runId ?? run.runId}`;
  const workspaceId = run.orgId ?? DASHBOARD_ORG_ID;
  return {
    threadKey: `${conversationName}#${thread}`,
    orgId: workspaceId,
    workspaceId,
    ownerId,
    employeeId: run.customAgentId ?? "default",
  };
}
