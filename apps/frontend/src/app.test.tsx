// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Suspense, type FormEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app";
import { ONBOARDING_DISMISSED_KEY } from "./components/AgentExperience";
import { EMPLOYEE_TEMPLATES } from "./employee-templates";
import { composerDraftScope, readDraft, writeDraft, setSavedLibraryActor } from "./saved";

const mocks = vi.hoisted(() => ({
  suspension: null as Promise<void> | null,
  agent: { identified: true, readyState: 1, connectionError: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), reconnect: vi.fn() },
  chat: { messages: [], status: "ready", isStreaming: false, setMessages: vi.fn(), sendMessage: vi.fn(), clearHistory: vi.fn() },
  tools: { runsById: {} },
  router: { history: { replace: (path: string) => window.history.replaceState(null, "", path), push: (path: string) => window.history.pushState(null, "", path) } },
}));
vi.mock("agents/react", () => ({ useAgent: () => { if (mocks.suspension) throw mocks.suspension; return mocks.agent; }, useAgentToolEvents: () => mocks.tools }));
vi.mock("@cloudflare/ai-chat/react", () => ({ useAgentChat: () => mocks.chat }));
vi.mock("./conversation-room-realtime", () => ({
  useConversationRoomRealtime: () => ({
    viewerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "offline",
    viewers: [],
    remoteStream: null,
    startStream: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    finishStream: vi.fn(),
  }),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => mocks.router }));
vi.mock("./socket-liveness", () => ({ useSocketLiveness: vi.fn() }));
vi.mock("./auth-client", () => ({ authClient: { signOut: vi.fn() } }));
vi.mock("./components/FirstRunWizard", () => ({ FirstRunWizard: () => null, ONBOARDING_STORAGE_KEY: "onboarding" }));
vi.mock("./components/ThemeProvider", () => ({ useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }) }));
vi.mock("./components/InboxTab", () => ({ InboxTab: () => <div data-testid="private-mailbox">PRIVATE-MAILBOX-CONTENT</div> }));
vi.mock("./components/TaskComposer", () => ({ TaskComposer: ({ task, onTaskChange, onSubmit, onExecutionTargetKindChange, onArtifactDeliverablesChange, isSubmitting, runTarget, onRunTargetChange }: {
  runTarget?: "sandbox" | "local"; onRunTargetChange?: (value: "sandbox" | "local") => void;
  task: string; onTaskChange: (value: string) => void; onSubmit: (event: FormEvent) => void;
  onExecutionTargetKindChange?: (kind: "repository" | "artifact-workspace") => void; onArtifactDeliverablesChange?: (value: string) => void; isSubmitting?: boolean;
}) => <form data-testid="task-composer" onSubmit={onSubmit}>
  <textarea aria-label="Task draft" value={task} onChange={(event) => onTaskChange(event.target.value)} />
  <button type="button" onClick={() => { onExecutionTargetKindChange?.("artifact-workspace"); onArtifactDeliverablesChange?.(""); }}>Use automatic workspace</button>
  <button type="button" onClick={() => onRunTargetChange?.("local")}>Use local computer</button>
  <output data-testid="selected-runtime">{runTarget}</output>
  <button type="submit" disabled={isSubmitting}>Queue fixture task</button>
</form> }));
vi.mock("./components/ChatMessageComposer", () => ({ ChatMessageComposer: ({ value }: { value: string }) => <div data-testid="chat-composer"><textarea aria-label="Task draft" value={value} readOnly /></div> }));

