// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationView } from "./CollaborationView";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const roomDetail = {
  room: { roomId: "room-1", title: "Shared room", visibility: "private" },
  currentUserId: "member@example.test",
  members: [
    {
      actorId: "human:member@example.test",
      userId: "member@example.test",
      role: "member",
      actorKind: "human",
      displayName: "Member",
    },
  ],
  messages: [
    {
      messageId: "m1",
      senderUserId: "owner@example.test",
      senderActorId: "human:owner@example.test",
      senderKind: "human",
      body: "Confidential room note",
      createdAt: 1,
    },
  ],
  handoffs: [],
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("CollaborationView room access polling", () => {
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

  it("renders a persisted employee reply with its completed run and artifact references", async () => {
    const employeeReplyRoom = {
      ...roomDetail,
      members: [
        ...roomDetail.members,
        {
          actorId: "agent:profile-release-reviewer",
          userId: "owner@example.test",
          role: "agent",
          actorKind: "agent",
          displayName: "Release Reviewer",
        },
      ],
      messages: [
        {
          messageId: "agent_reply_handoff-1",
          senderUserId: "owner@example.test",
          senderActorId: "agent:profile-release-reviewer",
          senderKind: "agent",
          body: "Completed approved task: release-42\nNo blockers found.",
          createdAt: 100,
          sourceRunId: "agent-tool:approval-1",
          sourceArtifactRefs: [{ index: 0, path: "reports/review.md", artifactId: "artifact-1" }],
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith("/api/custom-agents")) return jsonResponse({ agents: [] });
        if (path.endsWith("/api/collaboration/rooms"))
          return jsonResponse({ rooms: [{ roomId: "room-1", title: "Shared room", visibility: "private" }] });
        if (path.endsWith("/api/collaboration/rooms/room-1"))
          return jsonResponse(employeeReplyRoom);
        throw new Error(`Unexpected request ${path}`);
      }),
    );

    render(<CollaborationView />);
    expect((await screen.findAllByText("Release Reviewer")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/No blockers found/)).toBeTruthy();
    expect(screen.getByText("Completed run: agent-tool:approval-1")).toBeTruthy();
    expect(screen.getByRole("link", { name: "reports/review.md" }).getAttribute("href"))
      .toBe("/api/runs/agent-tool%3Aapproval-1/deliverables/0");
  });

  it("removes stale room content when another session revokes this member before the next poll", async () => {
    let revokedBySecondSession = false;
    let poll: (() => void) | undefined;
    vi.spyOn(window, "setInterval").mockImplementation((callback) => {
      poll = callback as () => void;
      return {} as ReturnType<typeof window.setInterval>;
    });
    vi.spyOn(window, "clearInterval").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith("/api/custom-agents")) return jsonResponse({ agents: [] });
        if (path.endsWith("/api/collaboration/rooms")) {
          return jsonResponse({
            rooms: revokedBySecondSession
              ? []
              : [{ roomId: "room-1", title: "Shared room", visibility: "private" }],
          });
        }
        if (path.endsWith("/api/collaboration/rooms/room-1")) {
          return revokedBySecondSession
            ? jsonResponse({ error: "Room not found." }, 404)
            : jsonResponse(roomDetail);
        }
        throw new Error(`Unexpected request ${path}`);
      }),
    );

    render(<CollaborationView />);
    expect(await screen.findByText("Confidential room note")).toBeTruthy();
    expect(screen.getByLabelText("Message")).toBeTruthy();

    // A separate authenticated session removes this member from the room.
    revokedBySecondSession = true;
    await act(async () => {
      poll?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByText("Confidential room note")).toBeNull());
    expect(screen.queryByLabelText("Message")).toBeNull();
    expect(screen.queryByText("Shared room")).toBeNull();
  });

  it("keeps room content visible during a transient network failure and offers retry", async () => {
    let failNextRead = false;
    let poll: (() => void) | undefined;
    vi.spyOn(window, "setInterval").mockImplementation((callback) => {
      poll = callback as () => void;
      return {} as ReturnType<typeof window.setInterval>;
    });
    vi.spyOn(window, "clearInterval").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith("/api/custom-agents")) return jsonResponse({ agents: [] });
        if (path.endsWith("/api/collaboration/rooms"))
          return jsonResponse({
            rooms: [{ roomId: "room-1", title: "Shared room", visibility: "private" }],
          });
        if (path.endsWith("/api/collaboration/rooms/room-1")) {
          if (failNextRead) throw new Error("network unavailable");
          return jsonResponse(roomDetail);
        }
        throw new Error(`Unexpected request ${path}`);
      }),
    );

    render(<CollaborationView />);
    expect(await screen.findByText("Confidential room note")).toBeTruthy();
    failNextRead = true;
    await act(async () => {
      poll?.();
      await Promise.resolve();
    });
    expect(await screen.findByText("Confidential room note")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
