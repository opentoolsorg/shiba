// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CollaborationView } from "./CollaborationView";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CollaborationView", () => {
  it("creates a room, reloads it, and persists a human message through the UI", async () => {
    let roomExists = false;
    const messages: Array<{ messageId: string; senderUserId: string; senderActorId: string; senderKind: "human"; body: string; createdAt: number }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/collaboration/rooms" && init?.method === "POST") {
        roomExists = true;
        return Response.json({ room: { roomId: "room-one", title: "Release planning", visibility: "private", memberCount: 1 } }, { status: 201 });
      }
      if (path === "/api/collaboration/rooms") {
        return Response.json({ rooms: roomExists ? [{ roomId: "room-one", title: "Release planning", visibility: "private", memberCount: 1 }] : [] });
      }
      if (path === "/api/collaboration/rooms/room-one/messages" && init?.method === "POST") {
        messages.push({ messageId: "message-one", senderUserId: "owner@example.test", senderActorId: "human:owner@example.test", senderKind: "human", body: JSON.parse(String(init.body)).body, createdAt: 100 });
        return Response.json({ message: messages.at(-1) }, { status: 201 });
      }
      if (path === "/api/collaboration/rooms/room-one") {
        return Response.json({
          room: { roomId: "room-one", title: "Release planning", visibility: "private", memberCount: 1 },
          currentUserId: "owner@example.test",
          members: [{ roomId: "room-one", userId: "owner@example.test", displayName: "owner@example.test", actorId: "human:owner@example.test", actorKind: "human", role: "owner", status: "active" }],
          messages,
          handoffs: [],
        });
      }
      return Response.json({ error: "Unexpected request" }, { status: 404 });
    }));

    render(<CollaborationView />);
    fireEvent.change(screen.getByRole("textbox", { name: "New room title" }), { target: { value: "Release planning" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByRole("heading", { name: "Release planning" });

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "I will own the rollout." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText("I will own the rollout.")).toBeTruthy());
    expect(messages).toHaveLength(1);
  });
});