beforeEach(() => {
  mocks.agent.reconnect.mockClear();
  mocks.suspension = null;
  setSavedLibraryActor("test-operator");
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const path = String(url);
    if (path === "/api/whoami") return Response.json({ agent: "test-operator", auth: "access" });
    if (path === "/api/sessions" && options?.method === "POST") return Response.json({ session: { id: "new-thread", name: "New thread", agentName: "new-agent", updatedAt: 1 } });
    return Response.json({ workspaces: [], sessions: [], runs: [], approvals: [], decided: [], agents: [], connections: [], computers: [], entries: [] });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

describe("app employee onboarding", () => {
  it("shows on first run, skips, and persists dismissal across remounts", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Set up your AI employees" });
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(localStorage.getItem(ONBOARDING_DISMISSED_KEY)).toBe("true");
    expect(screen.queryByRole("heading", { name: "Set up your AI employees" })).toBeNull();
    cleanup();
    render(<App />);
    await screen.findByRole("group", { name: "Work views" });
    expect(screen.queryByRole("heading", { name: "Set up your AI employees" })).toBeNull();
  });

  it("retains setup busy UI and reports thread failure, then retries from the sidebar without recreating the agent", async () => {
    const originalFetch = fetch;
    const template = EMPLOYEE_TEMPLATES.find((item) => item.id === "research")!;
    const profile = { id: "research-agent", slug: template.slug, version: 1, config: { ...template.config, harness: "opencode" } };
    let created = false;
    let finish!: (response: Response) => void;
    const createSession = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const createProfile = vi.fn(() => { created = true; return Response.json({ agent: profile }); });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/custom-agents") return options?.method === "POST" ? createProfile() : Response.json({ agents: created ? [profile] : [] });
      if (String(url) === "/api/sessions" && options?.method === "POST") return createSession();
      return originalFetch(url, options);
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Research Produce/ }));
    await waitFor(() => expect(createSession).toHaveBeenCalledOnce());
    expect((screen.getByRole("button", { name: /Setting up research/ }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish(Response.json({}, { status: 503 })));
    expect((await screen.findByText(/Agent created. Start a new thread from its sidebar row/)).textContent).toContain("503");
    expect(screen.queryByRole("heading", { name: "Set up your AI employees" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    let retry = await screen.findByRole("button", { name: "New thread with Research bot" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    fireEvent.click(screen.getByRole("button", { name: "Chats" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "New chat" }))[0]!);
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
    await act(async () => finish(Response.json({}, { status: 503 })));
    await screen.findByText(/Could not create a bot thread/);
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    retry = await screen.findByRole("button", { name: "New thread with Research bot" });
    fireEvent.click(retry);
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(3));
    await act(async () => finish(Response.json({ session: { id: "retry-thread", name: "Research bot", agentName: "research-chat", updatedAt: 1, metadata: { customAgentId: profile.id } } })));
    expect(createProfile).toHaveBeenCalledOnce();
    expect(await screen.findByRole("button", { name: "Rename thread" })).toBeTruthy();
  });

  it("creates the selected employee then opens a fresh agent-tagged thread without sending a prompt", async () => {
    const originalFetch = fetch;
    const template = EMPLOYEE_TEMPLATES.find((item) => item.id === "research")!;
    const profile = { id: "research-agent", slug: template.slug, version: 1, config: { ...template.config, harness: "opencode" } };
    let created = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/custom-agents") {
        if (options?.method === "POST") { created = true; return Response.json({ agent: profile }); }
        return Response.json({ agents: created ? [profile] : [] });
      }
      if (String(url) === "/api/sessions" && options?.method === "POST") return Response.json({ session: { id: "research-thread", name: profile.config.name, agentName: "research-chat", updatedAt: 1, metadata: { customAgentId: profile.id } } });
      return originalFetch(url, options);
    }));
    render(<App />);
    await screen.findByRole("heading", { name: "Set up your AI employees" });
    fireEvent.click(screen.getByRole("button", { name: /Research Produce/ }));
    await screen.findAllByRole("heading", { name: "Research bot" });
    expect(fetch).toHaveBeenCalledWith("/api/sessions", expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "Research bot", metadata: { customAgentId: "research-agent" } }) }));
    await waitFor(() => expect(window.location.pathname).toBe("/threads/"));
    expect(localStorage.getItem(ONBOARDING_DISMISSED_KEY)).toBe("true");
    expect(mocks.chat.sendMessage).not.toHaveBeenCalled();
  });
});

