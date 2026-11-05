// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatsPanel } from "./ChatsPanel";
import type { SessionItem } from "./SessionsSidebar";

afterEach(() => {
  cleanup();
});

const MOCK_SESSIONS: SessionItem[] = [
  {
    id: "sess-1",
    title: "Implement auth provider",
    repoName: "acme/auth",
    status: "running",
    updatedAt: Date.now(),
  },
  {
    id: "sess-2",
    title: "Refactor API routing",
    repoName: "acme/backend",
    status: "completed",
    updatedAt: Date.now() - 3600_000,
  },
];

const MOCK_TEAM_ROOMS = [
  { id: "room-1", title: "General Engineering", unread: true },
  { id: "room-2", title: "Handoff: Infra deployment", unread: false },
];

const MOCK_CHANNELS = [
  { id: "chan-1", title: "incident-response", memberCount: 5 },
  { id: "chan-2", title: "agent-evals", memberCount: 3 },
];

const MOCK_ACTIVITY = [
  { id: "act-1", title: "Shiba completed PR #42", description: "All checks passed" },
];

describe("ChatsPanel", () => {
  it("renders Personal scope with Recents and session rows", () => {
    const onSelect = vi.fn();
    const onScopeChange = vi.fn();

    render(
      <ChatsPanel
        scope="personal"
        onScopeChange={onScopeChange}
        active="sess-1"
        onSelect={onSelect}
        sessions={MOCK_SESSIONS}
      />,
    );

    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Personal" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Implement auth provider")).toBeTruthy();
    expect(screen.getByText("Refactor API routing")).toBeTruthy();

    const activeRow = screen.getByRole("button", { name: /Implement auth provider/ });
    expect(activeRow.getAttribute("aria-current")).toBe("page");

    fireEvent.click(screen.getByRole("button", { name: /Refactor API routing/ }));
    expect(onSelect).toHaveBeenCalledWith("sess-2");
  });

  it("shows empty state when no personal chats exist", () => {
    render(
      <ChatsPanel
        scope="personal"
        onScopeChange={vi.fn()}
        active=""
        onSelect={vi.fn()}
        sessions={[]}
      />,
    );

    expect(screen.getByText("No personal chats yet")).toBeTruthy();
  });

  it("filters sessions in personal scope when searching", () => {
    render(
      <ChatsPanel
        scope="personal"
        onScopeChange={vi.fn()}
        active=""
        onSelect={vi.fn()}
        sessions={MOCK_SESSIONS}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Search chats" }));
    const searchInput = screen.getByPlaceholderText("Search chats…");
    fireEvent.change(searchInput, { target: { value: "auth" } });

    expect(screen.getByText("Implement auth provider")).toBeTruthy();
    expect(screen.queryByText("Refactor API routing")).toBeNull();
  });

  it("renders Workspace scope with Chats, Channels, and Activity", () => {
    const onSelectTeamRoom = vi.fn();
    const onSelectChannel = vi.fn();
    const onNewChannel = vi.fn();

    render(
      <ChatsPanel
        scope="workspace"
        onScopeChange={vi.fn()}
        active="chan-1"
        onSelect={vi.fn()}
        teamRooms={MOCK_TEAM_ROOMS}
        onSelectTeamRoom={onSelectTeamRoom}
        channels={MOCK_CHANNELS}
        onSelectChannel={onSelectChannel}
        onNewChannel={onNewChannel}
        activityItems={MOCK_ACTIVITY}
      />,
    );

    expect(screen.getByRole("tab", { name: "Workspace" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("General Engineering")).toBeTruthy();
    expect(screen.getByText("incident-response")).toBeTruthy();
    expect(screen.getByText("Shiba completed PR #42")).toBeTruthy();

    // Active channel
    const activeChan = screen.getByRole("button", { name: /incident-response/ });
    expect(activeChan.getAttribute("aria-current")).toBe("page");

    // Click channel
    fireEvent.click(activeChan);
    expect(onSelectChannel).toHaveBeenCalledWith("chan-1");

    // Click team room
    fireEvent.click(screen.getByRole("button", { name: /General Engineering/ }));
    expect(onSelectTeamRoom).toHaveBeenCalledWith("room-1");

    // Channels has a "+" button to create collaboration rooms
    const addChanBtn = screen.getByRole("button", { name: "New channel" });
    fireEvent.click(addChanBtn);
    expect(onNewChannel).toHaveBeenCalled();
  });

  it("shows bell and 'No activity yet.' when activity is empty", () => {
    render(
      <ChatsPanel
        scope="workspace"
        onScopeChange={vi.fn()}
        active=""
        onSelect={vi.fn()}
        activityItems={[]}
      />,
    );

    expect(screen.getByText("No activity yet.")).toBeTruthy();
  });
});
