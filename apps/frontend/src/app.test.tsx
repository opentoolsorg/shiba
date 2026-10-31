// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app";
import { ONBOARDING_DISMISSED_KEY } from "./components/AgentExperience";
import { EMPLOYEE_TEMPLATES } from "./employee-templates";
import { readDraft, writeDraft } from "./saved";

const mocks = vi.hoisted(() => ({
  agent: { identified: true, readyState: 1, connectionError: null, addEventListener: vi.fn(), removeEventListener: vi.fn() },
  chat: { messages: [], status: "ready", isStreaming: false, setMessages: vi.fn(), sendMessage: vi.fn(), clearHistory: vi.fn() },
  tools: { runsById: {} },
  router: { history: { replace: (path: string) => window.history.replaceState(null, "", path), push: (path: string) => window.history.pushState(null, "", path) } },
}));
vi.mock("agents/react", () => ({ useAgent: () => mocks.agent, useAgentToolEvents: () => mocks.tools }));
vi.mock("@cloudflare/ai-chat/react", () => ({ useAgentChat: () => mocks.chat }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => mocks.router }));
vi.mock("./socket-liveness", () => ({ useSocketLiveness: vi.fn() }));
vi.mock("./auth-client", () => ({ authClient: { signOut: vi.fn() } }));
vi.mock("./components/FirstRunWizard", () => ({ FirstRunWizard: () => null, ONBOARDING_STORAGE_KEY: "onboarding" }));
vi.mock("./components/ThemeProvider", () => ({ useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }) }));
vi.mock("./components/TaskComposer", () => ({ TaskComposer: ({ task }: { task: string }) => <div data-testid="task-composer"><textarea aria-label="Task draft" value={task} readOnly /></div> }));

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const path = String(url);
    if (path === "/api/whoami") return Response.json({ agent: "test-operator", auth: "access" });
    if (path === "/api/sessions" && options?.method === "POST") return Response.json({ session: { id: "new-thread", name: "New thread", agentName: "new-agent", updatedAt: 1 } });
    return Response.json({ sessions: [], runs: [], approvals: [], decided: [], agents: [], connections: [], computers: [], entries: [] });
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
    expect(window.location.pathname).toBe("/tasks/");
    expect(localStorage.getItem(ONBOARDING_DISMISSED_KEY)).toBe("true");
    expect(mocks.chat.sendMessage).not.toHaveBeenCalled();
  });
});

describe("app Work and Threads routing", () => {
  it("opens /?prompt=x in Threads with the prompt visible", async () => {
    window.history.replaceState(null, "", "/?prompt=x");
    render(<App />);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Task draft" }) as HTMLTextAreaElement).value).toBe("x"));
    expect(window.location.pathname).toBe("/tasks/");
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
    expect(window.location.pathname).toBe("/tasks/");
  });

  it.each([503, 404])("preserves the current draft when quick-add session creation returns %s", async (status) => {
    writeDraft("default", "Original unfinished task");
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
    expect(readDraft("default")).toBe("Original unfinished task");
  });

  it.each(["quick-add", "new-thread"])("shares one session creation guard across rapid and mixed activation starting with %s", async (entry) => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    writeDraft("default", "Existing thread draft");
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
    expect(readDraft("default")).toBe("Existing thread draft");
    fireEvent.submit(form);
    expect(createSession).toHaveBeenCalledTimes(2);
    await act(async () => finish(Response.json({ session: { id: "mixed-thread", name: "New thread", agentName: "new-agent", updatedAt: 1 } })));
    expect((await screen.findByRole("textbox", { name: "Task draft" }) as HTMLTextAreaElement).value).toBe("Keep quick-add draft");
  });

  it("opens run deep links in Threads", async () => {
    window.history.replaceState(null, "", "/?run=run-1");
    render(<App />);
    await screen.findByRole("textbox", { name: "Task draft" });
    expect(window.location.pathname).toBe("/tasks/");
  });
});
