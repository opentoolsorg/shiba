// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollaborationView } from "./CollaborationView";
import { personalFixture, PERSONAL_WORKSPACE } from "../personal-execution-fixtures";
import { teamModelFixture, TEAM_MODEL_ROOM } from "../team-model-fixtures";

beforeEach(() => vi.stubGlobal("WebSocket", undefined));

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

describe("CollaborationView explicit funded model setup", () => {
  it("mounts funding and account verification once only after their explicit controls are opened", async () => {
    const detail = { ...roomDetail, room: { ...roomDetail.room, roomId: TEAM_MODEL_ROOM } };
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/collaboration/rooms") return Response.json({ rooms: [detail.room] });
      if (path === `/api/collaboration/rooms/${TEAM_MODEL_ROOM}`) return Response.json(detail);
      if (path.startsWith("/api/team-model-sessions/state")) return Response.json(teamModelFixture().state);
      if (path.includes("bootstrap")) return Response.json({ error: "unavailable_fixture" }, { status: 403 });
      return Response.json({ agents: [], computers: [] });
    }); vi.stubGlobal("fetch", fetcher);
    render(<CollaborationView workspaceId={PERSONAL_WORKSPACE} />);
    await screen.findByRole("heading", { name: "Shared room" }); fireEvent.click(screen.getByRole("tab", { name: "Work" }));
    expect(fetcher.mock.calls.some(([path]) => String(path).includes("team-model-sessions") || String(path).includes("bootstrap"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Open funded team text sessions" }));
    await screen.findByLabelText("My text-session funding grant");
    expect(fetcher.mock.calls.filter(([path]) => String(path).includes("team-model-sessions"))).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Check my account verification" }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([path]) => String(path).includes("bootstrap"))).toHaveLength(1));
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });
});

describe("CollaborationView explicit own-account request", () => {
  it("submits only a current grant selector and never a deployment or client snapshot override", async () => {
    const { computer, grant } = personalFixture();
    let submitted: Record<string, unknown> | null = null;
    const detail = { ...roomDetail, members: [...roomDetail.members, { actorId: "agent:writer-profile", userId: "member@example.test", actorKind: "agent", role: "agent", displayName: "Writer" }] };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/personal-execution/computers") return Response.json({ computers: [computer] });
      if (path === "/api/personal-execution/grants") return Response.json({ grants: [grant] });
      if (path === "/api/collaboration/rooms/room-1/handoffs" && init?.method === "POST") { submitted = JSON.parse(String(init.body)); return Response.json({ handoff: { handoffId: "fixture", taskId: "own-task", status: "active" } }, { status: 201 }); }
      if (path === "/api/collaboration/rooms") return Response.json({ rooms: [detail.room] });
      if (path === "/api/collaboration/rooms/room-1") return Response.json(detail);
      if (path.startsWith(`/api/workspaces/${PERSONAL_WORKSPACE}`)) return Response.json({ workspace: { members: [] } });
      return Response.json({ agents: [], computers: [] });
    }));
    render(<CollaborationView workspaceId={PERSONAL_WORKSPACE} />);
    await screen.findByRole("heading", { name: "Shared room" }); fireEvent.click(screen.getByRole("tab", { name: "Work" }));
    fireEvent.change(screen.getByLabelText("Task ID"), { target: { value: "own-task" } });
    fireEvent.change(screen.getByLabelText("Employee task request"), { target: { value: "Review this public repository." } });
    fireEvent.change(screen.getByLabelText("Handoff recipient"), { target: { value: "agent:writer-profile" } });
    fireEvent.change(screen.getByLabelText("Account for this room task"), { target: { value: "personal" } });
    expect(screen.getByRole("button", { name: "Request / create handoff" })).toHaveProperty("disabled", true);
    await screen.findByLabelText("Personal account grant for this room task");
    fireEvent.change(screen.getByLabelText("Personal account grant for this room task"), { target: { value: grant.snapshot.grantId } });
    fireEvent.click(screen.getByRole("button", { name: "Request / create handoff" }));
    await waitFor(() => expect(submitted).not.toBeNull());
    expect(submitted).toMatchObject({ personalExecution: { grantId: grant.snapshot.grantId, expectedVersion: 1 }, task: "Review this public repository." });
    for (const field of ["runtime", "targetMachineId", "executionTarget", "repoUrl", "harness", "codingModel", "snapshot", "proof"]) expect(submitted).not.toHaveProperty(field);
  });

  it("keeps personal mode blocked after grant revocation instead of reverting to cloud execution", async () => {
    const { computer, grant } = personalFixture(); let revoked = false;
    const writes = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/personal-execution/computers") return Response.json({ computers: [computer] });
      if (path === "/api/personal-execution/grants") return Response.json({ grants: [{ ...grant, ...(revoked ? { status: "revoked", version: 2 } : {}) }] });
      if (path === "/api/collaboration/rooms") return Response.json({ rooms: [roomDetail.room] });
      if (path === "/api/collaboration/rooms/room-1") return Response.json(roomDetail);
      if (init?.method === "POST") writes();
      return Response.json({ agents: [], computers: [] });
    }));
    render(<CollaborationView workspaceId={PERSONAL_WORKSPACE} />);
    await screen.findByRole("heading", { name: "Shared room" }); fireEvent.click(screen.getByRole("tab", { name: "Work" }));
    fireEvent.change(screen.getByLabelText("Account for this room task"), { target: { value: "personal" } });
    await screen.findByLabelText("Personal account grant for this room task");
    fireEvent.change(screen.getByLabelText("Personal account grant for this room task"), { target: { value: grant.snapshot.grantId } });
    revoked = true; fireEvent.click(screen.getByRole("button", { name: "Reload personal setup" }));
    await waitFor(() => expect(screen.getByLabelText("Personal account grant for this room task")).toHaveProperty("value", ""));
    expect(screen.getByLabelText("Account for this room task")).toHaveProperty("value", "personal");
    expect(screen.queryByLabelText("Employee execution target")).toBeNull();
    expect(screen.getByRole("button", { name: "Request / create handoff" })).toHaveProperty("disabled", true); expect(writes).not.toHaveBeenCalled();
  });
});

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function deferredResponse() {
  let resolve!: (value: ReturnType<typeof jsonResponse>) => void;
  const promise = new Promise<ReturnType<typeof jsonResponse>>((settle) => { resolve = settle; });
  return { promise, resolve };
}

class RoomSocket {
  static OPEN = 1;
  readyState = 0;
  listeners = new Map<string, Array<(event: any) => void>>();
  sent: string[] = [];
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(raw: string) { this.sent.push(raw); }
  open() { this.readyState = 1; this.listeners.get("open")?.forEach((listener) => listener({})); }
  receive(frame: unknown) { this.listeners.get("message")?.forEach((listener) => listener({ data: JSON.stringify(frame) })); }
  close(code = 1000) { this.readyState = 3; this.listeners.get("close")?.forEach((listener) => listener({ code })); }
}

