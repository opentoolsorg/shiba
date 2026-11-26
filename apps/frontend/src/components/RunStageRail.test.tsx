// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunStageRail, runStages } from "./RunStageRail";

afterEach(cleanup);

const states = (input: Parameters<typeof runStages>[0]) => runStages(input).map((stage) => stage.state);
const execution = (input: Parameters<typeof runStages>[0]) => runStages(input)[2];

describe("runStages", () => {
  it("shows a pending approval as the current stage with nothing started", () => {
    expect(states({ approval: "waiting" })).toEqual(["done", "current", "upcoming", "upcoming"]);
    expect(execution({ approval: "waiting" })?.note).toBe("Not started");
  });

  it("never infers an approval that was not recorded", () => {
    expect(runStages({})[1]).toEqual({ label: "Approval", state: "upcoming", note: "Not recorded" });
  });

  it("blocks at a rejection and says the run will not start", () => {
    expect(states({ approval: "rejected" })).toEqual(["done", "blocked", "upcoming", "upcoming"]);
    expect(execution({ approval: "rejected" })?.note).toBe("Will not run");
  });

  it("shows an approved in-flight run as executing", () => {
    expect(states({ approval: "approved", runStatus: "running" })).toEqual(["done", "done", "current", "upcoming"]);
    expect(execution({ approval: "approved", runStatus: "pending" })).toMatchObject({ state: "current", note: "Pending" });
  });

  it("shows a queued approval as current, not started", () => {
    expect(execution({ approval: "approved", queued: true })).toMatchObject({ state: "current", note: "Queued" });
  });

  it("marks a completed run done with evidence ready", () => {
    expect(states({ approval: "approved", runStatus: "completed" })).toEqual(["done", "done", "done", "done"]);
    expect(runStages({ approval: "approved", runStatus: "completed" })[3]?.note).toBe("Ready to review");
  });

  it.each([
    ["error", "Error"],
    ["aborted", "Aborted"],
    ["cancelled", "Cancelled"],
    ["unknown", "Unknown"],
  ])("shows a %s run as blocked, never as done", (runStatus, note) => {
    expect(states({ approval: "approved", runStatus })).toEqual(["done", "done", "blocked", "upcoming"]);
    expect(execution({ approval: "approved", runStatus })?.note).toBe(note);
  });
});

describe("RunStageRail", () => {
  it("spells out every stage in text and marks only the current one", () => {
    render(<RunStageRail stages={runStages({ approval: "rejected" })} />);
    const items = within(screen.getByRole("list", { name: "Request progress" })).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["RequestRecorded", "→ApprovalRejected", "→ExecutionWill not run", "→EvidenceAfter execution"]);
    expect(items.filter((item) => item.getAttribute("aria-current") === "step")).toHaveLength(0);
    cleanup();
    render(<RunStageRail stages={runStages({ approval: "waiting" })} />);
    expect(screen.getAllByRole("listitem")[1]?.getAttribute("aria-current")).toBe("step");
  });
});
