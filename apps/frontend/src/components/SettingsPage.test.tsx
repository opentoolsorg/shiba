// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SettingsPage, SettingsPanel, normalizeSettingsSection } from "./SettingsPage";

const linkSocial = vi.fn();
vi.mock("../auth-client", () => ({ authClient: { linkSocial: (...args: unknown[]) => linkSocial(...args), signOut: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => Response.json({}))));

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

    expect(screen.getByRole("button", { name: "Providers" })).toBeTruthy();

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
  it("offers Workspace facts in navigation and mounts the settings list", async () => {
    const onSelect = vi.fn();
    render(<SettingsPanel active="workspace-facts" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Workspace facts" }));
    expect(onSelect).toHaveBeenCalledWith("workspace-facts");
    cleanup();
    render(<SettingsPage section="workspace-facts" />);
    expect(await screen.findByText("No workspace facts saved yet.")).toBeTruthy();
  });
  it("offers Slack settings and setup steps when only one Slack secret is configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ slack: { botToken: true, signingSecret: false } })));
    const onSelect = vi.fn();
    render(<SettingsPanel active="slack" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Slack" }));
    expect(onSelect).toHaveBeenCalledWith("slack");
    cleanup();
    render(<SettingsPage section="slack" />);
    await screen.findByTestId("slack-setup-card");
    expect(screen.queryByRole("alert")).toBeNull();
  });
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

  it("offers only configured social identity links for the signed-in Better Auth account", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return url === "/api/whoami"
        ? Response.json({ agent: "owner@example.com", auth: "better-auth" })
        : Response.json({ providers: { google: true, slack: false } });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<SettingsPage section="account" />);
    expect(await screen.findByRole("button", { name: "Link Google" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Link Slack" })).toBeNull();
    expect(screen.getByText(/does not install a Slack app/i)).toBeTruthy();
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

  it("explains experimental features in plain language and keeps deployment switches read-only", () => {
    render(<SettingsPage section="experimental" />);

    expect(screen.getByRole("heading", { name: "Experimental features" })).toBeTruthy();
    expect(screen.getByText(/cannot change deployment settings or check which options are currently turned on/i)).toBeTruthy();
    expect(screen.queryByText("Claude subscription sign-in")).toBeNull();
    expect(screen.getByText(/subscription kill switch to 0/)).toBeTruthy();
    expect(screen.getByText("Use a connected computer")).toBeTruthy();
    expect(screen.getByText("Memory summaries")).toBeTruthy();
    expect(screen.getByText("Hosted models")).toBeTruthy();
    expect(screen.getByText("SHIBA_HOSTED_PROVIDER_KILL_SWITCH")).toBeTruthy();
    expect(screen.getAllByText("Setup details for admins")).toHaveLength(3);
    const adminDetails = screen.getAllByText("Setup details for admins")[0]!;
    expect(adminDetails.closest("details")?.open).toBe(false);
    fireEvent.click(adminDetails);
    expect(adminDetails.closest("details")?.open).toBe(true);
    expect(screen.getByText("SHIBA_LOCAL_RUNTIME=1")).toBeTruthy();
  });

  it("opens the shared provider cards from the Experimental link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ providers: [], defaultProviderId: null })));
    render(<SettingsPage initialSection="experimental" />);
    fireEvent.click(screen.getByRole("button", { name: "Manage in Providers →" }));
    expect(await screen.findByTestId("providers-page")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Providers" })).toBeTruthy();
    expect(screen.getByText(/Tokens are encrypted for you/)).toBeTruthy();
  });

  it("keeps provider setup unavailable for invited accounts without a grant", () => {
    const fetcher = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetcher);
    render(<SettingsPage section="providers" providersBlocked />);
    expect(screen.getByRole("region", { name: "Personal provider setup unavailable" })).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
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

describe("hosted models kill switch notice", () => {
  it("tells provider users when an admin paused hosted models", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("/api/setup/status")
      ? Response.json({ gateway: { id: "default", token: true, reachable: "yes", hostedAccessStopped: true } })
      : Response.json({ providers: [], defaultProviderId: null })));
    render(<SettingsPage section="providers" />);
    expect(await screen.findByText("Hosted models are paused")).toBeTruthy();
  });
});

describe("SettingsPage overview", () => {
  const categories = [
    "Account",
    "Repositories",
    "Providers & models",
    "Connected apps",
    "Employee access",
    "Workspace",
    "Appearance & notifications",
    "Skills",
  ];

  it("renders the overview heading, one card per supported area, and the approval boundary without requesting data", () => {
    const fetcher = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetcher);
    render(<SettingsPage section="overview" onNavigate={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Settings overview" })).toBeTruthy();
    const list = within(screen.getByRole("region", { name: "Settings categories" })).getByRole("list");
    expect(within(list).getAllByRole("heading").map((heading) => heading.textContent)).toEqual(categories);

    const note = screen.getByRole("note", { name: "Approval boundary" });
    expect(note.textContent).toMatch(/does not grant any employee access by itself/);
    expect(note.textContent).toMatch(/Interactive tasks require approval of exact inputs/);
    expect(note.textContent).toMatch(/automations follow their configured allowlists/);

    expect(screen.queryByText(/plugin|marketplace|purchase|install/i)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain("Overview");
  });

  it.each([
    ["Manage account", "account"],
    ["Manage repositories", "repositories"],
    ["Review providers", "providers"],
    ["Review model routing", "models"],
    ["Review connected apps", "connected-apps"],
    ["Team", "team"],
    ["Sandbox", "sandbox"],
    ["Appearance", "appearance"],
    ["Notifications", "notifications"],
  ])("the %s action opens the %s section", (label, sectionId) => {
    const onSectionChange = vi.fn();
    render(<SettingsPage section="overview" onSectionChange={onSectionChange} onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(onSectionChange).toHaveBeenCalledExactlyOnceWith(sectionId);
  });

  it("opens employee access and skills through onNavigate, and omits both cards without it", () => {
    const onNavigate = vi.fn();
    const { unmount } = render(<SettingsPage section="overview" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Manage employee access" }));
    expect(onNavigate).toHaveBeenLastCalledWith("employee-tools");
    fireEvent.click(screen.getByRole("button", { name: "Open skills" }));
    expect(onNavigate).toHaveBeenLastCalledWith("skills");
    expect(onNavigate).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/A connection never grants access by itself/)).toBeTruthy();
    unmount();

    render(<SettingsPage section="overview" />);
    expect(screen.queryByRole("heading", { name: "Employee access" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Skills" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Account" })).toBeTruthy();
  });

  it("is the uncontrolled default and navigates in place to a real section", () => {
    render(<SettingsPage />);
    expect(screen.getByRole("heading", { name: "Settings overview" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.queryByRole("heading", { name: "Settings overview" })).toBeNull();
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain("Appearance");
  });

  it("keeps provider setup unavailable on the overview for invited accounts", () => {
    render(<SettingsPage section="overview" providersBlocked onNavigate={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Review providers" })).toBeNull();
    expect(screen.getByText(/explicit account grant for invited accounts/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review model routing" })).toBeTruthy();
  });

  it("limits the overview to Team settings inside a team workspace", () => {
    const onSectionChange = vi.fn();
    const onOpenPersonalWorkspace = vi.fn();
    render(
      <SettingsPage
        section="overview"
        onSectionChange={onSectionChange}
        onOpenPersonalWorkspace={onOpenPersonalWorkspace}
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.getByRole("region", { name: "Personal workspace setting" })).toBeTruthy();
    const list = within(screen.getByRole("region", { name: "Settings categories" })).getByRole("list");
    expect(within(list).getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["Workspace"]);
    for (const hidden of ["Manage account", "Review providers", "Manage repositories", "Manage employee access", "Open skills", "Groups", "Sandbox"]) {
      expect(screen.queryByRole("button", { name: hidden })).toBeNull();
    }
    expect(screen.getByRole("note", { name: "Approval boundary" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    expect(onSectionChange).toHaveBeenCalledExactlyOnceWith("team");
    fireEvent.click(screen.getByRole("button", { name: "Switch to personal workspace" }));
    expect(onOpenPersonalWorkspace).toHaveBeenCalledOnce();
  });

  it("offers no switch action on the overview when private data is blocked without a personal workspace", () => {
    render(<SettingsPage section="overview" personalDataBlocked />);
    expect(screen.getByRole("region", { name: "Personal workspace setting" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Switch to personal workspace" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage account" })).toBeNull();
  });

  it("still gates every non-overview personal section behind the team notice", () => {
    render(<SettingsPage section="repositories" onOpenPersonalWorkspace={vi.fn()} />);
    const notice = screen.getByRole("region", { name: "Personal workspace setting" });
    expect(notice.textContent).toContain("Repositories applies to your account or this deployment");
    expect(screen.queryByRole("heading", { name: "Settings overview" })).toBeNull();
  });

  it("lists Overview in the settings navigation and section switcher while keeping existing deep links", () => {
    const onSelect = vi.fn();
    const { unmount } = render(<SettingsPanel active="overview" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(onSelect).toHaveBeenCalledWith("overview");
    unmount();

    render(<SettingsPage section="overview" showSectionSwitcher />);
    const switcher = screen.getByRole("combobox", { name: "Settings section" }) as HTMLSelectElement;
    expect(switcher.value).toBe("overview");
    expect(within(switcher).getByRole("option", { name: "Overview" })).toBeTruthy();

    expect(normalizeSettingsSection("overview")).toBe("overview");
    for (const id of ["account", "providers", "connected-apps", "team", "repositories", "appearance", "notifications"]) {
      expect(normalizeSettingsSection(id)).toBe(id);
    }
    expect(normalizeSettingsSection(null)).toBe("account");
    expect(normalizeSettingsSection("not-a-section")).toBe("account");
  });
});
