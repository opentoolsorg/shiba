// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsPage, SettingsPanel } from "./SettingsPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SettingsPanel", () => {
  it("renders Settings header, Back to app, search box, and Workspace items", () => {
    const onBack = vi.fn();
    const onSelect = vi.fn();
    render(
      <SettingsPanel
        active="account"
        onSelect={onSelect}
        onBack={onBack}
      />,
    );

    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to app" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search settings" })).toBeTruthy();

    // Verify sections under Workspace: Team and Remote access
    expect(screen.getByRole("button", { name: "Team" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remote access" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    expect(onSelect).toHaveBeenCalledWith("team");

    fireEvent.click(screen.getByRole("button", { name: "Back to app" }));
    expect(onBack).toHaveBeenCalled();
  });

  it("filters section items via the search input", () => {
    render(<SettingsPanel active="account" onSelect={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Appearance" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Team" })).toBeTruthy();

    const searchInput = screen.getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(searchInput, { target: { value: "Remote" } });

    expect(screen.getByRole("button", { name: "Remote access" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Appearance" })).toBeNull();
  });
});

describe("SettingsPage", () => {
  it("renders breadcrumb Settings > <Section> and updates with the selected section", () => {
    const onBack = vi.fn();
    const { rerender } = render(
      <SettingsPage section="account" onBack={onBack} />,
    );

    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(breadcrumb).toBeTruthy();
    expect(breadcrumb.textContent).toContain("Settings");
    expect(breadcrumb.textContent).toContain("Account");

    // Switch section to Appearance
    rerender(<SettingsPage section="appearance" onBack={onBack} />);
    expect(breadcrumb.textContent).toContain("Appearance");

    // Click back button in header
    const backBtn = screen.getByRole("button", { name: "Back to app" });
    fireEvent.click(backBtn);
    expect(onBack).toHaveBeenCalled();
  });

  it("renders TeamWorkspaceView when section is team", () => {
    const fetcher = vi.fn(async () => Response.json({ workspace: null }));
    vi.stubGlobal("fetch", fetcher);

    render(
      <SettingsPage
        section="team"
        actorId="test@example.com"
        workspaceId="ws_123"
      />,
    );

    expect(screen.getByLabelText("Team workspace settings")).toBeTruthy();
  });

  it("renders RemoteAccessView when section is remote", () => {
    const fetcher = vi.fn(async () => Response.json({ computers: [] }));
    vi.stubGlobal("fetch", fetcher);

    render(<SettingsPage section="remote" />);
    expect(screen.getByRole("heading", { name: /Remote Access/i })).toBeTruthy();
  });

  it("renders with panel side-by-side when withPanel is true", () => {
    const onSelect = vi.fn();
    render(
      <SettingsPage
        section="account"
        withPanel
        onSectionChange={onSelect}
      />,
    );

    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
  });
});