describe("CollaborationView room access polling", () => {
  it("limits cursor sharing to the conversation pane, renders attributed remote pointers and clears on leave/revocation", async () => {
    const sockets: RoomSocket[] = [];
    vi.stubGlobal("WebSocket", class extends RoomSocket { constructor() { super(); sockets.push(this); } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/collaboration/rooms" ? jsonResponse({ rooms: [roomDetail.room] }) : String(input) === "/api/collaboration/rooms/room-1" ? jsonResponse(roomDetail) : jsonResponse({ agents: [], computers: [] })));
    render(<CollaborationView />); await screen.findByText("Confidential room note"); await waitFor(() => expect(sockets).toHaveLength(1));
    act(() => sockets[0]!.open());
    const pane = screen.getByTestId("collaboration-chat-pane");
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue({ left: 100, top: 50, width: 400, height: 200, right: 500, bottom: 250, x: 100, y: 50, toJSON() {} });
    fireEvent.pointerMove(pane, { clientX: 200, clientY: 200 });
    expect(sockets[0]!.sent.map((raw) => JSON.parse(raw))).toContainEqual({ type: "client_presence", cursor: { x: .25, y: .75 } });
    const viewer = { viewerId: "11111111-1111-4111-8111-111111111111", label: "teammate@example.test", typing: false, cursor: { x: .5, y: .25 } };
    act(() => sockets[0]!.receive({ type: "collaboration:presence", roomId: "room-1", viewers: [viewer] }));
    const cursorLayer = screen.getByTestId("collaboration-cursors"); const marker = cursorLayer.querySelector<HTMLElement>("[data-room-cursor-viewer]");
    expect(marker?.style.left).toBe("50%"); expect(marker?.style.top).toBe("25%"); expect(marker?.textContent).toContain("teammate@example.test"); expect(cursorLayer.className).toContain("pointer-events-none"); expect(cursorLayer.getAttribute("aria-hidden")).toBe("true");
    fireEvent.pointerLeave(pane); expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toEqual({ type: "client_presence", cursor: null });
    act(() => sockets[0]!.close(1008)); expect(screen.queryByTestId("collaboration-cursors")).toBeNull();
  });
  it("opens and focuses the exact Work handoff once after authorized detail arrives, without guessing approval authority", async () => {
    const sockets: RoomSocket[] = [];
    const renderApproval = vi.fn(() => <button type="button">Unexpected approval</button>);
    vi.stubGlobal("WebSocket", class extends RoomSocket { constructor() { super(); sockets.push(this); } });
    const handoff = { handoffId: "handoff-first", taskId: "First shared task", senderActorId: "human:owner@example.test", recipientActorId: "agent:writer", parentHandoffId: null, depth: 0, remainingBudget: 0, status: "active", createdAt: 1 };
    let detail = { ...roomDetail, handoffs: [handoff, { ...handoff, handoffId: "handoff-second", taskId: "Exact second shared task", approvalId: "approval-unverified" }] };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/collaboration/rooms") return jsonResponse({ rooms: [roomDetail.room] });
      if (String(input) === "/api/collaboration/rooms/room-1") return jsonResponse(detail);
      return jsonResponse({ agents: [], computers: [] });
    }));
    render(<CollaborationView initialRoomId="room-1" initialHandoffId="handoff-second" renderApproval={renderApproval} />);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Work" }).getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(screen.getByText("Exact second shared task").closest("li"));
    });
    expect(document.activeElement?.id).toBe("collaboration-handoff-personal-room-1-handoff-second");
    expect(screen.getByText("Approval: unknown")).toBeTruthy();
    expect(renderApproval).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Unexpected approval" })).toBeNull();
    // A new durable response must not consume the navigation intent again.
    fireEvent.click(screen.getByRole("tab", { name: "People" }));
    await waitFor(() => expect(sockets).toHaveLength(1));
    act(() => sockets[0]!.open());
    detail = { ...detail, messages: [{ ...roomDetail.messages[0]!, body: "New authorized room update" }] };
    act(() => sockets[0]!.receive({ type: "collaboration:refresh", roomId: "room-1" }));
    await screen.findByText("New authorized room update");
    expect(screen.getByRole("tab", { name: "People" }).getAttribute("aria-selected")).toBe("true");
  });

  it("refreshes another member's durable message from a live room notification", async () => {
    const sockets: RoomSocket[] = [];
    vi.stubGlobal("WebSocket", class extends RoomSocket { constructor() { super(); sockets.push(this); } });
    let messages = [...roomDetail.messages];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/collaboration/rooms") return jsonResponse({ rooms: [roomDetail.room] });
      if (path === "/api/collaboration/rooms/room-1") return jsonResponse({ ...roomDetail, messages });
      return jsonResponse({ agents: [], computers: [] });
    }));
    render(<CollaborationView />);
    await screen.findByText("Confidential room note");
    await waitFor(() => expect(sockets).toHaveLength(1));
    act(() => sockets[0]!.open());
    messages = [...messages, { ...messages[0]!, messageId: "m2", body: "A teammate added this message." }];
    act(() => sockets[0]!.receive({ type: "collaboration:refresh", roomId: "room-1" }));
    expect(await screen.findByText("A teammate added this message.")).toBeTruthy();
    act(() => sockets[0]!.receive({ type: "collaboration:presence", roomId: "room-1", viewers: [
      { viewerId: "11111111-1111-4111-8111-111111111111", label: "teammate@example.test", typing: true },
    ] }));
    expect(screen.getByLabelText("Room live connection").textContent).toContain("Live updates connected");
    expect(screen.getByLabelText("Online room members").textContent).toContain("teammate@example.test is typing");
  });

  it("clears revoked room content and ignores an in-flight HTTP reload arriving afterward", async () => {
    const sockets: RoomSocket[] = [];
    vi.stubGlobal("WebSocket", class extends RoomSocket { constructor() { super(); sockets.push(this); } });
    let deferRead = false;
    let resolveRead: ((value: ReturnType<typeof jsonResponse>) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/collaboration/rooms") return jsonResponse({ rooms: [roomDetail.room] });
      if (path === "/api/collaboration/rooms/room-1") {
        if (deferRead) return new Promise<ReturnType<typeof jsonResponse>>((resolve) => { resolveRead = resolve; });
        return jsonResponse(roomDetail);
      }
      return jsonResponse({ agents: [], computers: [] });
    }));
    render(<CollaborationView />);
    await screen.findByText("Confidential room note");
    await waitFor(() => expect(sockets).toHaveLength(1));
    deferRead = true;
    act(() => sockets[0]!.open());
    act(() => sockets[0]!.close(1008));
    await act(async () => { resolveRead?.(jsonResponse(roomDetail)); await Promise.resolve(); });
    expect(screen.queryByText("Confidential room note")).toBeNull();
    expect(screen.queryByLabelText("Message")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Access to this room ended");
    // A fresh room-list response can still contain the former room; denial is
    // latched for this mounted session rather than automatically selecting it.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.queryByText("Shared room")).toBeNull();
    expect(sockets).toHaveLength(1);
  });

  it("ignores an initial same-room response that settles after a newer refresh", async () => {
    const sockets: RoomSocket[] = [];
    const reads: ReturnType<typeof deferredResponse>[] = [];
    vi.stubGlobal("WebSocket", class extends RoomSocket { constructor() { super(); sockets.push(this); } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/collaboration/rooms") return jsonResponse({ rooms: [roomDetail.room] });
      if (String(input) === "/api/collaboration/rooms/room-1") {
        const read = deferredResponse(); reads.push(read); return read.promise;
      }
      return jsonResponse({ agents: [], computers: [] });
    }));
    render(<CollaborationView />);
    await waitFor(() => expect(reads.length).toBeGreaterThanOrEqual(2));
    const initialReads = [...reads];
    await waitFor(() => expect(sockets).toHaveLength(1));
    act(() => sockets[0]!.open());
    const latest = reads.at(-1)!;
    expect(initialReads).not.toContain(latest);
    await act(async () => { latest.resolve(jsonResponse({ ...roomDetail, messages: [] })); });
    expect(screen.getByLabelText("Message")).toBeTruthy();
    await act(async () => { initialReads.forEach((read) => read.resolve(jsonResponse(roomDetail))); });
    expect(screen.queryByText("Confidential room note")).toBeNull();
  });

  it("keeps current room content when its already selected room button is clicked", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/collaboration/rooms") return jsonResponse({ rooms: [roomDetail.room] });
      if (String(input) === "/api/collaboration/rooms/room-1") return jsonResponse(roomDetail);
      return jsonResponse({ agents: [], computers: [] });
    }));
    render(<CollaborationView />);
    await screen.findByText("Confidential room note");
    fireEvent.click(screen.getByRole("button", { name: /^Shared room/ }));
    expect(screen.getByText("Confidential room note")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Room live connection" })).toBeTruthy();
  });

  it.each(["realtime", "poll"])("keeps newer hidden context when an older same-room response follows a %s refresh", async (source) => {
    const sockets: RoomSocket[] = [];
    const reads: ReturnType<typeof deferredResponse>[] = [];
    let pending = false;
    let poll: (() => void) | undefined;
    vi.spyOn(window, "setInterval").mockImplementation((callback, delay) => {
      if (delay === 5_000) poll = callback as () => void;
      return {} as ReturnType<typeof window.setInterval>;
    });
    vi.spyOn(window, "clearInterval").mockImplementation(() => {});
    const withDerivedContext = {
      ...roomDetail,
      messages: [{ ...roomDetail.messages[0]!, sourceRunId: "run-private", sourceHandoffId: "handoff-private", sourceArtifactRefs: [{ index: 0, path: "reports/private.md" }] }],
      memory: [{ id: "ctx_private", version: 1, sha256: "a".repeat(64), title: "Private shared source", content: "Source content", createdByUserId: "member@example.test", createdAt: 1, revokedAt: null }],
      handoffs: [{ handoffId: "handoff-private", taskId: "task-private", approvalId: "approval-private", senderActorId: "human:owner@example.test", recipientActorId: "agent:reviewer", parentHandoffId: null, depth: 1, remainingBudget: 0, status: "active", createdAt: 1, execution: { summary: "Private derived summary" } }],
    };
    vi.stubGlobal("WebSocket", class extends RoomSocket { constructor() { super(); sockets.push(this); } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/collaboration/rooms") return jsonResponse({ rooms: [roomDetail.room] });
      if (String(input) === "/api/collaboration/rooms/room-1") {
        if (!pending) return jsonResponse(withDerivedContext);
        const read = deferredResponse(); reads.push(read); return read.promise;
      }
      return jsonResponse({ agents: [], computers: [] });
    }));
    render(<CollaborationView />);
    await screen.findByText("Confidential room note");
    expect(screen.getByRole("link", { name: "reports/private.md" })).toBeTruthy();
    expect(screen.getByText("Private derived summary")).toBeTruthy();
    await waitFor(() => expect(sockets).toHaveLength(1));
    pending = true;
    act(() => sockets[0]!.open());
    await act(async () => {
      if (source === "poll") poll?.();
      else sockets[0]!.receive({ type: "collaboration:refresh", roomId: "room-1" });
    });
    expect(reads).toHaveLength(2);
    await act(async () => { reads[1]!.resolve(jsonResponse({ ...roomDetail, messages: [], memory: [], handoffs: [{ ...withDerivedContext.handoffs[0]!, execution: { unavailable: true } }] })); });
    expect(screen.getByText("Run status is temporarily unavailable.")).toBeTruthy();
    await act(async () => { reads[0]!.resolve(jsonResponse(withDerivedContext)); });
    expect(screen.queryByText("Confidential room note")).toBeNull();
    expect(screen.queryByText("Private shared source")).toBeNull();
    expect(screen.queryByText("Private derived summary")).toBeNull();
    expect(screen.queryByRole("link", { name: "reports/private.md" })).toBeNull();
  });

  it("latches a current HTTP denial against pending details and stale room lists", async () => {
    const sockets: RoomSocket[] = [];
    const reads: ReturnType<typeof deferredResponse>[] = [];
    const lists: ReturnType<typeof deferredResponse>[] = [];
    let pending = false;
    let poll: (() => void) | undefined;
    vi.spyOn(window, "setInterval").mockImplementation((callback, delay) => {
      if (delay === 5_000) poll = callback as () => void;
      return {} as ReturnType<typeof window.setInterval>;
    });
    vi.spyOn(window, "clearInterval").mockImplementation(() => {});
    vi.stubGlobal("WebSocket", class extends RoomSocket { constructor() { super(); sockets.push(this); } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/collaboration/rooms") {
        if (!pending) return jsonResponse({ rooms: [roomDetail.room] });
        const list = deferredResponse(); lists.push(list); return list.promise;
      }
      if (String(input) === "/api/collaboration/rooms/room-1") {
        if (!pending) return jsonResponse(roomDetail);
        const read = deferredResponse(); reads.push(read); return read.promise;
      }
      return jsonResponse({ agents: [], computers: [] });
    }));
    render(<CollaborationView />);
    await screen.findByText("Confidential room note");
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Room-only unsent draft" } });
    await waitFor(() => expect(sockets).toHaveLength(1));
    pending = true;
    act(() => sockets[0]!.open());
    act(() => poll?.());
    act(() => sockets[0]!.receive({ type: "collaboration:refresh", roomId: "room-1" }));
    await act(async () => { reads[1]!.resolve(jsonResponse({ error: "Room not found." }, 404)); });
    await waitFor(() => expect(lists).toHaveLength(2));
    await act(async () => {
      lists.forEach((list) => list.resolve(jsonResponse({ rooms: [roomDetail.room] })));
      reads[0]!.resolve(jsonResponse(roomDetail));
    });
    expect(screen.queryByText("Confidential room note")).toBeNull();
    expect(screen.queryByText("Shared room")).toBeNull();
    expect(screen.queryByDisplayValue("Room-only unsent draft")).toBeNull();
    expect(screen.queryByLabelText("Message")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Access to this room ended");
    expect(sockets).toHaveLength(1);
  });

  it("ignores an older same-room denial after a newer authorized refresh", async () => {
    const sockets: RoomSocket[] = [];
    const reads: ReturnType<typeof deferredResponse>[] = [];
    let pending = false;
    vi.stubGlobal("WebSocket", class extends RoomSocket { constructor() { super(); sockets.push(this); } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/collaboration/rooms") return jsonResponse({ rooms: [roomDetail.room] });
      if (String(input) === "/api/collaboration/rooms/room-1") {
        if (!pending) return jsonResponse(roomDetail);
        const read = deferredResponse(); reads.push(read); return read.promise;
      }
      return jsonResponse({ agents: [], computers: [] });
    }));
    render(<CollaborationView />);
    await screen.findByText("Confidential room note");
    await waitFor(() => expect(sockets).toHaveLength(1));
    pending = true;
    act(() => sockets[0]!.open());
    act(() => sockets[0]!.receive({ type: "collaboration:refresh", roomId: "room-1" }));
    await act(async () => { reads[1]!.resolve(jsonResponse(roomDetail)); });
    await act(async () => { reads[0]!.resolve(jsonResponse({ error: "Old denial" }, 404)); });
    expect(screen.getByText("Confidential room note")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("invalidates an old room response when navigating away and back to the same room", async () => {
    const sockets: RoomSocket[] = [];
    const oldRead = deferredResponse();
    let phase: "initial" | "old" | "current" = "initial";
    const otherRoom = { ...roomDetail.room, roomId: "room-2", title: "Other room" };
    vi.stubGlobal("WebSocket", class extends RoomSocket { constructor() { super(); sockets.push(this); } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/collaboration/rooms") return jsonResponse({ rooms: [roomDetail.room, otherRoom] });
      if (String(input) === "/api/collaboration/rooms/room-1") {
        if (phase === "old") { phase = "current"; return oldRead.promise; }
        return jsonResponse(phase === "initial" ? roomDetail : { ...roomDetail, messages: [{ ...roomDetail.messages[0]!, body: "Current authorized room state" }] });
      }
      if (String(input) === "/api/collaboration/rooms/room-2") return jsonResponse({ ...roomDetail, room: otherRoom, messages: [{ ...roomDetail.messages[0]!, body: "Other room state" }] });
      return jsonResponse({ agents: [], computers: [] });
    }));
    render(<CollaborationView />);
    await screen.findByText("Confidential room note");
    await waitFor(() => expect(sockets).toHaveLength(1));
    phase = "old";
    act(() => sockets[0]!.open());
    fireEvent.click(screen.getByRole("button", { name: /^Other room/ }));
    await screen.findByText("Other room state");
    fireEvent.click(screen.getByRole("button", { name: /^Shared room/ }));
    await screen.findByText("Current authorized room state");
    await act(async () => { oldRead.resolve(jsonResponse(roomDetail)); });
    expect(screen.getByText("Current authorized room state")).toBeTruthy();
    expect(screen.queryByText("Confidential room note")).toBeNull();
  });

  it("shares immutable room notes, selects exact source versions for a handoff, and revokes a note", async () => {
    let memory = [{
      id: "ctx_existing", version: 1, sha256: "a".repeat(64), title: "Release constraints", content: "Ship after review.",
      createdByUserId: "owner@example.test", createdAt: 1, revokedAt: null as number | null,
    }];
    let submitted: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/collaboration/rooms") return jsonResponse({ rooms: [roomDetail.room] });
      if (path === "/api/collaboration/rooms/room-1/memory" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        memory = [...memory, { ...body, version: 1, sha256: "b".repeat(64), createdByUserId: "owner@example.test", createdAt: 2, revokedAt: null }];
        return jsonResponse({ memory: memory.at(-1) }, 201);
      }
      if (path === "/api/collaboration/rooms/room-1/memory/ctx_existing" && init?.method === "DELETE") {
        expect(JSON.parse(String(init.body))).toEqual({ version: 1 });
        memory = memory.map((note) => note.id === "ctx_existing" ? { ...note, revokedAt: 3 } : note);
        return jsonResponse({ revoked: true });
      }
      if (path === "/api/collaboration/rooms/room-1/handoffs" && init?.method === "POST") {
        submitted = JSON.parse(String(init.body));
        return jsonResponse({ handoff: { handoffId: "handoff-notes" } }, 201);
      }
      if (path === "/api/collaboration/rooms/room-1") return jsonResponse({
        ...roomDetail, currentUserId: "owner@example.test", memory,
        members: [
          { ...roomDetail.members[0], actorId: "human:owner@example.test", userId: "owner@example.test", role: "owner" },
          { ...roomDetail.members[0], actorId: "agent:writer", userId: "owner@example.test", actorKind: "agent", role: "agent", displayName: "Writer" },
        ],
      });
      return jsonResponse({ agents: [], computers: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CollaborationView />);
    await screen.findByText("Ship after review.");
    fireEvent.click(screen.getByRole("tab", { name: "Context" }));
    fireEvent.change(screen.getByLabelText("Shared note title"), { target: { value: "Team decision" } });
    fireEvent.change(screen.getByLabelText("Shared note content"), { target: { value: "Keep the scope small." } });
    fireEvent.click(screen.getByRole("button", { name: "Share note with room" }));
    await screen.findByText("Keep the scope small.");
    expect(memory[1]?.id).toMatch(/^ctx_[a-f0-9-]{36}$/);
    fireEvent.click(screen.getByLabelText("Use shared note Release constraints in next handoff"));
    fireEvent.click(screen.getByLabelText("Include message in next handoff: Confidential room note"));
    fireEvent.click(screen.getByRole("tab", { name: "Work" }));
    fireEvent.change(screen.getByLabelText("Task ID"), { target: { value: "release-plan" } });
    fireEvent.change(screen.getByLabelText("Employee task request"), { target: { value: "Draft the release plan." } });
    fireEvent.change(screen.getByLabelText("Handoff recipient"), { target: { value: "agent:writer" } });
    fireEvent.click(screen.getByRole("button", { name: "Request / create handoff" }));
    await waitFor(() => expect(submitted?.memoryRefs).toEqual([{ id: "ctx_existing", version: 1, sha256: "a".repeat(64) }]));
    expect(submitted?.contextMessageIds).toEqual(["m1"]);
    fireEvent.click(screen.getByRole("tab", { name: "Context" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Revoke shared note Release constraints" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByLabelText("Use shared note Release constraints in next handoff"));
    fireEvent.click(screen.getByRole("button", { name: "Revoke shared note Release constraints" }));
    await waitFor(() => expect(screen.queryByLabelText("Use shared note Release constraints in next handoff")).toBeNull());
    expect((await screen.findByRole("alert")).textContent).toContain("A selected shared note is no longer available");
    expect(screen.getByText("Keep the scope small.")).toBeTruthy();
  });

  it("clears message and note selections and drafts when changing rooms", async () => {
    const memory = [{ id: "ctx_same-id", version: 1, sha256: "a".repeat(64), title: "Team guide", content: "Read the guide.", createdByUserId: "member@example.test", createdAt: 1, revokedAt: null }];
    const rooms = [roomDetail.room, { ...roomDetail.room, roomId: "room-2", title: "Second room" }];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/collaboration/rooms") return jsonResponse({ rooms });
      if (path === "/api/collaboration/rooms/room-1") return jsonResponse({ ...roomDetail, memory });
      if (path === "/api/collaboration/rooms/room-2") return jsonResponse({ ...roomDetail, room: rooms[1], memory });
      return jsonResponse({ agents: [], computers: [] });
    }));
    render(<CollaborationView />);
    await screen.findByText("Confidential room note");
    fireEvent.click(screen.getByLabelText("Use shared note Team guide in next handoff"));
    fireEvent.click(screen.getByLabelText("Include message in next handoff: Confidential room note"));
    fireEvent.change(screen.getByLabelText("Employee task request"), { target: { value: "Room-one private draft." } });
    fireEvent.click(screen.getByRole("button", { name: /Second room/ }));
    await screen.findByRole("heading", { name: "Second room" });
    expect((screen.getByLabelText("Use shared note Team guide in next handoff") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Include message in next handoff: Confidential room note") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Employee task request") as HTMLTextAreaElement).value).toBe("");
  });

  it("limits selected handoff context to twelve messages and eight shared notes", async () => {
    const memory = Array.from({ length: 9 }, (_, index) => ({ id: `ctx_${index}`, version: 1, sha256: "a".repeat(64), title: `Guide ${index}`, content: "Guide content.", createdByUserId: "member@example.test", createdAt: 1, revokedAt: null }));
    const messages = Array.from({ length: 13 }, (_, index) => ({ ...roomDetail.messages[0]!, messageId: `m${index}`, body: `Message ${index}` }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/collaboration/rooms") return jsonResponse({ rooms: [roomDetail.room] });
      if (path === "/api/collaboration/rooms/room-1") return jsonResponse({ ...roomDetail, memory, messages });
      return jsonResponse({ agents: [], computers: [] });
    }));
    render(<CollaborationView />);
    await screen.findByText("Message 12");
    for (let index = 0; index < 12; index++) fireEvent.click(screen.getByLabelText(`Include message in next handoff: Message ${index}`));
    expect((screen.getByLabelText("Include message in next handoff: Message 12") as HTMLInputElement).disabled).toBe(true);
    for (let index = 0; index < 8; index++) fireEvent.click(screen.getByLabelText(`Use shared note Guide ${index} in next handoff`));
    expect((screen.getByLabelText("Use shared note Guide 8 in next handoff") as HTMLInputElement).disabled).toBe(true);
  });

  it("keeps the new room selected when a message send from the previous room settles later", async () => {
    const rooms = [roomDetail.room, { ...roomDetail.room, roomId: "room-2", title: "Second room" }];
    let finishSend: ((value: ReturnType<typeof jsonResponse>) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/collaboration/rooms") return jsonResponse({ rooms });
      if (path === "/api/collaboration/rooms/room-1/messages" && init?.method === "POST") return new Promise<ReturnType<typeof jsonResponse>>((resolve) => { finishSend = resolve; });
      if (path === "/api/collaboration/rooms/room-1") return jsonResponse(roomDetail);
      if (path === "/api/collaboration/rooms/room-2") return jsonResponse({ ...roomDetail, room: rooms[1], messages: [] });
      return jsonResponse({ agents: [], computers: [] });
    }));
    render(<CollaborationView />);
    await screen.findByText("Confidential room note");
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "A room-one message." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: /Second room/ }));
    await screen.findByRole("heading", { name: "Second room" });
    await act(async () => { finishSend?.(jsonResponse({ message: { messageId: "sent" } }, 201)); });
    expect(screen.getByRole("heading", { name: "Second room" })).toBeTruthy();
    expect(screen.queryByText("Confidential room note")).toBeNull();
  });

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

  it.each(["sandbox", "local-before-switch", "local-after-switch"])("submits an explicit repo-free artifact workspace with %s execution", async (selection) => {
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
      if (path === "/api/computers") return jsonResponse({ computers: [{ machineId: "machine-1", hostname: "dev-laptop", status: "online" }] });
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
    fireEvent.click(screen.getByRole("tab", { name: "Work" }));
    fireEvent.change(screen.getByLabelText("Task ID"), { target: { value: "meeting-summary" } });
    fireEvent.change(screen.getByLabelText("Employee task request"), { target: { value: "Summarize these meeting notes." } });
    await screen.findByRole("option", { name: "Local · dev-laptop" });
    expect((screen.getByLabelText("Employee execution target") as HTMLSelectElement).value).toBe("sandbox");
    if (selection === "local-before-switch") {
      fireEvent.change(screen.getByLabelText("Employee execution target"), { target: { value: "local:machine-1" } });
    }
    fireEvent.change(screen.getByLabelText("Employee work destination"), { target: { value: "artifact-workspace" } });
    if (selection === "local-after-switch") {
      fireEvent.change(screen.getByLabelText("Employee execution target"), { target: { value: "local:machine-1" } });
    }
    expect((screen.getByLabelText("Employee execution target") as HTMLSelectElement).value)
      .toBe(selection === "sandbox" ? "sandbox" : "local:machine-1");
    expect(screen.getByText(/Repo-free work runs on the selected execution target/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Expected deliverable paths"), { target: { value: "reports/meeting-summary.md" } });
    fireEvent.change(screen.getByLabelText("Handoff recipient"), { target: { value: "agent:writer-profile" } });
    fireEvent.click(screen.getByRole("button", { name: "Request / create handoff" }));

    await waitFor(() => expect(submitted).toMatchObject({
      taskId: "meeting-summary",
      task: "Summarize these meeting notes.",
      executionTarget: { kind: "artifact-workspace", expectedDeliverables: ["reports/meeting-summary.md"] },
      runtime: selection === "sandbox" ? "sandbox" : "local",
      recipientActorId: "agent:writer-profile",
    }));
    const submittedBody = submitted as Record<string, unknown> | null;
    expect(submittedBody?.repoUrl).toBeUndefined();
    expect(submittedBody?.targetMachineId).toBe(selection === "sandbox" ? undefined : "machine-1");
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
          sourceHandoffId: "handoff-1",
          sourceArtifactRefs: [{ index: 0, path: "reports/review.md", artifactId: "artifact-1" }],
        },
        {
          messageId: "agent_reply_legacy",
          senderUserId: "owner@example.test",
          senderActorId: "agent:profile-release-reviewer",
          senderKind: "agent",
          body: "Historical output.",
          createdAt: 99,
          sourceRunId: "agent-tool:approval-legacy",
          sourceArtifactRefs: [{ index: 0, path: "reports/legacy.md", artifactId: "legacy" }],
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
      .toBe("/api/collaboration/rooms/room-1/handoffs/handoff-1/artifacts/0");
    expect(screen.getByText("reports/legacy.md")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "reports/legacy.md" })).toBeNull();
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
    fireEvent.click(await screen.findByRole("tab", { name: "Slack" }));
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
    fireEvent.click(await screen.findByRole("tab", { name: "Slack" }));
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

const workspaceA = `ws_${"a".repeat(24)}`;
const workspaceB = `ws_${"b".repeat(24)}`;
const ownerRoomDetail = {
  ...roomDetail,
  currentUserId: "owner@example.test",
  members: [
    {
      ...roomDetail.members[0],
      userId: "owner@example.test",
      actorId: "human:owner@example.test",
      displayName: "Owner",
      role: "owner",
    },
  ],
};
function workspaceResponse(workspaceId: string) {
  return jsonResponse({
    workspace: {
      workspaceId,
      name: "Product team",
      version: 1,
      createdAt: 1,
      membership: {
        workspaceId,
        userId: "owner@example.test",
        role: "owner",
        version: 1,
        joinedAt: 1,
      },
      members: [
        { workspaceId, userId: "owner@example.test", role: "owner", version: 1, joinedAt: 1 },
        { workspaceId, userId: "teammate@example.test", role: "member", version: 1, joinedAt: 1 },
      ],
    },
  });
}

describe("CollaborationView embedded team conversation", () => {
  it("scopes every HTTP call and invites only an explicitly selected current workspace member", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === `/api/workspaces/${workspaceA}`) return workspaceResponse(workspaceA);
      if (path === "/api/collaboration/rooms") return jsonResponse({ rooms: [roomDetail.room] });
      if (path.endsWith("/members") && init?.method === "POST")
        return jsonResponse({ member: {} }, 201);
      if (path === "/api/collaboration/rooms/room-1") return jsonResponse(ownerRoomDetail);
      return jsonResponse({ agents: [], computers: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CollaborationView workspaceId={workspaceA} />);
    const roster = await screen.findByRole("combobox", { name: "Workspace member" });
    await waitFor(() => expect((roster as HTMLSelectElement).disabled).toBe(false));
    expect(screen.queryByLabelText("Member user ID or email")).toBeNull();
    expect(screen.getByRole("option", { name: "teammate@example.test · member" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "owner@example.test · owner" })).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    fireEvent.change(roster, { target: { value: "teammate@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([path, init]) =>
            String(path).endsWith("/members") &&
            JSON.parse(String(init?.body)).userId === "teammate@example.test",
        ),
      ).toBe(true),
    );
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get("X-Shiba-Workspace")).toBe(workspaceA);
    }
  });

  it("keeps workspace invitation unavailable when the verified roster cannot load", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === `/api/workspaces/${workspaceA}`)
        return jsonResponse({ error: "Unavailable" }, 503);
      if (String(input) === "/api/collaboration/rooms")
        return jsonResponse({ rooms: [roomDetail.room] });
      if (String(input) === "/api/collaboration/rooms/room-1") return jsonResponse(ownerRoomDetail);
      return jsonResponse({ agents: [], computers: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CollaborationView workspaceId={workspaceA} />);
    expect(
      ((await screen.findByRole("combobox", { name: "Workspace member" })) as HTMLSelectElement)
        .disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: "Invite" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(await screen.findByText(/Workspace members could not be loaded/)).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST"),
    ).toBe(false);
  });

  it("clears content, sockets and drafts immediately across workspace A to B to A, ignoring late A responses", async () => {
    const sockets: RoomSocket[] = [];
    vi.stubGlobal(
      "WebSocket",
      class extends RoomSocket {
        constructor() {
          super();
          sockets.push(this);
        }
      },
    );
    const lateA = deferredResponse();
    const pendingB = deferredResponse();
    let deferA = false;
    let aRound = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        const workspace = new Headers(init?.headers).get("X-Shiba-Workspace");
        if (path.startsWith("/api/workspaces/")) return workspaceResponse(workspace!);
        if (path === "/api/collaboration/rooms") return jsonResponse({ rooms: [roomDetail.room] });
        if (path === "/api/collaboration/rooms/room-1") {
          if (workspace === workspaceB) return pendingB.promise;
          if (deferA && aRound === 0) return lateA.promise;
          return jsonResponse({
            ...roomDetail,
            messages: [
              {
                ...roomDetail.messages[0]!,
                body: aRound ? "Fresh team A message" : "Private team A message",
              },
            ],
          });
        }
        return jsonResponse({ agents: [], computers: [] });
      }),
    );
    const { rerender } = render(<CollaborationView workspaceId={workspaceA} />);
    await screen.findByText("Private team A message");
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "A unsent private draft" },
    });
    await waitFor(() => expect(sockets).toHaveLength(1));
    deferA = true;
    act(() => sockets[0]!.open());
    rerender(<CollaborationView workspaceId={workspaceB} />);
    expect(screen.queryByText("Private team A message")).toBeNull();
    expect(screen.queryByDisplayValue("A unsent private draft")).toBeNull();
    expect(sockets[0]!.readyState).toBe(3);
    await act(async () => {
      lateA.resolve(jsonResponse(roomDetail));
    });
    expect(screen.queryByText("Confidential room note")).toBeNull();
    aRound = 1;
    rerender(<CollaborationView workspaceId={workspaceA} />);
    await screen.findByText("Fresh team A message");
    await act(async () => {
      pendingB.resolve(
        jsonResponse({
          ...roomDetail,
          messages: [{ ...roomDetail.messages[0]!, body: "Old B response" }],
        }),
      );
    });
    expect(screen.queryByText("Old B response")).toBeNull();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
  });

  it("selects an embedded room and employee without importing or automatically joining private context", async () => {
    const secondRoom = { ...roomDetail.room, roomId: "room-2", title: "Delivery team" };
    const onRoomChange = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/collaboration/rooms")
        return jsonResponse({ rooms: [roomDetail.room, secondRoom] });
      if (path === "/api/custom-agents")
        return jsonResponse({
          agents: [
            {
              id: "employee-1",
              version: 3,
              slug: "designer",
              config: { name: "Product Designer" },
            },
          ],
        });
      if (path.endsWith("/agents") && init?.method === "POST")
        return jsonResponse({ member: {} }, 201);
      if (path === "/api/collaboration/rooms/room-2")
        return jsonResponse({ ...ownerRoomDetail, room: secondRoom });
      return jsonResponse({ agents: [], computers: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CollaborationView
        initialRoomId="room-2"
        initialEmployeeId="employee-1"
        onRoomChange={onRoomChange}
      />,
    );
    await screen.findByRole("heading", { name: "Delivery team" });
    await waitFor(() =>
      expect((screen.getByLabelText("Employee profile") as HTMLSelectElement).value).toBe(
        "employee-1",
      ),
    );
    expect(onRoomChange).toHaveBeenCalledWith("room-2");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(
      fetchMock.mock.calls.some(([path]) => /memory|sessions|conversations/.test(String(path))),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([path, init]) =>
            String(path).endsWith("/room-2/agents") &&
            JSON.parse(String(init?.body)).profileVersion === 3,
        ),
      ).toBe(true),
    );
  });

  it("exposes keyboard-operated details while keeping chat separate from execution approvals", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === "/api/collaboration/rooms")
        return jsonResponse({ rooms: [roomDetail.room] });
      if (String(input) === "/api/collaboration/rooms/room-1") return jsonResponse(roomDetail);
      return jsonResponse({ agents: [], computers: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CollaborationView />);
    await screen.findByRole("log", { name: "Conversation messages" });
    const people = screen.getByRole("tab", { name: "People" });
    people.focus();
    fireEvent.keyDown(people, { key: "ArrowRight" });
    const context = screen.getByRole("tab", { name: "Context" });
    expect(context.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(context);
    expect(screen.getByRole("tabpanel", { name: "Context" })).toBeTruthy();
    expect(screen.queryByRole("tabpanel", { name: "People" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Request employee work" }));
    expect(screen.getByRole("tabpanel", { name: "Work" })).toBeTruthy();
    expect(screen.getByText(/Sending a message does not start an employee run/)).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST"),
    ).toBe(false);
  });

  it("mounts only authorized available run activity on explicit execution selection and clears it on room denial", async () => {
    const sockets: RoomSocket[] = [];
    vi.stubGlobal(
      "WebSocket",
      class extends RoomSocket {
        constructor() {
          super();
          sockets.push(this);
        }
      },
    );
    const handoff = {
      handoffId: "ho_approved",
      taskId: "Release review",
      senderActorId: "human:owner@example.test",
      recipientActorId: "agent:reviewer",
      parentHandoffId: null,
      depth: 1,
      remainingBudget: 0,
      status: "active",
      createdAt: 1,
    };
    const renderExecution = vi.fn((item: { runId?: string }) => (
      <p>Authorized activity {item.runId}</p>
    ));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/collaboration/rooms")
          return jsonResponse({ rooms: [roomDetail.room] });
        if (String(input) === "/api/collaboration/rooms/room-1")
          return jsonResponse({
            ...roomDetail,
            handoffs: [
              {
                ...handoff,
                approvalId: "approval-1",
                runId: "run-1",
                execution: { approvalStatus: "approved", runStatus: "running" },
              },
              { ...handoff, handoffId: "ho_pending", taskId: "Pending request", runId: "minted-before-approval", execution: { approvalStatus: "pending", runStatus: "pending" } },
              {
                ...handoff,
                handoffId: "ho_hidden",
                taskId: "Unavailable task",
                runId: "private-run",
                execution: { unavailable: true },
              },
            ],
          });
        return jsonResponse({ agents: [], computers: [] });
      }),
    );
    render(<CollaborationView renderExecution={renderExecution} />);
    await screen.findByRole("heading", { name: "Shared room" });
    expect(renderExecution).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Execution" }));
    expect(screen.getByText("Authorized activity run-1")).toBeTruthy();
    expect(renderExecution).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: "room-1", runId: "run-1", handoffId: "ho_approved" }),
    );
    expect(renderExecution.mock.calls.some(([item]) => item.runId === "private-run" || item.runId === "minted-before-approval")).toBe(false);
    expect(screen.getByText("Waiting for a human-approved run.")).toBeTruthy();
    await waitFor(() => expect(sockets).toHaveLength(1));
    act(() => {
      sockets[0]!.open();
      sockets[0]!.close(1008);
    });
    expect(screen.queryByText("Authorized activity run-1")).toBeNull();
    expect(screen.queryByRole("tabpanel", { name: "Execution" })).toBeNull();
  });
});

