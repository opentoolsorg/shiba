// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CollaborationView } from "./CollaborationView";

beforeEach(() => vi.stubGlobal("WebSocket", undefined));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CollaborationView channels tab", () => {
  it("renders the channels tab and lists channel rooms", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        const channelRoom = {
          roomId: "chn_demo",
          title: "General",
          visibility: "shared",
          kind: "channel",
          unreadCount: 2,
        };
        if (path.includes("kind=room")) return Response.json({ rooms: [] });
        if (path.includes("kind=dm")) return Response.json({ rooms: [] });
        if (path.includes("kind=channel")) return Response.json({ rooms: [channelRoom] });
        if (path === "/api/collaboration/rooms") {
          return Response.json({ rooms: [channelRoom] });
        }
        if (path === "/api/workspace-notifications") {
          return Response.json({ notifications: [] });
        }
        if (path === `/api/collaboration/rooms/chn_demo`) {
          return Response.json({
            room: { roomId: "chn_demo", title: "General", visibility: "shared" },
            currentUserId: "user@example.test",
            members: [],
            messages: [],
            handoffs: [],
          });
        }
        return Response.json({ agents: [], computers: [] });
      }),
    );

    render(<CollaborationView />);

    await waitFor(() => expect(screen.getByRole("tab", { name: /Channels/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /Channels/ }));

    expect(await screen.findByRole("button", { name: /General/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Channels.*\(2\)/ })).toBeTruthy();
  });
});