// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("./components/TaskComposer", () => ({ TaskComposer: ({ task, onTaskChange, onSubmit, onExecutionTargetKindChange, onArtifactDeliverablesChange, onRunTargetChange, runTarget, isSubmitting }: {
  runTarget?: "sandbox" | "local"; onRunTargetChange?: (value: "sandbox" | "local") => void;
  task: string; onTaskChange: (value: string) => void; onSubmit: (event: FormEvent) => void;
  onExecutionTargetKindChange?: (kind: "repository" | "artifact-workspace") => void; onArtifactDeliverablesChange?: (value: string) => void; isSubmitting?: boolean;
}) => <form data-testid="task-composer" onSubmit={onSubmit}>
  <textarea aria-label="Task draft" value={task} onChange={(event) => onTaskChange(event.target.value)} />
  <button type="button" onClick={() => { onExecutionTargetKindChange?.("artifact-workspace"); onArtifactDeliverablesChange?.(""); }}>Use automatic workspace</button>
  <button type="button" onClick={() => onRunTargetChange?.("local")}>Use paired local</button>
  <button type="button" onClick={() => { onExecutionTargetKindChange?.("artifact-workspace"); onArtifactDeliverablesChange?.("reports/brief.md"); }}>Use explicit artifact</button>
  <output aria-label="Fixture runtime">{runTarget}</output>
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
    const retry = await screen.findByRole("button", { name: "New thread with Research bot" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    fireEvent.click(screen.getAllByRole("button", { name: "New thread" })[0]!);
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
    await act(async () => finish(Response.json({}, { status: 503 })));
    await screen.findByText(/Could not create a bot thread/);
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
  it("keeps local selected across artifact switches, rejects blank outputs, and queues explicit paths with a device", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    localStorage.setItem("shiba:conversation-mode:default", "work");
    window.history.replaceState(null, "", "/threads/");
    const originalFetch = fetch;
    const attempts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url).startsWith("/api/computers")) return Response.json({ computers: [{ machineId: "paired-fixture", hostname: "Fixture computer", platform: "linux", daemonVersion: "1.0", status: "idle", harnesses: ["opencode"], lastHeartbeat: Date.now() }] });
      if (String(url).startsWith("/api/runs") && options?.method === "POST") {
        attempts.push(JSON.parse(String(options.body)));
        return Response.json({ approvalId: "fixture-approval" });
      }
      return originalFetch(url, options);
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Use paired local" }));
    fireEvent.click(screen.getByRole("button", { name: "Use automatic workspace" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Task draft" }), { target: { value: "Write a local brief" } });
    expect(screen.getByLabelText("Fixture runtime").textContent).toBe("local");
    fireEvent.click(screen.getByRole("button", { name: "Queue fixture task" }));
    await screen.findByText("Use 1–8 safe relative .md, .txt, .json, or .csv output paths.");
    expect(attempts).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Use explicit artifact" }));
    fireEvent.click(screen.getByRole("button", { name: "Queue fixture task" }));
    await screen.findByText(/Draft queued/);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ runtime: "local", targetMachineId: "paired-fixture", publishPullRequest: false,
      executionTarget: { kind: "artifact-workspace", expectedDeliverables: ["reports/brief.md"] } });
    expect(attempts[0]).not.toHaveProperty("repoUrl");
    expect(attempts[0]).not.toHaveProperty("baseBranch");
    expect(attempts[0]?.executionTarget).not.toHaveProperty("workspaceId");
    expect(mocks.chat.sendMessage).not.toHaveBeenCalled();
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
    fireEvent.click(screen.getByRole("button", { name: "Threads" }));
    await screen.findByRole("textbox", { name: "Task draft" });
    act(() => { window.history.replaceState(null, "", "/"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await screen.findByRole("group", { name: "Work views" });
    expect(window.location.pathname).toBe("/");
  });

  it("keeps a quick-add draft in the composer after creating and navigating to a thread", async () => {
    window.history.replaceState(null, "", "/");
    render(<App />);
    const input = await screen.findByRole("textbox", { name: "Draft a task and press Enter" });
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
      const input = await screen.findByRole("textbox", { name: "Draft a task and press Enter" });
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
    const input = await screen.findByRole("textbox", { name: "Draft a task and press Enter" });
    await act(async () => {});
    fireEvent.change(input, { target: { value: "Different quick task" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/sessions", expect.objectContaining({ method: "POST" })));
    await act(async () => {});
    expect((screen.getByRole("textbox", { name: "Draft a task and press Enter" }) as HTMLInputElement).value).toBe("Different quick task");
    fireEvent.click(screen.getByRole("button", { name: "Threads" }));
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
    const agentThread = await screen.findByRole("button", { name: "New thread with Research bot" });
    const input = screen.getByRole("textbox", { name: "Draft a task and press Enter" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Keep quick-add draft" } });
    const form = input.closest("form")!;
    const newThread = screen.getAllByRole("button", { name: "New thread" })[0]!;
    if (entry === "quick-add") fireEvent.submit(form);
    else fireEvent.click(newThread);
    fireEvent.click(newThread);
    fireEvent.click(newThread);
    fireEvent.submit(form);
    fireEvent.click(agentThread);
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
    await screen.findByText("SHARED-TEAM-ONLY");
    expect((screen.getByRole("combobox", { name: "Workspace" }) as HTMLSelectElement).value).toBe(id);
    await act(async () => { window.history.pushState(null, "", "/threads/"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await screen.findByText(/Chat with your team/);
    expect(screen.queryByRole("textbox", { name: "Task draft" })).toBeNull();
    expect(fetch).toHaveBeenCalledWith("/api/collaboration/rooms", expect.objectContaining({ headers: expect.objectContaining({ "X-Shiba-Workspace": id }) }));
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
    fireEvent.change(screen.getByRole("combobox", { name: "Workspace" }), { target: { value: id } });
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
