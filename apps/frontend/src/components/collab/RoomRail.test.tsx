// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RoomRail } from "./RoomRail";

afterEach(cleanup);

it("shows DM unread badges and the active room's online count", () => {
  render(<RoomRail roomListTab="dm" tabUnread={{ channel: 0, dm: 3, room: 0 }}
    rooms={[{ roomId: "dm-a", title: "Asha", visibility: "private", unreadCount: 3 }, { roomId: "dm-b", title: "Ben", visibility: "private" }]}
    savedItems={[]} activeRoomId="dm-a" activePresenceCount={2} roomTitle="" roomVisibility="private" busy={false}
    onTab={vi.fn()} onCreate={vi.fn()} onTitle={vi.fn()} onVisibility={vi.fn()} onOpenSaved={vi.fn()} onSelectRoom={vi.fn()} />);
  expect(screen.getByRole("tab", { name: "DMs (3)" })).toBeTruthy();
  expect(within(screen.getByRole("button", { name: /Asha/ })).getByText("3")).toBeTruthy();
  expect(screen.getByLabelText("2 online")).toBeTruthy();
  expect(within(screen.getByRole("button", { name: /Ben/ })).queryByLabelText("2 online")).toBeNull();
});
