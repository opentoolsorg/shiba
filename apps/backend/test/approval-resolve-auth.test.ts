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
});
