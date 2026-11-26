// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwarmDeskView } from "./SwarmDeskView";
import type { SwarmRunInput } from "@shiba/shared";

afterEach(cleanup);
const run: SwarmRunInput = { runId: "run-1", task: "Implement feature", repoUrl: "https://github.com/acme/repo", status: "completed", baseBranch: "main", updatedAt: 20, createdAt: 10, pullUrl: "https://github.com/acme/repo/pull/1" };
const renderDesk = (onOpenRun?: (id: string) => void) => render(<SwarmDeskView runs={[run]} onApplyIntake={vi.fn()} shareUrlFor={async () => "https://example.test/share"} onOpenRun={onOpenRun} />);

describe("SwarmDeskView", () => {
  it("opens or reviews a run when the optional action is provided", () => {
    const onOpenRun = vi.fn();
    renderDesk(onOpenRun);
    fireEvent.click(screen.getByRole("button", { name: "Review result" }));
    expect(onOpenRun).toHaveBeenCalledWith("run-1");
  });
  it("omits run action links without callback and shows selected summary and approval copy", () => {
    renderDesk();
    expect(screen.queryByRole("button", { name: "Review result" })).toBeNull();
    expect(screen.getByText(/Marking a task resolved does not approve publication/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show summary" }));
    expect(screen.getByRole("region", { name: "Selected run summary" }).textContent).toContain("Implement feature");
    expect(screen.getByRole("link", { name: "Pull request" }).getAttribute("href")).toContain("/pull/1");
  });
});
