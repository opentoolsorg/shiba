import { describe, expect, it } from "vitest";
import { deriveJourney, shouldOpenJourney, type JourneyInput } from "./onboarding-journey";

const EMPTY: JourneyInput = {
  workspaceReady: false,
  providerReady: false,
  employeeReady: false,
  taskPrepared: false,
  run: "none",
  activated: false,
  dismissed: false,
};

describe("deriveJourney", () => {
  it("starts a brand-new account at the workspace stage", () => {
    const status = deriveJourney(EMPTY);
    expect(status.current).toBe("workspace");
    expect(status.index).toBe(1);
    expect(status.complete).toBe(false);
    expect(status.steps.map((step) => step.state)).toEqual(["current", "upcoming", "upcoming", "upcoming", "upcoming", "upcoming"]);
  });

  it("skips a stage the account already satisfies", () => {
    const status = deriveJourney({ ...EMPTY, workspaceReady: true, providerReady: true });
    expect(status.current).toBe("employee");
    expect(status.index).toBe(3);
    expect(status.steps[0]).toMatchObject({ id: "workspace", state: "done", summary: "Workspace ready" });
    expect(status.steps[1]).toMatchObject({ id: "provider", state: "done" });
    expect(status.steps[2]!.state).toBe("current");
  });

  it("keeps approval unfinished until a run exists for the draft", () => {
    const prepared = { ...EMPTY, workspaceReady: true, providerReady: true, employeeReady: true, taskPrepared: true };
    expect(deriveJourney(prepared).current).toBe("approval");
    expect(deriveJourney({ ...prepared, run: "awaiting-approval" })).toMatchObject({ current: "approval" });
    expect(deriveJourney({ ...prepared, run: "awaiting-approval" }).steps[4]).toMatchObject({
      id: "approval",
      state: "current",
      summary: "Waiting for your approval",
    });
    expect(deriveJourney({ ...prepared, run: "running" }).current).toBe("result");
    expect(deriveJourney({ ...prepared, run: "running" }).steps[4]).toMatchObject({
      state: "done",
      summary: "Approved · run in progress",
    });
  });

  it("keeps a finished result open until the person records the review", () => {
    const prepared = { ...EMPTY, workspaceReady: true, providerReady: true, employeeReady: true, taskPrepared: true };
    const resulted = deriveJourney({ ...prepared, run: "completed" });
    // A finished run is not a finished setup: the review is still owed.
    expect(resulted.complete).toBe(false);
    expect(resulted.current).toBe("result");
    expect(resulted.steps[5]).toMatchObject({ id: "result", state: "current", summary: "Result ready · review not recorded" });
    const reviewed = deriveJourney({ ...prepared, run: "completed", activated: true });
    expect(reviewed.complete).toBe(true);
    expect(reviewed.steps[5]).toMatchObject({ state: "done", summary: "Result reviewed" });
  });

  it("keeps a failed run at the result stage instead of claiming success", () => {
    const status = deriveJourney({ ...EMPTY, workspaceReady: true, providerReady: true, employeeReady: true, taskPrepared: true, run: "failed" });
    expect(status.current).toBe("result");
    expect(status.steps[5]!.summary).toContain("failed");
  });

  it("never reports complete while a required stage is unfinished", () => {
    const status = deriveJourney({ ...EMPTY, workspaceReady: true, providerReady: true, employeeReady: true, taskPrepared: true, run: "completed", activated: false });
    expect(status.complete).toBe(false);
    expect(deriveJourney({ ...EMPTY, workspaceReady: true, providerReady: false }).complete).toBe(false);
  });

  it("treats a dismissed account as not prompting, while still resuming at its stage", () => {
    const status = deriveJourney({ ...EMPTY, workspaceReady: true, dismissed: true });
    expect(status.shouldPrompt).toBe(false);
    expect(status.resume).toBe("provider");
  });
});

describe("shouldOpenJourney", () => {
  it("opens for an unfinished account and stays shut for a finished or returning one", () => {
    expect(shouldOpenJourney({ activated: false, dismissed: false, hasSettledRun: false })).toBe(true);
    expect(shouldOpenJourney({ activated: true, dismissed: false, hasSettledRun: false })).toBe(false);
    expect(shouldOpenJourney({ activated: false, dismissed: true, hasSettledRun: false })).toBe(false);
    expect(shouldOpenJourney({ activated: false, dismissed: false, hasSettledRun: true })).toBe(false);
  });
});
