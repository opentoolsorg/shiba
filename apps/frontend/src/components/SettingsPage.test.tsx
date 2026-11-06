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

  it("forwards Slack setup from Team settings", async () => {
    const id = `ws_${"a".repeat(24)}`;
    const fetcher = vi.fn(async () => Response.json({ workspace: {
      workspaceId: id, name: "Acme team", version: 1, createdAt: 1,
      membership: { workspaceId: id, userId: "test@example.com", role: "owner", version: 1, joinedAt: 1 },
      members: [{ workspaceId: id, userId: "test@example.com", role: "owner", version: 1, joinedAt: 1 }],
      invitations: [],
    } }));
    vi.stubGlobal("fetch", fetcher);
    const onOpenApps = vi.fn();

    render(
      <SettingsPage
        section="team"
        actorId="test@example.com"
        workspaceId={id}
        onOpenApps={onOpenApps}
      />,
    );

    expect(screen.getByLabelText("Team workspace settings")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Open Slack setup" }));
    expect(onOpenApps).toHaveBeenCalledOnce();
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

describe("SettingsPage private data gate", () => {
  it("shows only the notice for personal sections when private data is blocked", () => {
    render(<SettingsPage section="account" personalDataBlocked />);
    expect(screen.getByRole("region", { name: "Personal workspace setting" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Switch to personal workspace" })).toBeNull();
  });
});
