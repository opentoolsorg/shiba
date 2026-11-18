import { z } from "zod";

const limit = z.number().nonnegative().nullable();
export const usageBudgetPolicySchema = z.strictObject({
  dailyLimitUsd: limit,
  monthlyLimitUsd: limit,
  perRunLimitUsd: limit,
  onExceed: z.enum(["stop", "ask"]),
  updatedAt: z.number().nonnegative(),
  updatedBy: z.string().min(1).max(256),
});
export type UsageBudgetPolicy = z.infer<typeof usageBudgetPolicySchema>;

export interface SandboxMeter {
  status: "estimated" | "not_applicable" | "not_started" | "unavailable";
  cpuSeconds: number;
  ramGbSeconds: number;
  diskGbSeconds: number;
  costUsd: number;
  provenance: {
    source: "instance-type-rates";
    instanceType: string;
    pricingVersion: string;
    startedAt: number | null;
    endedAt: number | null;
  } | null;
}
