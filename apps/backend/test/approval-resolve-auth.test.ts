import { describe, expect, it } from "vitest";
import { approvalResolveForbidden } from "../src/approval-resolve-auth.js";
import type { Env } from "../src/env.js";

describe("approvalResolveForbidden", () => {
  const env = {
    DASHBOARD_APPROVERS: "owner@example.test",
    SLACK_APPROVERS: "U123",
  } as Env;

  it("denies shared approval resolve without approver membership", () => {
    expect(
      approvalResolveForbidden(env, {
        threadKey: "default",
        approved: true,
        decidedBy: "attacker@example.test",
      }),
    ).toMatch(/Not authorized/);
  });

  it("allows automation unattended approve", () => {
    expect(
      approvalResolveForbidden(env, {
        threadKey: "default",
        approved: true,
        decidedBy: "automation:sched-1",
      }),
    ).toBeNull();
  });

  it("allows dashboard approver on shared queue", () => {
    expect(
      approvalResolveForbidden(env, {
        threadKey: "default",
        approved: true,
        decidedBy: "owner@example.test",
      }),
    ).toBeNull();
  });
  it("allows collaboration cancellation only for rejection", () => {
    for (const approved of [false, true]) {
      expect(approvalResolveForbidden(env, { threadKey: "default", approved, decidedBy: "collaboration-cancellation" }) === null).toBe(!approved);
    }
  });

  it.each(["telegram", "discord"] as const)("checks the %s allowlist and actor prefix", (source) => {
    const laneEnv = { ...env, TELEGRAM_APPROVERS: "123", DISCORD_APPROVERS: "123" };
    for (const decidedBy of [`${source}:123`, `${source}:456`, "123", "owner@example.test"]) {
      expect(approvalResolveForbidden(laneEnv, { threadKey: `${source}:shared`, approved: true, decidedBy, source }) === null).toBe(decidedBy === `${source}:123`);
    }
  });

  it("requires a persisted ACP pointer on the authenticated owner's DO", () => {
    const input = { threadKey: "acp:session-1", approved: true, decidedBy: "alice@example.test" };
    expect(approvalResolveForbidden(env, input)).not.toBeNull();
    expect(approvalResolveForbidden(env, { ...input, ownedAcpApproval: { orchestratorName: input.decidedBy, threadKey: input.threadKey } })).toBeNull();
    expect(approvalResolveForbidden(env, { ...input, ownedAcpApproval: { orchestratorName: "bob@example.test", threadKey: input.threadKey } })).not.toBeNull();
    expect(approvalResolveForbidden(env, { ...input, ownedAcpApproval: { orchestratorName: input.decidedBy, threadKey: "acp:other" } })).not.toBeNull();
  });

});
