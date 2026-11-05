// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatEmptyState, deriveFirstName } from "./ChatEmptyState";

afterEach(() => {
  cleanup();
});

describe("deriveFirstName", () => {
  it("extracts and capitalizes the first name from various user formats", () => {
    expect(deriveFirstName("princepal@example.com")).toBe("Princepal");
    expect(deriveFirstName("prince.pal@example.com")).toBe("Prince");
    expect(deriveFirstName("Prince Pal")).toBe("Prince");
    expect(deriveFirstName("john_doe@shiba.dev")).toBe("John");
    expect(deriveFirstName("alice-smith")).toBe("Alice");
    expect(deriveFirstName("")).toBeNull();
    expect(deriveFirstName(null)).toBeNull();
    expect(deriveFirstName("default")).toBeNull();
    expect(deriveFirstName("identity-pending")).toBeNull();
  });
});

describe("ChatEmptyState", () => {
  it("renders serif greeting with user first name", () => {
    render(<ChatEmptyState userName="alex.turner@example.com" onPick={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Hi Alex!" })).toBeTruthy();
    expect(screen.getByText("What would you like to build or solve with Shiba today?")).toBeTruthy();
  });

  it("renders generic serif greeting when identity is unknown", () => {
    render(<ChatEmptyState userName={null} onPick={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Hi!" })).toBeTruthy();
  });

  it("renders blocker card when launchBlocked is true", () => {
    const onOpenSetup = vi.fn();
    const onOpenProviders = vi.fn();

    render(
      <ChatEmptyState
        userName="prince"
        launchBlocked={true}
        setupDone={2}
        setupTotal={6}
        onOpenSetup={onOpenSetup}
        onOpenProviders={onOpenProviders}
        onPick={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert", { name: "Setup required" })).toBeTruthy();
    expect(screen.getByText("Setup 2/6")).toBeTruthy();
    expect(screen.getByText("Setup required to launch tasks")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Complete setup" }));
    expect(onOpenSetup).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Configure providers" }));
    expect(onOpenProviders).toHaveBeenCalled();
  });

  it("renders custom blockerNode when provided", () => {
    render(
      <ChatEmptyState
        userName="prince"
        blockerNode={<div data-testid="custom-blocker">Custom Blocker</div>}
        onPick={vi.fn()}
      />,
    );

    expect(screen.getByTestId("custom-blocker")).toBeTruthy();
  });

  it("renders suggestion chips and triggers onPick with task text", () => {
    const onPick = vi.fn();
    render(<ChatEmptyState userName="prince" onPick={onPick} />);

    expect(screen.getByText("Suggestions")).toBeTruthy();
    const fixTestsChip = screen.getByRole("button", { name: "Fix Failing Tests" });
    expect(fixTestsChip).toBeTruthy();

    fireEvent.click(fixTestsChip);
    expect(onPick).toHaveBeenCalledWith(
      expect.stringContaining("Investigate test failures in the repository"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Documentation" }));
    expect(onPick).toHaveBeenCalledWith(
      expect.stringContaining("Review and update README and code comments"),
    );
  });
});
