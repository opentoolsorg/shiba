import { z } from "zod";

/** This contract grants storage-only reminders, never inference or app access. */
export const founderReviewScheduleInputSchema = z.object({
  mode: z.literal("review-draft"),
  employeeId: z.string().min(1).max(128),
  employeeVersion: z.number().int().positive(),
  skillId: z.string().min(1).max(128),
  skillVersion: z.number().int().positive(),
  cadence: z.enum(["daily", "weekly"]),
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5][05]$/),
  weekday: z.number().int().min(0).max(6).optional(),
  timezone: z.string().min(1).max(100).refine((value) => {
    try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return value === value.trim(); }
    catch { return false; }
  }, "Choose an IANA timezone."),
  expiresAt: z.number().int().positive(),
  destination: z.literal("private-dashboard"),
  allowedTools: z.tuple([]),
  provider: z.null(),
  expectedVersion: z.number().int().nonnegative().optional(),
}).strict().refine((value) => value.cadence === "weekly" ? value.weekday !== undefined : value.weekday === undefined,
  "A weekday is required only for a weekly cadence.");

export type FounderReviewScheduleInput = z.infer<typeof founderReviewScheduleInputSchema>;
export interface FounderReviewScheduleContract extends Omit<FounderReviewScheduleInput, "expectedVersion"> {
  format: "shiba.founder-review.v1";
  orgId: string;
  ownerId: string;
  ownerAccountId: string;
  libraryId: string;
  recipeSha256: string;
  membership: { workspaceId: string; version: number; role: "owner" | "admin" } | null;
  employeeConfig: string;
  employeeName: string;
  skillInstructions: string;
  skillName: string;
  skillSource: string | null;
  cron: string;
  task: string;
  requiredSources: string[];
}
export type FounderReviewScheduleState = "draft" | "enabled" | "paused" | "revoked" | "blocked";
export interface FounderReviewScheduleRecord {
  id: string;
  version: number;
  digest: string;
  state: FounderReviewScheduleState;
  contract: FounderReviewScheduleContract;
  reviewExpiresAt: number;
  nextDueAt: number;
  blockedReason?: string;
}
export interface FounderReviewOccurrence {
  id: string;
  scheduleId: string;
  scheduleVersion: number;
  digest: string;
  scheduledAt: number;
  createdAt: number;
  status: "pending" | "dismissed" | "cancelled";
  /** This is a task draft. No source data has been fetched. */
  task: string;
}
export const founderReviewDecisionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  reviewed: z.literal(true),
}).strict();
