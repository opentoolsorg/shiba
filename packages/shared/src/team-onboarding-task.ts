import { z } from "zod";
import { draftTaskReferenceSchema } from "./onboarding.js";

/** A short-lived owned text snapshot for deliberate room-composer review, not execution authority. */
export const teamOnboardingTaskSchema = draftTaskReferenceSchema.extend({
  workspaceId: z.string().regex(/^ws_[a-f0-9]{24}$/),
  actorId: z.string().email().max(320),
  accountId: z.string().min(1).max(128),
  progressRevision: z.number().int().nonnegative().safe(),
  text: z.string().min(1).max(4000),
  employee: z.object({ id: z.string().min(1).max(128), version: z.number().int().positive().safe() }).strict().nullable(),
  savedAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().positive().safe(),
}).strict();

export type TeamOnboardingTask = z.infer<typeof teamOnboardingTaskSchema>;
