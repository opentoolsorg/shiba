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

  it("submits an explicit repo-free artifact workspace for a room employee request", async () => {
    let submitted: Record<string, unknown> | null = null;
    const detail = {
      ...roomDetail,
      currentUserId: "owner@example.test",
      members: [
        { actorId: "human:owner@example.test", userId: "owner@example.test", role: "owner", actorKind: "human", displayName: "Owner" },
        { actorId: "agent:writer-profile", userId: "owner@example.test", role: "agent", actorKind: "agent", displayName: "Report Writer" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/custom-agents") return jsonResponse({ agents: [{ id: "writer-profile", version: 2, slug: "report-writer", config: { name: "Report Writer" } }] });
      if (path === "/api/computers") return jsonResponse({ computers: [] });
      if (path === "/api/collaboration/rooms") return jsonResponse({ rooms: [{ roomId: "room-1", title: "Shared room", visibility: "private" }] });
      if (path === "/api/collaboration/rooms/room-1/handoffs" && init?.method === "POST") {
        submitted = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({ handoff: { handoffId: "handoff-1", taskId: submitted.taskId, status: "active" } }, 201);
      }
      if (path === "/api/collaboration/rooms/room-1") return jsonResponse(detail);
      throw new Error(`Unexpected request ${path}`);
    }));

    render(<CollaborationView />);
    await screen.findByRole("heading", { name: "Shared room" });
    fireEvent.change(screen.getByLabelText("Task ID"), { target: { value: "meeting-summary" } });
    fireEvent.change(screen.getByLabelText("Employee task request"), { target: { value: "Summarize these meeting notes." } });
    fireEvent.change(screen.getByLabelText("Employee work destination"), { target: { value: "artifact-workspace" } });
    fireEvent.change(screen.getByLabelText("Expected deliverable paths"), { target: { value: "reports/meeting-summary.md" } });
    fireEvent.change(screen.getByLabelText("Handoff recipient"), { target: { value: "agent:writer-profile" } });
    fireEvent.click(screen.getByRole("button", { name: "Request / create handoff" }));

    await waitFor(() => expect(submitted).toMatchObject({
      taskId: "meeting-summary",
      task: "Summarize these meeting notes.",
      executionTarget: { kind: "artifact-workspace", expectedDeliverables: ["reports/meeting-summary.md"] },
      runtime: "sandbox",
      recipientActorId: "agent:writer-profile",
    }));
    const submittedBody = submitted as Record<string, unknown> | null;
    expect(submittedBody?.repoUrl).toBeUndefined();
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

  it("lets a room owner map only an observed Slack thread and shows link status", async () => {
    let mapped = false;
    const slackSource = {
      teamId: "T123",
      channelId: "C123",
      threadTs: "1710000000.000100",
      lastSeenAt: 100,
      lastUserId: "U123",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.endsWith("/api/custom-agents")) return jsonResponse({ agents: [] });
        if (path.endsWith("/api/collaboration/rooms"))
          return jsonResponse({ rooms: [{ roomId: "room-1", title: "Shared room", visibility: "private" }] });
        if (path.endsWith("/api/collaboration/rooms/room-1/slack-links") && init?.method === "POST") {
          expect(JSON.parse(String(init.body))).toEqual({
            teamId: slackSource.teamId,
            channelId: slackSource.channelId,
            threadTs: slackSource.threadTs,
          });
          mapped = true;
          return jsonResponse({ link: { linkId: "link-1" } }, 201);
        }
        if (path.endsWith("/api/collaboration/rooms/room-1")) {
          return jsonResponse({
            ...roomDetail,
            currentUserId: "member@example.test",
            members: [{ ...roomDetail.members[0], role: "owner" }],
            slackSources: mapped ? [] : [slackSource],
            slackLinks: mapped
              ? [{ linkId: "link-1", roomId: "room-1", ...slackSource, status: "active", outboundConfigured: false }]
              : [],
            slackDeliveryIntents: [],
          });
        }
        throw new Error(`Unexpected request ${path}`);
      }),
    );

    render(<CollaborationView />);
    fireEvent.change(await screen.findByRole("combobox", { name: "Verified Slack thread" }), {
      target: { value: "T123|C123|1710000000.000100" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(await screen.findByText(/active: T123\/C123\/1710000000.000100/)).toBeTruthy();
    expect(screen.getByText(/Outbound delivery is disabled/)).toBeTruthy();
  });

  it("shows the dashboard approval action and refreshes the persisted Slack receipt", async () => {
    let approved = false;
    const detail = () => ({
      ...roomDetail,
      currentUserId: "owner@example.test",
      members: [{ ...roomDetail.members[0], userId: "owner@example.test", actorId: "human:owner@example.test", role: "owner" }],
      slackLinks: [{ linkId: "link-1", roomId: "room-1", teamId: "T123", channelId: "C123", threadTs: "1710000000.000100", status: "active", outboundConfigured: true }],
      slackDeliveryIntents: [{
        intentId: "intent-1", messageId: "m1", channelId: "C123", threadTs: "1710000000.000100",
        content: "Confidential room note",
        status: "pending", deliveryStatus: approved ? "sent" : "awaiting_approval",
        receiptTs: approved ? "1710000009.000900" : null,
      }],
      canApproveSlackOutbox: true,
      slackOutboxEnabled: true,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/api/custom-agents")) return jsonResponse({ agents: [] });
      if (path.endsWith("/api/collaboration/rooms"))
        return jsonResponse({ rooms: [{ roomId: "room-1", title: "Shared room", visibility: "private" }] });
      if (path.endsWith("/slack-delivery/intent-1/approve") && init?.method === "POST") {
        approved = true;
        return jsonResponse({ delivery: { status: "sent", channel: "C123", ts: "1710000009.000900" } });
      }
      if (path.endsWith("/api/collaboration/rooms/room-1")) return jsonResponse(detail());
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CollaborationView />);
    expect(await screen.findByText("Approved content: Confidential room note")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Approve and send" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) =>
      String(input).endsWith("/slack-delivery/intent-1/approve") && init?.method === "POST",
    )).toBe(true));
    await waitFor(() => expect(screen.getByText(/Slack receipt 1710000009\.000900/)).toBeTruthy());
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
