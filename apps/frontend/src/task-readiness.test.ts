import { describe, expect, it } from "vitest";
import type { SetupStatus, LoadState } from "./live-status";
import { taskReadiness } from "./task-readiness";

const state = (ok: boolean, harness = "codex-subscription"): LoadState<SetupStatus> => ({kind: "data", data: {
  gateway: {token: false}, models: {harness, coding: "gpt-5"},
  doctor: {roles: [{role: "fixer", harness, model: "gpt-5", connectionId: null, ok, message: "Sign in to provider", fix: "Open Models"}]},
} as SetupStatus});

describe("task route readiness", () => {
  it("fails closed for malformed diagnostics", () => {
    expect(taskReadiness({kind: "data", data: {} as SetupStatus}, {}).blocked).toBe(true);
  });
  it("does not gate subscription routes on the gateway token", () => {
    expect(taskReadiness(state(true), {}).blocked).toBe(false);
  });
  it("does not gate a paired local run on cloud setup", () => {
    expect(taskReadiness({kind: "error", message: "offline"}, {runTarget: "local"}).blocked).toBe(false);
  });
  it("blocks a failing matching provider route with remediation", () => {
    expect(taskReadiness(state(false), {})).toEqual({blocked: true, message: "Sign in to provider Open Models"});
  });
  it("does not falsely verify an unmatched override or connection", () => {
    expect(taskReadiness(state(false), {connectionId: "another"})).toMatchObject({blocked: false, message: expect.stringContaining("not been checked")});
  });
  it("blocks during checks and after a failed cloud setup read", () => {
    expect(taskReadiness({kind: "loading"}, {}).blocked).toBe(true);
    expect(taskReadiness({kind: "error", message: "offline"}, {}).blocked).toBe(true);
  });
});