describe("app Work and Threads routing", () => {
  it("preserves an explicit local artifact selection instead of silently switching to sandbox", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    localStorage.setItem("shiba:conversation-mode:default", "work");
    window.history.replaceState(null, "", "/threads/");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Use local computer" }));
    fireEvent.click(screen.getByRole("button", { name: "Use automatic workspace" }));
    await waitFor(() => expect(screen.getByTestId("selected-runtime").textContent).toBe("local"));
  });

  it("retries an unacknowledged automatic workspace with one frozen target and command receipt", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    localStorage.setItem("shiba:conversation-mode:default", "work");
    window.history.replaceState(null, "", "/threads/");
    const originalFetch = fetch;
    const attempts: Array<{ commandId: string; task: string; executionTarget: { workspaceId: string } }> = [];
    const receipts = new Map<string, string>();
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url).startsWith("/api/runs") && options?.method === "POST") {
        const body = JSON.parse(String(options.body)) as typeof attempts[number];
        attempts.push(body);
        if (!receipts.has(body.commandId)) receipts.set(body.commandId, `approval-${receipts.size + 1}`);
        if (attempts.length === 1 || attempts.length === 3) throw new TypeError("Accepted response was lost");
        return Response.json({ approvalId: receipts.get(body.commandId) });
      }
      return originalFetch(url, options);
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Use automatic workspace" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Task draft" }), { target: { value: "Prepare an output bundle" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue fixture task" }));
    await screen.findByText(/Accepted response was lost/);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Task draft" }) as HTMLTextAreaElement).value).toBe("Prepare an output bundle"));
    fireEvent.click(screen.getByRole("button", { name: "Queue fixture task" }));
    await screen.findByText(/Draft queued/);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[0]?.executionTarget.workspaceId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(receipts.size).toBe(1);
    fireEvent.change(screen.getByRole("textbox", { name: "Task draft" }), { target: { value: "Prepare an output bundle" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue fixture task" }));
    await screen.findByText(/Accepted response was lost/);
    expect(attempts).toHaveLength(3);
    expect(attempts[2]?.commandId).not.toBe(attempts[0]?.commandId);
    expect(attempts[2]?.executionTarget.workspaceId).not.toBe(attempts[0]?.executionTarget.workspaceId);
    expect(receipts.size).toBe(2);
    fireEvent.change(screen.getByRole("textbox", { name: "Task draft" }), { target: { value: "Prepare a changed output bundle" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue fixture task" }));
    await screen.findByText(/Draft queued/);
    expect(attempts).toHaveLength(4);
    expect(attempts[3]?.commandId).not.toBe(attempts[2]?.commandId);
    expect(attempts[3]?.executionTarget.workspaceId).not.toBe(attempts[2]?.executionTarget.workspaceId);
    expect(receipts.size).toBe(3);
    expect(mocks.chat.sendMessage).not.toHaveBeenCalled();
  });

  it("opens /?prompt=x in Threads with the prompt visible", async () => {
    window.history.replaceState(null, "", "/?prompt=x");
    render(<App />);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Task draft" }) as HTMLTextAreaElement).value).toBe("x"));
    expect(window.location.pathname).toBe("/threads/");
    expect(window.location.search).toBe("");
  });

  it("keeps Work as the plain root default and after popstate", async () => {
    window.history.replaceState(null, "", "/");
    render(<App />);
    await screen.findByRole("group", { name: "Work views" });
    fireEvent.click(screen.getByRole("button", { name: "Chats" }));
    await screen.findByRole("textbox", { name: "Task draft" });
    act(() => { window.history.replaceState(null, "", "/"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await screen.findByRole("group", { name: "Work views" });
    expect(window.location.pathname).toBe("/");
  });

  it("keeps a quick-add draft in the composer after creating and navigating to a thread", async () => {
    window.history.replaceState(null, "", "/");
    render(<App />);
    const input = await screen.findByRole("textbox", { name: "Add a task and press Enter" });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/sessions", expect.objectContaining({ cache: "no-store" })));
    await act(async () => {});
    fireEvent.change(input, { target: { value: "Investigate latency" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Task draft" }) as HTMLTextAreaElement).value).toBe("Investigate latency"));
    expect(fetch).toHaveBeenCalledWith("/api/sessions", expect.objectContaining({ method: "POST" }));
    expect(window.location.pathname).toBe("/threads/");
    expect(readDraft(composerDraftScope("test-operator", "new-thread"))).toBe("Investigate latency");
    expect(readDraft("new-thread")).toBe("");
    expect(readDraft(composerDraftScope("another-operator", "new-thread"))).toBe("");
  });

  it("keeps a quick-add draft when browser storage rejects draft writes", async () => {
    const originalFetch = fetch;
    let finishSessions!: (response: Response) => void;
    let finishCreation!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/sessions") {
        return new Promise<Response>((resolve) => {
          if (options?.method === "POST") finishCreation = resolve;
          else finishSessions = resolve;
        });
      }
      return originalFetch(url, options);
    }));
    const originalSetItem = localStorage.setItem.bind(localStorage);
    const storage = vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key === "shiba-composer-drafts-v1:actor:test-operator") throw new Error("Storage blocked");
      originalSetItem(key, value);
    });
    try {
      render(<App />);
      const input = await screen.findByRole("textbox", { name: "Add a task and press Enter" });
      await waitFor(() => expect(finishSessions).toBeTypeOf("function"));
      await act(async () => finishSessions(Response.json({ sessions: [] })));
      fireEvent.change(input, { target: { value: "Keep this task without storage" } });
      fireEvent.submit(input.closest("form")!);
      await waitFor(() => expect(finishCreation).toBeTypeOf("function"));
      await act(async () => finishCreation(Response.json({ session: { id: "new-thread", name: "New thread", agentName: "new-agent", updatedAt: 1 } })));
      expect((screen.getByRole("textbox", { name: "Task draft" }) as HTMLTextAreaElement).value).toBe("Keep this task without storage");
      expect(screen.getByRole("button", { name: "Rename thread" })).toBeTruthy();
      expect(storage).toHaveBeenCalledWith("shiba-composer-drafts-v1:actor:test-operator", expect.any(String));
      expect(readDraft(composerDraftScope("test-operator", "new-thread"))).toBe("");
    } finally {
      storage.mockRestore();
    }
  });

  it.each([503, 404])("preserves the current draft when quick-add session creation returns %s", async (status) => {
    writeDraft(composerDraftScope("test-operator", "default"), "Original unfinished task");
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/sessions" && options?.method === "POST") return Response.json({}, { status });
      return originalFetch(url, options);
    }));
    render(<App />);
    const input = await screen.findByRole("textbox", { name: "Add a task and press Enter" });
    await act(async () => {});
    fireEvent.change(input, { target: { value: "Different quick task" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/sessions", expect.objectContaining({ method: "POST" })));
    await act(async () => {});
    expect((screen.getByRole("textbox", { name: "Add a task and press Enter" }) as HTMLInputElement).value).toBe("Different quick task");
    fireEvent.click(screen.getByRole("button", { name: "Chats" }));
    expect((await screen.findByRole("textbox", { name: "Task draft" }) as HTMLTextAreaElement).value).toBe("Original unfinished task");
    expect(readDraft(composerDraftScope("test-operator", "default"))).toBe("Original unfinished task");
  });

  it.each(["quick-add", "new-thread"])("shares one session creation guard across rapid and mixed activation starting with %s", async (entry) => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    writeDraft(composerDraftScope("test-operator", "default"), "Existing thread draft");
    const originalFetch = fetch;
    const template = EMPLOYEE_TEMPLATES.find((item) => item.id === "research")!;
    const profile = { id: "research-agent", slug: template.slug, version: 1, config: { ...template.config, harness: "opencode" } };
    let finish!: (response: Response) => void;
    const createSession = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/custom-agents") return Response.json({ agents: [profile] });
      if (String(url) === "/api/sessions" && options?.method === "POST") return createSession();
      return originalFetch(url, options);
    }));
    render(<App />);
    const newTask = await screen.findByRole("button", { name: "New task" });
    const input = screen.getByRole("textbox", { name: "Add a task and press Enter" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Keep quick-add draft" } });
    const form = input.closest("form")!;
    if (entry === "quick-add") fireEvent.submit(form);
    else fireEvent.click(newTask);
    fireEvent.click(newTask);
    fireEvent.click(newTask);
    fireEvent.submit(form);
    fireEvent.click(newTask);
    expect(createSession).toHaveBeenCalledOnce();
    await act(async () => finish(Response.json({}, { status: 503 })));
    expect(input.value).toBe("Keep quick-add draft");
    expect(readDraft(composerDraftScope("test-operator", "default"))).toBe("Existing thread draft");
    fireEvent.submit(form);
    expect(createSession).toHaveBeenCalledTimes(2);
    await act(async () => finish(Response.json({ session: { id: "mixed-thread", name: "New thread", agentName: "new-agent", updatedAt: 1 } })));
    expect((await screen.findByRole("textbox", { name: "Task draft" }) as HTMLTextAreaElement).value).toBe("Keep quick-add draft");
  });

  it("opens run deep links in Threads", async () => {
    window.history.replaceState(null, "", "/?run=run-1");
    render(<App />);
    await screen.findByRole("textbox", { name: "Task draft" });
    expect(window.location.pathname).toBe("/threads/");
  });

  it("shows only selected team work and opens the shared chat through Threads", async () => {
    const id = `ws_${"a".repeat(24)}`;
    const actor = "owner@example.com";
    localStorage.setItem(`shiba:team-workspace:${encodeURIComponent(actor)}`, id);
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url);
      if (path === "/api/whoami") return Response.json({ agent: actor, auth: "access" });
      if (path === "/api/workspaces") return Response.json({ workspaces: [{ workspaceId: id, name: "Design team", version: 1, createdAt: 1, membership: { workspaceId: id, userId: actor, role: "owner", version: 1, joinedAt: 1 } }] });
      if (path === `/api/workspaces/${id}/work`) return Response.json({ workspaceId: id, currentActorId: `human:${actor}`, tasks: [{ workspaceId: id, id: "shared-task", roomId: `room_${"b".repeat(24)}`, roomTitle: "Team room", title: "SHARED-TEAM-ONLY", assigneeKind: "human", status: "queued", updatedAt: 1 }], truncated: false });
      if (path === "/api/collaboration/rooms") return Response.json({ rooms: [] });
      return originalFetch(url, options);
    }));
    render(<App />);
    // The task shows in both the sidebar "Everything" section and the list.
    expect((await screen.findAllByText("SHARED-TEAM-ONLY")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /(· workspace|^Workspace profile)$/ }));
    expect(screen.getByRole("menuitemradio", { name: "Design team" }).getAttribute("aria-checked")).toBe("true");
    await act(async () => { window.history.pushState(null, "", "/threads/"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await screen.findByText(/Chat with your team/);
    expect(screen.queryByRole("textbox", { name: "Task draft" })).toBeNull();
    expect(fetch).toHaveBeenCalledWith("/api/collaboration/rooms", expect.objectContaining({ headers: expect.objectContaining({ "X-Shiba-Workspace": id }) }));
  });

  it("does not render personal session titles in the Work panel when a team workspace is selected", async () => {
    const id = `ws_${"a".repeat(24)}`;
    const actor = "owner@example.com";
    localStorage.setItem(`shiba:team-workspace:${encodeURIComponent(actor)}`, id);
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url);
      if (path === "/api/whoami") return Response.json({ agent: actor, auth: "access" });
      if (path === "/api/workspaces") return Response.json({ workspaces: [{ workspaceId: id, name: "Design team", version: 1, createdAt: 1, membership: { workspaceId: id, userId: actor, role: "owner", version: 1, joinedAt: 1 } }] });
      if (path === "/api/sessions") return Response.json({ sessions: [{ id: "personal-sess-1", name: "Personal Private Secret Session", agentName: "agent-1", updatedAt: 1 }] });
      if (path === `/api/workspaces/${id}/work`) return Response.json({ workspaceId: id, currentActorId: `human:${actor}`, tasks: [], truncated: false });
      return originalFetch(url, options);
    }));
    render(<App />);
    await screen.findByRole("group", { name: "Work views" });
    const panel = await screen.findByRole("complementary", { name: "Work" });
    expect(panel).toBeTruthy();
    expect(within(panel).queryByText("Personal Private Secret Session")).toBeNull();
    expect(within(panel).queryByText("Default Session")).toBeNull();
    expect(screen.queryByText("Personal Private Secret Session")).toBeNull();
    expect(screen.queryByText("Default Session")).toBeNull();
  });

  it("renders Settings as a page with the section in the URL and returns with Back to app", async () => {
    window.history.replaceState(null, "", "/settings/?section=account");
    render(<App />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Back to app" }))[0]!);
    await screen.findByRole("group", { name: "Work views" });
    expect(window.location.pathname).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findAllByRole("button", { name: "Back to app" });
    expect(window.location.pathname).toBe("/settings/");
    expect(window.location.search).toContain("section=");
  });

  it("switches destinations with Alt+number shortcuts", async () => {
    window.history.replaceState(null, "", "/");
    render(<App />);
    await screen.findByRole("group", { name: "Work views" });
    fireEvent.keyDown(window, { key: "2", code: "Digit2", altKey: true });
    await waitFor(() => expect(window.location.pathname).toBe("/custom-agents/"));
  });

  it("keeps personal sessions out of the Chats panel in workspace scope", async () => {
    const id = `ws_${"e".repeat(24)}`, actor = "owner@example.com";
    window.history.replaceState(null, "", "/threads/");
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url);
      if (path === "/api/whoami") return Response.json({ agent: actor, auth: "access" });
      if (path === "/api/workspaces") return Response.json({ workspaces: [{ workspaceId: id, name: "Design team", version: 1, createdAt: 1, membership: { workspaceId: id, userId: actor, role: "owner", version: 1, joinedAt: 1 } }] });
      if (path === "/api/collaboration/rooms") return Response.json({ rooms: [] });
      if (path === "/api/sessions") return Response.json({ sessions: [{ id: "personal-1", name: "Personal secret plan", agentName: "agent-a", updatedAt: 2 }, { id: "personal-2", name: "Private budget notes", agentName: "agent-b", updatedAt: 1 }] });
      return originalFetch(url, options);
    }));
    localStorage.setItem(`shiba:team-workspace:${encodeURIComponent(actor)}`, id);
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    render(<App />);
    const chats = await screen.findByRole("complementary", { name: "Chats" });
    await waitFor(() => expect(within(chats).getByRole("button", { name: "Workspace" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.queryByText("Recents")).toBeNull();
    expect(screen.queryByText("Personal secret plan")).toBeNull();
    expect(screen.queryByText("Private budget notes")).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/sessions")).toBe(false);
  });

  it.each(["/inbox/", "/memory/"])("never fetches or shows personal %s data in a team workspace", async (path) => {
    const id = `ws_${"f".repeat(24)}`, actor = "owner@example.com";
    window.history.replaceState(null, "", path);
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const requested = String(url);
      if (requested === "/api/whoami") return Response.json({ agent: actor, auth: "access" });
      if (requested === "/api/workspaces") return Response.json({ workspaces: [{ workspaceId: id, name: "Design team", version: 1, createdAt: 1, membership: { workspaceId: id, userId: actor, role: "owner", version: 1, joinedAt: 1 } }] });
      if (requested.startsWith("/api/emails")) return Response.json({ emails: [{ id: "e1", status: "unread", direction: "inbound", subject: "PERSONAL-SUBJECT" }] });
      if (requested.startsWith("/api/drafts")) return Response.json({ drafts: [] });
      if (requested === "/api/mailboxes") return Response.json({ mailboxes: [{ address: "me@personal.example", label: "PERSONAL-MAILBOX" }] });
      if (requested === "/api/memory/projects") return Response.json({ projects: [{ id: "p1", name: "PERSONAL-PROJECT" }] });
      if (requested.startsWith("/api/memory/")) return Response.json({ facts: [{ id: "f1" }], sessions: [], sources: [] });
      return originalFetch(url, options);
    }));
    localStorage.setItem(`shiba:team-workspace:${encodeURIComponent(actor)}`, id);
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    render(<App />);
    await screen.findByRole("heading", { name: "Open this feature in your personal workspace" });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const personalCalls = vi.mocked(fetch).mock.calls.map(([url]) => String(url)).filter((url) => /^\/api\/(emails|drafts|mailboxes|memory)/.test(url));
    expect(personalCalls).toEqual([]);
    expect(screen.queryByRole("complementary", { name: path === "/inbox/" ? "Mailbox" : "Memory" })).toBeNull();
    expect(screen.queryByText(/PERSONAL-/)).toBeNull();
  });

  it.each(["/inbox/", "/memory/"])("fetches %s data a bounded number of times in personal mode", async (path) => {
    const actor = "owner@example.com";
    window.history.replaceState(null, "", path);
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const requested = String(url);
      if (requested === "/api/whoami") return Response.json({ agent: actor, auth: "access" });
      if (requested === "/api/workspaces") return Response.json({ workspaces: [] });
      if (requested.startsWith("/api/emails")) return Response.json({ emails: [] });
      if (requested.startsWith("/api/drafts")) return Response.json({ drafts: [] });
      if (requested === "/api/mailboxes") return Response.json({ mailboxes: [{ address: "me@example.com", label: "Me" }] });
      if (requested === "/api/memory/projects") return Response.json({ projects: [] });
      if (requested.startsWith("/api/memory/")) return Response.json({ facts: [], sessions: [], sources: [] });
      return originalFetch(url, options);
    }));
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    render(<App />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    const calls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    // A render/refetch loop produces thousands of calls; a healthy page makes a handful.
    for (const prefix of ["/api/mailboxes", "/api/emails", "/api/drafts", "/api/memory/facts", "/api/memory/sessions", "/api/memory/sources"]) {
      expect(calls.filter((url) => url.startsWith(prefix)).length, prefix).toBeLessThanOrEqual(4);
    }
  });

  it("opens the memory Sources view without a render loop", async () => {
    window.history.replaceState(null, "", "/memory/");
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const requested = String(url);
      if (requested === "/api/whoami") return Response.json({ agent: "owner@example.com", auth: "access" });
      if (requested === "/api/workspaces") return Response.json({ workspaces: [] });
      if (requested === "/api/memory/projects") return Response.json({ projects: [] });
      if (requested.startsWith("/api/memory/")) return Response.json({ facts: [], sessions: [], sources: [] });
      if (requested.startsWith("/api/emails")) return Response.json({ emails: [] });
      if (requested.startsWith("/api/drafts")) return Response.json({ drafts: [] });
      if (requested === "/api/mailboxes") return Response.json({ mailboxes: [] });
      return originalFetch(url, options);
    }));
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Sources/ }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    const calls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(calls.filter((url) => url.startsWith("/api/memory/sources")).length).toBeGreaterThan(0);
    expect(calls.filter((url) => url.startsWith("/api/memory/sources")).length).toBeLessThanOrEqual(4);
  });

  it("starts an agent thread from the Agents panel through the shared creation guard", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/custom-agents/");
    const originalFetch = fetch;
    const template = EMPLOYEE_TEMPLATES.find((item) => item.id === "research")!;
    const profile = { id: "research-agent", slug: template.slug, version: 1, config: { ...template.config, harness: "opencode" } };
    let finish!: (response: Response) => void;
    const createSession = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/custom-agents") return Response.json({ agents: [profile] });
      if (String(url) === "/api/sessions" && options?.method === "POST") return createSession();
      return originalFetch(url, options);
    }));
    render(<App />);
    const start = await screen.findByRole("button", { name: `New thread with ${profile.config.name}` });
    fireEvent.click(start);
    fireEvent.click(start);
    fireEvent.click(start);
    expect(createSession).toHaveBeenCalledOnce();
    await act(async () => finish(Response.json({}, { status: 503 })));
    fireEvent.click(start);
    expect(createSession).toHaveBeenCalledTimes(2);
    await act(async () => finish(Response.json({ session: { id: "agent-thread", name: profile.config.name, agentName: "research-chat", updatedAt: 1, metadata: { customAgentId: profile.id } } })));
  });

  it("removes invitation secrets from the address before sign-in without submitting them", async () => {
    const token = "a".repeat(64);
    window.history.replaceState(null, "", `/app/?view=team&invite=1#invite=${token}`);
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/whoami") return Response.json({ code: "better_auth" }, { status: 401 });
      if (String(url) === "/api/auth/invitation-policy") return Response.json({ enabled: true });
      if (String(url) === "/api/auth/bootstrap") return Response.json({ locked: true });
      return originalFetch(url, options);
    }));
    render(<App />);
    await screen.findByLabelText("Invitation token");
    expect(window.location.hash).toBe("");
    expect((screen.getByLabelText("Invitation token") as HTMLInputElement).value).toBe(token);
    for (const [url, options] of vi.mocked(fetch).mock.calls) {
      expect(String(url)).not.toContain(token);
      expect(options?.method ?? "GET").toBe("GET");
    }
    expect(JSON.stringify(localStorage)).not.toContain(token);
  });

  it("does not let a late onboarding read interrupt navigation to Team settings", async () => {
    let finish!: (response: Response) => void;
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/whoami") return Response.json({ agent: "test-operator", auth: "better-auth" });
      if (String(url) === "/api/onboarding/progress") return new Promise<Response>(resolve => { finish = resolve; });
      return originalFetch(url, options);
    }));
    render(<App />);
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await act(async () => { window.history.pushState(null, "", "/team/"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await act(async () => finish(Response.json({ revision: 1, currentStep: "channels", dismissedAt: null, activatedAt: null, draftTask: null,
      connectionVerifiedAt: null, firstSuccessfulRunAt: null, acceptedArtifactAt: null, evidence: { connectedProvider: false, successfulRun: false, acceptedDeliverable: false } })));
    expect(window.location.pathname).toBe("/team/");
    expect(screen.queryByRole("textbox", { name: "Task draft" })).toBeNull();
  });

  it("retains invitation context across an uncommitted suspended render", async () => {
    const token = "b".repeat(64);
    window.history.replaceState(null, "", `/app/?view=team&invite=1#invite=${token}`);
    let resume!: () => void;
    mocks.suspension = new Promise<void>(resolve => { resume = resolve; });
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/whoami") return Response.json({ code: "better_auth" }, { status: 401 });
      if (String(url) === "/api/auth/invitation-policy") return Response.json({ enabled: false, reason: "Email transport is unavailable." });
      if (String(url) === "/api/auth/bootstrap") return Response.json({ locked: true });
      return originalFetch(url, options);
    }));
    render(<Suspense fallback={<p>Loading dashboard</p>}><App /></Suspense>);
    expect(window.location.hash).toContain(token);
    await act(async () => { mocks.suspension = null; resume(); });
    expect((await screen.findByLabelText("Invitation token") as HTMLInputElement).value).toBe(token);
    expect(window.location.hash).toBe("");
    expect(screen.getByText("Email transport is unavailable.")).toBeTruthy();
  });

  it("preserves an invited member's explicit shared-chat view after sign-in", async () => {
    const id = `ws_${"c".repeat(24)}`, actor = "member@example.com";
    localStorage.setItem(`shiba:team-workspace:${encodeURIComponent(actor)}`, id);
    window.history.replaceState(null, "", "/collaboration/");
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/whoami") return Response.json({ agent: actor, auth: "better-auth", teamMember: true });
      if (String(url) === "/api/workspaces") return Response.json({ workspaces: [{ workspaceId: id, name: "Shared team", version: 1, createdAt: 1, membership: { workspaceId: id, userId: actor, role: "member", version: 1, joinedAt: 1 } }] });
      if (String(url) === "/api/collaboration/rooms") return Response.json({ rooms: [] });
      return originalFetch(url, options);
    }));
    render(<App />);
    await screen.findByText(/Chat with your team/);
    expect(window.location.pathname).toBe("/collaboration/");
    expect(screen.queryByRole("textbox", { name: "Task draft" })).toBeNull();
  });

  it("unmounts cached private mail and never revives a private socket in a team workspace", async () => {
    const id = `ws_${"d".repeat(24)}`, actor = "owner@example.com";
    window.history.replaceState(null, "", "/inbox/");
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/whoami") return Response.json({ agent: actor, auth: "access" });
      if (String(url) === "/api/workspaces") return Response.json({ workspaces: [{ workspaceId: id, name: "Private-safe team", version: 1, createdAt: 1, membership: { workspaceId: id, userId: actor, role: "owner", version: 1, joinedAt: 1 } }] });
      return originalFetch(url, options);
    }));
    render(<App />);
    await screen.findByTestId("private-mailbox");
    fireEvent.click(screen.getByRole("button", { name: /(· workspace|^Workspace profile)$/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Private-safe team" }));
    await waitFor(() => expect(screen.queryByTestId("private-mailbox")).toBeNull());
    await act(async () => { window.dispatchEvent(new Event("online")); document.dispatchEvent(new Event("visibilitychange")); });
    expect(mocks.agent.reconnect).not.toHaveBeenCalled();
    expect(screen.queryByText("PRIVATE-MAILBOX-CONTENT")).toBeNull();
  });

  it("reloads before a different verified account can inherit private widget caches", async () => {
    let actor = "a@example.com";
    window.history.replaceState(null, "", "/inbox/");
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/whoami") return Response.json({ agent: actor, auth: "access" });
      return originalFetch(url, options);
    }));
    try {
      render(<App />);
      await screen.findByTestId("private-mailbox");
      actor = "b@example.com";
      await act(async () => { window.dispatchEvent(new Event("online")); });
      await waitFor(() => expect(reload).toHaveBeenCalledOnce());
      expect(screen.queryByTestId("private-mailbox")).toBeNull();
      expect(screen.queryByText("PRIVATE-MAILBOX-CONTENT")).toBeNull();
    } finally { reload.mockRestore(); }
  });

  it("preserves the legacy local personal surface without requesting email-only team APIs", async () => {
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/whoami") return Response.json({ agent: "default", auth: "none" });
      return originalFetch(url, options);
    }));
    render(<App />);
    await screen.findByRole("group", { name: "Work views" });
    expect(screen.queryByRole("region", { name: "Workspace verification" })).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/workspaces")).toBe(false);
  });
});
