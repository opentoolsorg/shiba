// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HandoffCard, HandoffReport, resolveHandoffStatus } from "./HandoffCard";

afterEach(cleanup);

describe("HandoffCard", () => {
  it("shows who hands the task to whom and opens the child thread", () => {
    const open = vi.fn();
    render(
      <HandoffCard
        body="Shiba → Fixer: fix the README typo · because Fixer handles repo edits"
        status="pending approval"
        onOpenThread={open}
      />,
    );
    const card = screen.getByRole("button", { name: /Shiba → Fixer: fix the README typo/ });
    expect(card.textContent).toContain("pending approval");
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(card);
    expect(open).toHaveBeenCalledOnce();
  });

  it.each(["working", "reported", "cancelled"] as const)("shows status %s", (status) => {
    render(<HandoffCard body="Shiba → Fixer: fix the README typo" status={status} />);
    expect(screen.getByRole("button").textContent).toContain(status);
  });

  it("renders a handoff report as a compact result pointer", () => {
    const open = vi.fn();
    render(<HandoffReport body="README typo is fixed." onOpenThread={open} />);
    fireEvent.click(screen.getByRole("button", { name: /Reported result: README typo is fixed/ }));
    expect(open).toHaveBeenCalledOnce();
  });

  it("prefers a report, then a started run, then approval", () => {
    expect(resolveHandoffStatus({ handoffStatus: "cancelled", reported: true, runStarted: true })).toBe("cancelled");
    expect(resolveHandoffStatus({ handoffStatus: "active", reported: true, runStarted: true })).toBe("reported");
    expect(resolveHandoffStatus({ handoffStatus: "active", reported: false, runStarted: true })).toBe("working");
    expect(resolveHandoffStatus({ handoffStatus: "active", reported: false, runStarted: false })).toBe("pending approval");
  });
});
