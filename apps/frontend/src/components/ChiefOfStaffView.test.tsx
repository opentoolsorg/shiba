// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("shows loading and error states instead of the empty text", () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ChiefOfStaffView loading />);
    expect(screen.getByRole("status").textContent).toContain("Loading employees");
    expect(screen.queryByText("No workspace employees yet.")).toBeNull();
    rerender(<ChiefOfStaffView error="Could not load." onRetry={onRetry} />);
    expect(screen.getByRole("alert").textContent).toContain("Could not load.");
    expect(screen.queryByText("No workspace employees yet.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("renames inline, shows the saved name's errors, and can cancel", async () => {
    const onRename = vi.fn().mockRejectedValueOnce(new Error("Name must be 1-40 characters.")).mockResolvedValue(undefined);
    render(<ChiefOfStaffView chiefName="Shiba" onRenameChief={onRename} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Chief of staff name"), { target: { value: "  Ada  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("1-40");
    expect(onRename).toHaveBeenCalledWith("Ada");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByLabelText("Chief of staff name")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Chief of staff name")).toBeNull();
  });

  it("rejects an empty name client-side without calling save", () => {
    const onRename = vi.fn();
    render(<ChiefOfStaffView onRenameChief={onRename} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Chief of staff name"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toContain("1-40");
    expect(onRename).not.toHaveBeenCalled();
  });
});