it("shows reloaded human instructions and frozen context, then removes them when source access is lost", async () => {
  const sockets: RoomSocket[] = [];
  vi.stubGlobal("WebSocket", class extends RoomSocket { constructor() { super(); sockets.push(this); } });
  const handoff = { handoffId: "human-assignment", taskId: "Release checklist", senderActorId: "human:owner@example.test", recipientActorId: "human:member@example.test", parentHandoffId: null, depth: 0, remainingBudget: 0, status: "active", createdAt: 1 };
  let available = true;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/collaboration/rooms") return jsonResponse({ rooms: [roomDetail.room] });
    if (String(input) === "/api/collaboration/rooms/room-1") return jsonResponse({ ...roomDetail, handoffs: [{ ...handoff, ...(available ? {
      humanRequest: { instructions: "Prepare the checklist by Friday.", task: "Prepare the checklist by Friday.\nFrozen note from human:owner@example.test: keep budget unchanged.", digest: "a".repeat(64), requestedByUserId: "owner@example.test", messageCount: 0, noteCount: 1 },
    } : { execution: { unavailable: true } }) }] });
    return jsonResponse({ agents: [], computers: [] });
  }));
  render(<CollaborationView />);
  fireEvent.click(await screen.findByRole("tab", { name: "Work" }));
  expect(screen.getByLabelText("Assignment instructions").textContent).toBe("Prepare the checklist by Friday.");
  expect(screen.getByText("Assigned to Member")).toBeTruthy();
  expect(screen.getByText(/Requested by owner@example.test · 0 messages · 1 notes/)).toBeTruthy();
  expect(screen.getByText(/Frozen note from human:owner@example.test/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  await waitFor(() => expect(sockets).toHaveLength(1));
  act(() => sockets[0]!.open());
  available = false;
  act(() => sockets[0]!.receive({ type: "collaboration:refresh", roomId: "room-1" }));
  await waitFor(() => expect(screen.queryByLabelText("Assignment instructions")).toBeNull());
  expect(screen.queryByText(/Frozen note from human:owner@example.test/)).toBeNull();
  expect(screen.getByText("Assignment context is unavailable. A source or membership changed.")).toBeTruthy();
});

