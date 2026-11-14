// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterChip } from "./RouterChip";

afterEach(cleanup);

const candidates = [
  { actorId: "agent:fixer", name: "Fixer" },
  { actorId: "agent:reviewer", name: "Reviewer" },
];

describe("RouterChip", () => {
  it("shows the routing reason and reassigns through the picker", () => {
    const reassign = vi.fn();
    render(<RouterChip reason="Fixer handles repo edits" candidates={candidates} onReassign={reassign} />);
    expect(screen.getByLabelText("Router decision").textContent).toContain("because Fixer handles repo edits");
    expect(reassign).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "Reassign" }), { target: { value: "agent:reviewer" } });
    expect(reassign).toHaveBeenCalledOnce();
    expect(reassign).toHaveBeenCalledWith("agent:reviewer");
  });

  it("keeps a working handoff behind approval when it is reassigned", () => {
    const reassign = vi.fn();
    render(<RouterChip reason="Reviewer handles pull requests" candidates={candidates} runActive onReassign={reassign} />);
    expect(screen.getByText(/still waits for approval/).textContent).toContain("new handoff");
    fireEvent.change(screen.getByRole("combobox", { name: "Reassign" }), { target: { value: "agent:fixer" } });
    expect(reassign).toHaveBeenCalledWith("agent:fixer");
  });
});
