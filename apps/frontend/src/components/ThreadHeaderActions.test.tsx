// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadHeaderActions } from "./ThreadHeaderActions";
import type { ConversationRoomViewer } from "../conversation-room-realtime";

afterEach(() => {
  cleanup();
});

const MOCK_VIEWERS: ConversationRoomViewer[] = [
  { viewerId: "v-1", joinedAt: 1, typing: false, label: "Alice Moderator" },
  { viewerId: "v-2", joinedAt: 2, typing: true, label: "Bob Member" },
  { viewerId: "v-3", joinedAt: 3, typing: false, label: "Shiba Agent" },
];

describe("ThreadHeaderActions", () => {
  it("displays participant count and toggles people panel", () => {
    render(
      <ThreadHeaderActions
        viewers={MOCK_VIEWERS}
        viewerId="v-1"
        currentUserName="Alice Moderator"
      />,
    );

    const peopleBtn = screen.getByRole("button", { name: "People · 3 in this room" });
    expect(peopleBtn).toBeTruthy();
    expect(peopleBtn.getAttribute("aria-expanded")).toBe("false");

    // Open panel
    fireEvent.click(peopleBtn);
    expect(peopleBtn.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog", { name: "People · 3 in this room" })).toBeTruthy();
    expect(screen.getByText("Alice Moderator (you)")).toBeTruthy();
    expect(screen.getByText("Bob Member")).toBeTruthy();
    expect(screen.getByText("Shiba Agent")).toBeTruthy();

    // Check roles
    expect(screen.getByText("Moderator")).toBeTruthy();
    expect(screen.getByText("Member")).toBeTruthy();
    expect(screen.getByText("Agent")).toBeTruthy();
  });

  it("shows Add people button only when canInvite or onAddPeople is provided", () => {
    const onAddPeople = vi.fn();
    const { rerender } = render(
      <ThreadHeaderActions
        viewers={MOCK_VIEWERS}
        viewerId="v-1"
        canInvite={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /People · 3 in this room/ }));
    expect(screen.queryByRole("button", { name: "Add people" })).toBeNull();

    // With onAddPeople provided
    rerender(
      <ThreadHeaderActions
        viewers={MOCK_VIEWERS}
        viewerId="v-1"
        canInvite={true}
        onAddPeople={onAddPeople}
      />,
    );

    const addBtn = screen.getByRole("button", { name: "Add people" });
    expect(addBtn).toBeTruthy();
    fireEvent.click(addBtn);
    expect(onAddPeople).toHaveBeenCalled();
  });

  it("opens '…' menu and invokes supported Shiba actions", () => {
    const onRename = vi.fn();
    const onArchive = vi.fn();
    const onShareLink = vi.fn();
    const onClear = vi.fn();

    render(
      <ThreadHeaderActions
        sessionId="sess-123"
        onRename={onRename}
        onArchive={onArchive}
        onShareLink={onShareLink}
        onClear={onClear}
      />,
    );

    const moreBtn = screen.getByRole("button", { name: "More actions" });
    expect(moreBtn.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(moreBtn);
    expect(moreBtn.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu", { name: "Thread actions" })).toBeTruthy();

    // Share link
    fireEvent.click(screen.getByRole("menuitem", { name: "Share link" }));
    expect(onShareLink).toHaveBeenCalled();

    // Reopen menu
    fireEvent.click(moreBtn);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(onRename).toHaveBeenCalled();

    // Reopen menu
    fireEvent.click(moreBtn);
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear chat" }));
    expect(onClear).toHaveBeenCalled();

    // Reopen menu
    fireEvent.click(moreBtn);
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive thread" }));
    expect(onArchive).toHaveBeenCalled();
  });
});