describe("Slack draft room review", () => {
  const workspaceId = PERSONAL_WORKSPACE;
  const draft = { id: "draft-1", workspaceId, actorId: "member@example.test", text: "Untrusted Slack request" };
  const detail = { ...roomDetail, members: roomDetail.members.map((member) => ({ ...member, status: "active" })) };
  function setupFetch() {
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/collaboration/rooms") return Response.json({ rooms: [detail.room] });
      if (path === "/api/collaboration/rooms/room-1") return Response.json(detail);
      return Response.json({ agents: [], computers: [] });
    });
    vi.stubGlobal("fetch", fetcher); return fetcher;
  }
  it("reviews a saved team snapshot explicitly, preserves unsent work, and does not post", async () => {
    const fetcher = setupFetch(), consumed = vi.fn();
    const teamDraft = { ...draft, source: "team-onboarding" as const, draftTaskId: "draft_12345678-1234-4123-8123-123456789abc", draftTaskVersion: 3, progressRevision: 8, expiresAt: Date.now() + 60000 };
    const view = render(<CollaborationView workspaceId={workspaceId} incomingTaskDraft={{ ...teamDraft, actorId: "other@example.test" }} onTaskDraftConsumed={consumed} />);
    await screen.findByRole("heading", { name: "Shared room" }); fireEvent.click(screen.getByRole("tab", { name: "Work" }));
    expect(screen.queryByRole("region", { name: "Review saved team task" })).toBeNull();
    view.rerender(<CollaborationView workspaceId={workspaceId} incomingTaskDraft={teamDraft} onTaskDraftConsumed={consumed} />);
    expect(screen.getByText(/Saved draft version 3/)).toBeTruthy();
    const task = screen.getByLabelText("Employee task request"); fireEvent.change(task, { target: { value: "Unsent" } });
    fireEvent.click(screen.getByRole("button", { name: "Review replacing my unsent task" }));
    expect(task).toHaveProperty("value", "Unsent");
    fireEvent.click(screen.getByRole("button", { name: "Confirm replacing my unsent task" }));
    expect(task).toHaveProperty("value", draft.text); expect(consumed).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
    view.rerender(<CollaborationView workspaceId={workspaceId} incomingTaskDraft={{ ...teamDraft, expiresAt: Date.now() - 1 }} onTaskDraftConsumed={consumed} />);
    expect(screen.queryByRole("region", { name: "Review saved team task" })).toBeNull();
  });
  it("hides the saved task preview when its review lease expires", async () => {
    setupFetch(); const consumed = vi.fn();
    const teamDraft = { ...draft, source: "team-onboarding" as const, draftTaskId: "draft_12345678-1234-4123-8123-123456789abc", draftTaskVersion: 1, progressRevision: 1, expiresAt: Date.now() + 1500 };
    render(<CollaborationView workspaceId={workspaceId} incomingTaskDraft={teamDraft} onTaskDraftConsumed={consumed} />);
    await screen.findByRole("heading", { name: "Shared room" }); fireEvent.click(screen.getByRole("tab", { name: "Work" }));
    expect(screen.getByRole("region", { name: "Review saved team task" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Review saved team task" })).toBeNull(), { timeout: 2500 });
    expect(consumed).not.toHaveBeenCalled();
  });
  it("opens Work once when a saved team task reaches a readable room", async () => {
    setupFetch(); const consumed = vi.fn();
    const teamDraft = { ...draft, source: "team-onboarding" as const, draftTaskId: "draft_12345678-1234-4123-8123-123456789abc", draftTaskVersion: 1, progressRevision: 1, expiresAt: Date.now() + 60000 };
    const view = render(<CollaborationView workspaceId={workspaceId} incomingTaskDraft={teamDraft} onTaskDraftConsumed={consumed} />);
    await screen.findByRole("region", { name: "Review saved team task" });
    expect(screen.getByRole("tab", { name: "Work" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "People" }));
    expect(screen.queryByRole("region", { name: "Review saved team task" })).toBeNull();
    view.rerender(<CollaborationView workspaceId={workspaceId} incomingTaskDraft={{ ...teamDraft }} onTaskDraftConsumed={consumed} />);
    expect(screen.getByRole("tab", { name: "People" }).getAttribute("aria-selected")).toBe("true");
    expect(consumed).not.toHaveBeenCalled();
  });
  it("requires matching native identity and an explicit room review before copying without posting", async () => {
    const fetcher = setupFetch(), consumed = vi.fn();
    const view = render(<CollaborationView workspaceId={workspaceId} incomingTaskDraft={{ ...draft, actorId: "other@example.test" }} onTaskDraftConsumed={consumed}/>);
    await screen.findByRole("heading", { name: "Shared room" }); fireEvent.click(screen.getByRole("tab", { name: "Work" }));
    expect(screen.queryByText(draft.text)).toBeNull();
    view.rerender(<CollaborationView workspaceId={workspaceId} incomingTaskDraft={{ ...draft, workspaceId: "ws_" + "f".repeat(24) }} onTaskDraftConsumed={consumed}/>);
    expect(screen.queryByRole("region", { name: "Review Slack draft" })).toBeNull();
    view.rerender(<CollaborationView workspaceId={workspaceId} incomingTaskDraft={draft} onTaskDraftConsumed={consumed}/>);
    expect(await screen.findByText(draft.text)).toBeTruthy();
    expect(screen.getByLabelText("Employee task request")).toHaveProperty("value", "");
    expect(screen.getByText(/Submitting a room task can share/).textContent).toContain("Shared room");
    fireEvent.click(screen.getByRole("button", { name: "Use Slack draft in this room task" }));
    expect(screen.getByLabelText("Employee task request")).toHaveProperty("value", draft.text);
    expect(consumed).toHaveBeenCalledExactlyOnceWith(draft.id);
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
    view.rerender(<CollaborationView workspaceId={workspaceId} incomingTaskDraft={{ ...draft, actorId: "other@example.test" }} onTaskDraftConsumed={consumed}/>);
    expect(screen.queryByRole("region", { name: "Review Slack draft" })).toBeNull();
  });
  it("requires a fresh replacement confirmation after the unsent task changes and rejects oversized drafts", async () => {
    setupFetch(); const consumed = vi.fn();
    const view=render(<CollaborationView workspaceId={workspaceId} incomingTaskDraft={draft} onTaskDraftConsumed={consumed}/>);
    await screen.findByRole("heading", { name: "Shared room" }); fireEvent.click(screen.getByRole("tab", { name: "Work" }));
    const task=screen.getByLabelText("Employee task request"); fireEvent.change(task, { target: { value: "Existing unsent task" } });
    fireEvent.click(screen.getByRole("button", { name: "Review replacing my unsent task" }));
    fireEvent.change(task, { target: { value: "Changed unsent task" } });
    expect(screen.queryByRole("button", { name: "Confirm replacing my unsent task" })).toBeNull();
    expect(task).toHaveProperty("value", "Changed unsent task");
    fireEvent.click(screen.getByRole("button", { name: "Review replacing my unsent task" }));
    view.rerender(<CollaborationView workspaceId={workspaceId} incomingTaskDraft={{ ...draft, text: "Changed Slack statement" }} onTaskDraftConsumed={consumed}/>);
    expect(screen.queryByRole("button", { name: "Confirm replacing my unsent task" })).toBeNull();
    expect(task).toHaveProperty("value", "Changed unsent task");
    view.rerender(<CollaborationView workspaceId={workspaceId} incomingTaskDraft={draft} onTaskDraftConsumed={consumed}/>);
    fireEvent.click(screen.getByRole("button", { name: "Review replacing my unsent task" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm replacing my unsent task" }));
    expect(task).toHaveProperty("value", draft.text);expect(consumed).toHaveBeenCalledExactlyOnceWith(draft.id);
    view.rerender(<CollaborationView workspaceId={workspaceId} incomingTaskDraft={{ ...draft, id: "too-long", text: "x".repeat(4001) }} onTaskDraftConsumed={consumed}/>);
    expect(screen.getByRole("alert").textContent).toContain("4,000");
    expect(screen.getByRole("button", { name: "Review replacing my unsent task" })).toHaveProperty("disabled", true);
    expect(task).toHaveProperty("value", draft.text);
  });
  it("does not offer the draft to a removed room member", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/collaboration/rooms") return Response.json({ rooms: [detail.room] });
      if (path === "/api/collaboration/rooms/room-1") return Response.json({ ...detail, members: detail.members.map((member) => ({ ...member, status: "removed" })) });
      return Response.json({ agents: [], computers: [] });
    }));
    const consumed = vi.fn(); render(<CollaborationView workspaceId={workspaceId} incomingTaskDraft={draft} onTaskDraftConsumed={consumed}/>);
    await screen.findByRole("heading", { name: "Shared room" }); fireEvent.click(screen.getByRole("tab", { name: "Work" }));
    expect(screen.queryByRole("region", { name: "Review Slack draft" })).toBeNull(); expect(consumed).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Employee task request")).toHaveProperty("value", "");
  });
  it("does not copy a draft or carry a replacement confirmation across room switches", async () => {
    const second = { ...detail, room: { ...detail.room, roomId: "room-2", title: "Second room" } };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/collaboration/rooms") return Response.json({ rooms: [detail.room, second.room] });
      if (path === "/api/collaboration/rooms/room-1") return Response.json(detail);
      if (path === "/api/collaboration/rooms/room-2") return Response.json(second);
      return Response.json({ agents: [], computers: [] });
    }));
    const consumed=vi.fn();render(<CollaborationView workspaceId={workspaceId} incomingTaskDraft={draft} onTaskDraftConsumed={consumed}/>);
    await screen.findByRole("heading", { name: "Shared room" });fireEvent.click(screen.getByRole("tab", { name: "Work" }));
    fireEvent.change(screen.getByLabelText("Employee task request"),{target:{value:"Unsent"}});
    fireEvent.click(screen.getByRole("button",{name:"Review replacing my unsent task"}));
    fireEvent.click(screen.getByRole("button",{name:/Second room/}));
    await screen.findByRole("heading",{name:"Second room"});
    expect(screen.getByLabelText("Employee task request")).toHaveProperty("value","");
    expect(screen.queryByRole("button",{name:"Confirm replacing my unsent task"})).toBeNull();
    expect(consumed).not.toHaveBeenCalled();
  });
});

