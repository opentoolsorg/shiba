// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionPending } from "./SessionPending";
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe("SessionPending", () => {
  it("explains a slow check and exposes only a real supplied retry", () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    render(<SessionPending onRetry={onRetry} />);
    expect(screen.queryByRole("button")).toBeNull();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole("status").textContent).toContain("longer than usual");
    fireEvent.click(screen.getByRole("button", { name: "Retry session check" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
  it("shows structural shell placeholders and a single accessible status without private data or fake retry", () => {
    const { container } = render(<SessionPending />);
    expect(screen.getByRole("status").textContent).toBe("Checking your session…");
    expect(screen.getByRole("region", { name: "Loading workspace" }).getAttribute("aria-busy")).toBe("true");
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
