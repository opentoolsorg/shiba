// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChiefOfStaffView } from "./ChiefOfStaffView";

afterEach(cleanup);

describe("ChiefOfStaffView", () => {
  it("fires each supplied callback", () => {
    const [chief, approvals, outputs, open] = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    render(<ChiefOfStaffView user={{ name: "Prince" }} employees={[{ id: "e1", name: "Ledger", role: "Finance" }]} onOpenChief={chief} onOpenApprovals={approvals} onOpenOutputs={outputs} onOpenEmployee={open} />);
    expect(screen.getByRole("heading", { name: "Shiba" })).toBeTruthy();
    expect(screen.getByText("Prince’s Shiba")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "Review human decisions" }));
    fireEvent.click(screen.getByRole("button", { name: /Outputs & handoffs/ }));
    fireEvent.click(screen.getByRole("button", { name: /Ledger/ }));
    expect([chief, approvals, outputs]).toSatisfy((fns: ReturnType<typeof vi.fn>[]) => fns.every((fn) => fn.mock.calls.length === 1));
    expect(open).toHaveBeenCalledWith("e1");
  });

  it("hides every action whose callback is absent and states the empty roster", () => {
    render(<ChiefOfStaffView />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("No workspace employees yet.")).toBeTruthy();
  });
});