describe("workspace room deep links", () => {
  const workspaceId = `ws_${"a".repeat(24)}`;
  const roomId = `room_${"b".repeat(24)}`;
  const detail = { ...roomDetail, room: { ...roomDetail.room, roomId } };
  function fixture(denied = false) {
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/collaboration/rooms") return Response.json({ rooms: [detail.room, { ...detail.room, roomId: "other-room", title: "Another room" }] });
      if (path === `/api/collaboration/rooms/${roomId}`) return denied
        ? Response.json({ error: "membership_required" }, { status: 403 }) : Response.json(detail);
      if (path === `/api/workspaces/${workspaceId}`) return Response.json({ workspace: { members: [] } });
      return Response.json({ agents: [], computers: [] });
    });
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  }
  it("copies only a canonical workspace+room URL and explains that access is still required", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    fixture();
    render(<CollaborationView workspaceId={workspaceId} initialRoomId={roomId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy room link" }));
    await screen.findByText("Room link copied. Recipients still need workspace and room access.");
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/threads/?workspace=${workspaceId}&room=${roomId}`);
  });
  it("reports clipboard failure without claiming a copied link", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    fixture();
    render(<CollaborationView workspaceId={workspaceId} initialRoomId={roomId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy room link" }));
    await screen.findByText("Could not copy room link. Check clipboard permission and try again.");
    expect(screen.queryByText(/Room link copied/)).toBeNull();
  });
  it("rechecks recipient room membership with the workspace header and does not fall back after denial", async () => {
    const fetcher = fixture(true), onRoomChange = vi.fn();
    render(<CollaborationView workspaceId={workspaceId} initialRoomId={roomId} onRoomChange={onRoomChange} />);
    await screen.findByText("Access to this room ended. Its contents are no longer available in this session.");
    expect(screen.queryByText("Confidential room note")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy room link" })).toBeNull();
    expect(onRoomChange).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.some(([path, init]) => String(path) === `/api/collaboration/rooms/${roomId}` &&
      new Headers(init?.headers).get("X-Shiba-Workspace") === workspaceId)).toBe(true);
    expect(fetcher.mock.calls.some(([path]) => String(path) === "/api/collaboration/rooms/other-room")).toBe(false);
    expect(fetcher.mock.calls.every(([, init]) => new Headers(init?.headers).get("X-Shiba-Workspace") === workspaceId)).toBe(true);
  });
  it("does not republish the previous room when a recipient opens another link in the same workspace", async () => {
    const secondRoomId = `room_${"c".repeat(24)}`;
    const fetcher = fixture();
    fetcher.mockImplementation(async (input, _init) => {
      const path = String(input);
      if (path === "/api/collaboration/rooms") return Response.json({ rooms: [detail.room, { ...detail.room, roomId: secondRoomId }] });
      if (path === `/api/collaboration/rooms/${roomId}`) return Response.json(detail);
      if (path === `/api/collaboration/rooms/${secondRoomId}`) return Response.json({ ...detail, room: { ...detail.room, roomId: secondRoomId, title: "Second linked room" } });
      if (path === `/api/workspaces/${workspaceId}`) return Response.json({ workspace: { members: [] } });
      return Response.json({ agents: [], computers: [] });
    });
    const onRoomChange = vi.fn();
    const view = render(<CollaborationView workspaceId={workspaceId} initialRoomId={roomId} onRoomChange={onRoomChange} />);
    await screen.findByRole("heading", { name: "Shared room" });
    await waitFor(() => expect(onRoomChange).toHaveBeenCalledWith(roomId));
    onRoomChange.mockClear();
    view.rerender(<CollaborationView workspaceId={workspaceId} initialRoomId={secondRoomId} onRoomChange={onRoomChange} />);
    await screen.findByRole("heading", { name: "Second linked room" });
    await waitFor(() => expect(onRoomChange).toHaveBeenCalledWith(secondRoomId));
    expect(onRoomChange).not.toHaveBeenCalledWith(roomId);
  });
  it("does not republish a loaded room when the parent supplies a new callback", async () => {
    fixture();
    const firstCallback = vi.fn();
    const view = render(<CollaborationView workspaceId={workspaceId} initialRoomId={roomId} onRoomChange={firstCallback} />);
    await screen.findByRole("heading", { name: "Shared room" });
    await waitFor(() => expect(firstCallback).toHaveBeenCalledWith(roomId));

    const nextCallback = vi.fn();
    view.rerender(<CollaborationView workspaceId={workspaceId} initialRoomId={roomId} onRoomChange={nextCallback} />);

    expect(firstCallback).toHaveBeenCalledTimes(1);
    expect(nextCallback).not.toHaveBeenCalled();
  });
});


describe("coordination cards", () => {
  const sourceText = `Fix the README. ${"Keep every requirement. ".repeat(15)}\nPreserve this final instruction.`;
  const card = {
    messageId: "handoff-card", senderUserId: "member@example.test", senderActorId: "agent:shiba",
    senderKind: "agent", body: "Shiba → Fixer: Fix the README. · because Repo edits", createdAt: 2,
    messageKind: "handoff", threadRootId: "m1",
    payloadJson: JSON.stringify({ handoffId: "route-1", childThreadRootId: "child-root" }),
  };
  function setup() {
    const detail = { ...roomDetail, members: [...roomDetail.members,
      { actorId: "agent:fixer", userId: "member@example.test", actorKind: "agent", role: "agent", status: "active", displayName: "Fixer" },
      { actorId: "agent:removed", userId: "member@example.test", actorKind: "agent", role: "agent", status: "removed", displayName: "Removed" }],
      messages: [{ ...roomDetail.messages[0]!, body: sourceText }, card,
        { ...card, messageId: "child-root", messageKind: "text", body: "Child task", threadRootId: "child-root", payloadJson: null },
        { ...card, messageId: "report-card", messageKind: "handoff_report", body: "Done", payloadJson: JSON.stringify({ handoffId: "route-1", childThreadRootId: "child-root" }) }],
    };
    const writes = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "POST") { writes(path, JSON.parse(String(init.body)), init.headers); return Response.json({}); }
      if (path === "/api/collaboration/rooms") return Response.json({ rooms: [detail.room] });
      if (path === "/api/collaboration/rooms/room-1") return Response.json(detail);
      return Response.json({ agents: [], tasks: [], presence: [] });
    }));
    return writes;
  }

  it("reassigns full source instructions through the existing handoff endpoint", async () => {
    const writes = setup();
    render(<CollaborationView workspaceId="ws_test" />);
    const picker = await screen.findByRole("combobox", { name: "Reassign" });
    expect(picker.textContent).not.toContain("Removed");
    fireEvent.change(picker, { target: { value: "agent:fixer" } });
    await waitFor(() => expect(writes).toHaveBeenCalledOnce());
    expect(writes).toHaveBeenCalledWith("/api/collaboration/rooms/room-1/handoffs", expect.objectContaining({
      recipientActorId: "agent:fixer", task: sourceText, contextMessageIds: ["m1"],
    }), expect.objectContaining({ "X-Shiba-Workspace": "ws_test" }));
  });

  it("opens the structured child thread from handoff and report cards", async () => {
    setup();
    render(<CollaborationView />);
    fireEvent.click(await screen.findByRole("button", { name: /Shiba → Fixer: Fix the README/ }));
    expect(screen.getByLabelText("Thread").textContent).toContain("Child task");
    fireEvent.click(screen.getByRole("button", { name: "Close thread" }));
    fireEvent.click(screen.getByRole("button", { name: "Reported result: Done" }));
    expect(screen.getByLabelText("Thread").textContent).toContain("Child task");
  });

  it("inserts a palette mention into the room composer and sends to the open thread", async () => {
    const writes = setup();
    const { rerender } = render(<CollaborationView />);
    fireEvent.click(await screen.findByRole("button", { name: /Shiba → Fixer: Fix the README/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Please review" } });
    const incomingMention = { id: "mention-1", roomId: "room-1", agentId: "fixer" };
    rerender(<CollaborationView incomingMention={incomingMention} />);
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("Please review @agent:fixer ");
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(writes).toHaveBeenCalledWith("/api/collaboration/rooms/room-1/messages", {
      body: "Please review @agent:fixer ", threadRootMessageId: "child-root",
    }, expect.anything()));
    rerender(<CollaborationView incomingMention={{ ...incomingMention, id: "wrong-room", roomId: "other" }} />);
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("");
  });
});
