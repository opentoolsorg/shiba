import { z } from "zod";

/** Whole-dollar bounds for one prepaid credit top-up through Stripe Checkout. */
export const WORKSPACE_TOP_UP_MIN_USD = 5;
export const WORKSPACE_TOP_UP_MAX_USD = 500;

export function isValidWorkspaceTopUpUsd(amountUsd: unknown): amountUsd is number {
  return typeof amountUsd === "number" && Number.isSafeInteger(amountUsd) &&
    amountUsd >= WORKSPACE_TOP_UP_MIN_USD && amountUsd <= WORKSPACE_TOP_UP_MAX_USD;
}

export const workspaceTopUpSchema = z.strictObject({
  id: z.string(),
  amountUsd: z.number().nonnegative(),
  status: z.enum(["pending", "succeeded", "failed", "expired"]),
  createdAt: z.number(),
  settledAt: z.number().nullable(),
});
export type WorkspaceTopUp = z.infer<typeof workspaceTopUpSchema>;

/**
 * `GET /api/billing`. Credits are prepaid USD; spend is what this workspace's
 * runs cost the deployment since billing started. Stripe ids stay Worker-side.
 */
export const workspaceBillingSchema = z.strictObject({
  enabled: z.boolean(),
  missing: z.array(z.string()),
  mode: z.enum(["test", "live"]).nullable(),
  creditedUsd: z.number(),
  spentUsd: z.number(),
  balanceUsd: z.number(),
  exhausted: z.boolean(),
  hasCustomer: z.boolean(),
  since: z.number().nullable(),
  topUps: z.array(workspaceTopUpSchema),
  limits: z.strictObject({ minUsd: z.number(), maxUsd: z.number() }),
});
export type WorkspaceBilling = z.infer<typeof workspaceBillingSchema>;
