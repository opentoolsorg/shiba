// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, Suspense, type ComponentProps, type FormEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app";
import { deriveOnboardingStatus } from "@shiba/shared";
import type { FirstRunProgressSnapshot } from "./components/FirstRunWizard";
import { EMPTY_ONBOARDING_DRAFT } from "./onboarding-draft";
import { ONBOARDING_DISMISSED_KEY } from "./components/AgentExperience";
import { EMPLOYEE_TEMPLATES } from "./employee-templates";
import { composerDraftScope, readDraft, writeDraft, setSavedLibraryActor } from "./saved";

const mocks = vi.hoisted(() => ({
  suspension: null as Promise<void> | null,
  agent: { identified: true, readyState: 1, connectionError: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), reconnect: vi.fn() },
  chat: { messages: [] as unknown[], status: "ready", isStreaming: false, isRecovering: false, setMessages: vi.fn(), sendMessage: vi.fn(), clearHistory: vi.fn() },
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
vi.mock("./components/knowledge/NotesEditor", () => ({ NotesEditor: () => null }));
vi.mock("./components/ThemeProvider", () => ({ useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }) }));
vi.mock("./components/InboxTab", () => ({ InboxTab: () => <div data-testid="private-mailbox">PRIVATE-MAILBOX-CONTENT</div> }));
vi.mock("./components/TaskComposer", () => ({ TaskComposer: ({ task, onTaskChange, onSubmit, onExecutionTargetKindChange, onArtifactDeliverablesChange, isSubmitting, runTarget, onRunTargetChange, harness, onHarnessChange }: {
  harness?: string; onHarnessChange?: (value: string) => void;
  runTarget?: "sandbox" | "local"; onRunTargetChange?: (value: "sandbox" | "local") => void;
  task: string; onTaskChange: (value: string) => void; onSubmit: (event: FormEvent) => void;
  onExecutionTargetKindChange?: (kind: "repository" | "artifact-workspace") => void; onArtifactDeliverablesChange?: (value: string) => void; isSubmitting?: boolean;
}) => <form data-testid="task-composer" onSubmit={onSubmit}>
  <textarea aria-label="Task draft" value={task} onChange={(event) => onTaskChange(event.target.value)} />
  <button type="button" onClick={() => { onExecutionTargetKindChange?.("artifact-workspace"); onArtifactDeliverablesChange?.(""); }}>Use automatic workspace</button>
  <button type="button" onClick={() => onRunTargetChange?.("local")}>Use local computer</button>
  <output data-testid="selected-runtime">{runTarget}</output>
  <output data-testid="selected-harness">{harness}</output>
  <button type="button" onClick={() => onHarnessChange?.("claude-code")}>Choose Claude API</button>
  <button type="submit" disabled={isSubmitting}>Queue fixture task</button>
</form> }));
vi.mock("./components/ChatMessageComposer", () => ({ ChatMessageComposer: ({
  value, onChange, onPrepareWork, onSubmit, lookups, onToggleLookup,
}: ComponentProps<typeof import("./components/ChatMessageComposer").ChatMessageComposer>) => (
  <form data-testid="chat-composer" onSubmit={onSubmit}>
    <textarea aria-label="Task draft" value={value} onChange={(event) => onChange(event.target.value)} />
    {onPrepareWork ? <button type="button" onClick={onPrepareWork}>Review as work</button> : null}
    {lookups?.filter((lookup) => lookup.id === "browser").map((lookup) => (
      <button key={lookup.id} type="button" aria-pressed={lookup.on} onClick={() => onToggleLookup?.(lookup.id)}>Toggle fixture browser</button>
    ))}
  </form>
) }));

beforeEach(() => {
  window.history.replaceState(null, "", "/work/");
  mocks.agent.reconnect.mockClear();
  mocks.suspension = null;
  setSavedLibraryActor("test-operator");
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const path = String(url);
    if (path === "/api/whoami") return Response.json({ agent: "test-operator", auth: "access" });
    if (path === "/api/sessions" && options?.method === "POST") return Response.json({ session: { id: "new-thread", name: "New thread", agentName: "new-agent", updatedAt: 1 } });
    return Response.json({ workspaces: [], sessions: [], runs: [], approvals: [], decided: [], agents: [], connections: [], computers: [], entries: [] });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

/**
 * The Threads panel groups threads under their employee. A row holding the open thread is
 * expanded; any other stays collapsed until its Expand control is used, as a person would.
 */
/** An employee's main row, not the Pin, New thread or Expand controls beside it (its status badge also joins the name). */
const employeeRowName = (employee: string) => (name: string) => name.includes(employee) && !/^(Pin|Unpin|New thread|Expand|Collapse)\b/.test(name);

async function openSidebarThread(thread: RegExp, employee: string) {
  if (screen.queryAllByRole("button", { name: thread }).length === 0) {
    fireEvent.click(await screen.findByRole("button", { name: `Expand ${employee}` }));
  }
  fireEvent.click(await screen.findByRole("button", { name: thread }));
}

describe("legacy shell URL preservation", () => {
  it("keeps callback query values and fragments while normalizing a legacy Settings link", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/app/?tab=settings&oauth_return=keep&section=account#callback-state");
    render(<App />);
    await screen.findAllByRole("button", { name: "Back to app" });
    await waitFor(() => expect(window.location.pathname).toBe("/settings/"));
    const params = new URLSearchParams(window.location.search);
    expect(params.get("oauth_return")).toBe("keep");
    expect(params.get("section")).toBe("account");
    expect(window.location.hash).toBe("#callback-state");
  });
});

describe("app employee onboarding", () => {
  it("lets navigation leave an invalid room link without switching workspaces", async () => {
    const workspaceId = `ws_${"a".repeat(24)}`;
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", `/threads/?workspace=${workspaceId}&room=invalid`);
    render(<App />);

    await screen.findByRole("heading", { name: "Workspace access could not be verified" });
    const settingsButton = screen.getByRole("button", { name: "Settings" });
    fireEvent.click(settingsButton);

    await waitFor(() => expect(settingsButton.getAttribute("aria-current")).toBe("page"));
    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.has("workspace")).toBe(false);
      expect(params.has("room")).toBe(false);
    });
    expect(screen.queryByRole("button", { name: "Switch to personal workspace" })).toBeNull();
  });

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
    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    let retry = await screen.findByRole("button", { name: "New thread with Research bot" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "New chat" }))[0]!);
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
    await act(async () => finish(Response.json({}, { status: 503 })));
    await screen.findByText(/Could not create a bot thread/);
    fireEvent.click(screen.getByRole("button", { name: "Team" }));
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
  it("shows employee threads in personal Chat despite a legacy collapsed sidebar preference", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    localStorage.setItem("shiba:sidebar-collapsed", "true");
    localStorage.removeItem("shiba:personal-threads-sidebar-collapsed");
    window.history.replaceState(null, "", "/threads/");
    const originalFetch = fetch;
    const employee = {
      id: "employee-1",
      slug: "finance-auditor",
      version: 1,
      config: { name: "Finance Auditor", instructions: "Review supplied records.", harness: "opencode", roleTemplateId: "finance" },
    };
    const thread = {
      id: "thread-budget",
      name: "Budget review",
      agentName: "web:test-operator:thread-budget",
      updatedAt: 123,
      metadata: { customAgentId: employee.id },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url);
      if (path.startsWith("/api/custom-agents")) return Response.json({ agents: [employee] });
      if (path === "/api/sessions" && options?.method !== "POST") return Response.json({ sessions: [thread] });
      if (path === "/api/sessions/thread-budget/resume") return Response.json({});
      return originalFetch(url, options);
    }));
    render(<App />);
    await waitFor(() => expect(document.querySelector('aside[aria-label="Employees"]')).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Expand Finance Auditor" }));
    fireEvent.click(screen.getByRole("button", { name: /Budget review/ }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/sessions/thread-budget/resume", { method: "POST" }));
    expect(fetch).not.toHaveBeenCalledWith("/api/runs", expect.objectContaining({ method: "POST" }));
  });

  it("mounts the browser only in Chat and sends its tool marker only after opt-in", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/threads/");
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/sessions/browser") return Response.json({ state: "none" });
      return originalFetch(url, options);
    }));
    render(<App />);
    try {
      expect(await screen.findByRole("region", { name: "Browser" })).toBeTruthy();
      await screen.findByText("No session");
      const draft = screen.getByRole("textbox", { name: "Task draft" });
      fireEvent.change(draft, { target: { value: "Summarize the public site." } });
      await act(async () => fireEvent.submit(screen.getByTestId("chat-composer")));
      expect(mocks.chat.sendMessage.mock.calls.at(-1)?.[0]?.metadata).not.toHaveProperty("shibaChatTools");
      fireEvent.click(screen.getByRole("button", { name: "Toggle fixture browser" }));
      fireEvent.change(draft, { target: { value: "Open the public site." } });
      await act(async () => fireEvent.submit(screen.getByTestId("chat-composer")));
      expect(mocks.chat.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
        text: "Open the public site.", metadata: expect.objectContaining({ shibaMode: "chat", shibaChatTools: ["browser"] }),
      }));
      fireEvent.click(screen.getByRole("tab", { name: "Work" }));
      expect(screen.queryByRole("region", { name: "Browser" })).toBeNull();
    } finally {
      mocks.chat.sendMessage.mockClear();
    }
  });

  it("lists employee threads and resumes the selected thread without queueing work", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/threads/");
    const originalFetch = fetch;
    const employee = {
      id: "employee-1",
      slug: "finance-auditor",
      version: 1,
      config: { name: "Finance Auditor", instructions: "Review supplied records.", harness: "opencode", roleTemplateId: "finance" },
    };
    const thread = {
      id: "thread-budget",
      name: "Budget review",
      agentName: "web:test-operator:thread-budget",
      updatedAt: 123,
      metadata: { customAgentId: employee.id },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url);
      if (path.startsWith("/api/custom-agents")) return Response.json({ agents: [employee] });
      if (path.startsWith("/api/sessions") && options?.method !== "POST") return Response.json({ sessions: [thread] });
      return originalFetch(url, options);
    }));
    render(<App />);

    const panel = await screen.findByRole("complementary", { name: "Employees" });
    fireEvent.click(await within(panel).findByRole("button", { name: "Expand Finance Auditor" }));
    fireEvent.click(await within(panel).findByRole("button", { name: /Budget review/ }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/sessions/thread-budget/resume", { method: "POST" }));
    expect(fetch).not.toHaveBeenCalledWith("/api/runs", expect.objectContaining({ method: "POST" }));
  });

  it("opens the runs list from Chat after visiting the Work organization chart", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    const originalFetch = fetch;
    const run = {
      runId: "recent-run", task: "Review the workspace report", status: "completed",
      repoUrl: "", sandboxId: "fixture-sandbox", baseBranch: "main", publishPullRequest: false,
      generation: 1, createdAt: 1, updatedAt: 2,
    };
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, options?: RequestInit) =>
      String(url).startsWith("/api/runs")
        ? Promise.resolve(Response.json({ runs: [run] }))
        : originalFetch(url, options)));
    render(<App />);

    const views = await screen.findByRole("group", { name: "Work views" });
    fireEvent.click(within(views).getByRole("button", { name: "Organization" }));
    await screen.findByRole("region", { name: "Organization view" });
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    const recent = await screen.findByRole("region", { name: "Recent runs" });
    fireEvent.click(within(recent).getByRole("button", { name: /Open all runs/ }));

    expect(await within(await screen.findByRole("region", { name: "List view" })).findByText(run.task)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Organization view" })).toBeNull();
  });

  it.each([false, true])("opens Analytics focused on the selected Recent run (setup guide open: %s)", async (openSetup) => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/threads/");
    const originalFetch = fetch;
    const run = {
      runId: "recent-run",
      task: "Review the workspace report",
      status: "completed",
      repoUrl: "",
      sandboxId: "fixture-sandbox",
      baseBranch: "main",
      publishPullRequest: false,
      generation: 1,
      createdAt: 1,
      updatedAt: 2,
    };
    const otherRun = { ...run, runId: "other-run", task: "Review a different report", createdAt: 3, updatedAt: 4 };
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url);
      if (path === "/api/whoami" && openSetup) return Response.json({ agent: "test-operator", auth: "better-auth" });
      if (path === "/api/onboarding/progress" && openSetup) {
        return Response.json({
          revision: 1, currentStep: "channels", dismissedAt: 1, activatedAt: 1,
          connectionVerifiedAt: null, firstSuccessfulRunAt: null, acceptedArtifactAt: null,
          draftTaskId: null, draftTask: null,
          evidence: { connectedProvider: false, successfulRun: false, acceptedDeliverable: false },
        });
      }
      if (path.startsWith("/api/runs?") || path === "/api/runs") {
        return Response.json({ runs: [otherRun, run] });
      }
      if (path.startsWith("/api/usage?") || path === "/api/usage") {
        return Response.json({ generatedAt: 1, timezone: "UTC", budgetUsd: null, days: [] });
      }
      return originalFetch(url, options);
    }));
    render(<App />);

    if (openSetup) {
      const rail = await screen.findByRole("complementary", { name: "Primary Left Rail" });
      fireEvent.click(within(rail).getByRole("button", { name: "Search" }));
      fireEvent.click(await screen.findByRole("option", { name: "Open setup guide" }));
      await screen.findByRole("region", { name: "Guided onboarding" });
    }
    const recent = await screen.findByRole("region", { name: "Recent runs" });
    fireEvent.click(within(recent).getByRole("button", { name: new RegExp(run.task) }));
    expect(await screen.findByRole("heading", { name: "Usage" })).toBeTruthy();
    await screen.findByText("No token usage reported yet");
    const selected = await screen.findByRole("row", { name: new RegExp(run.task) });
    expect(selected.getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(selected);
    expect(window.location.search).toBe(`?inspectRun=${run.runId}`);
    expect(screen.getByRole("row", { name: new RegExp(otherRun.task) }).hasAttribute("aria-current")).toBe(false);
    expect(screen.queryByRole("region", { name: "Guided onboarding" })).toBeNull();
    expect(fetch).not.toHaveBeenCalledWith("/api/sessions/recent-run/resume", { method: "POST" });

    const insights = within(screen.getByRole("navigation", { name: "Insights navigation" }));
    fireEvent.click(insights.getByRole("button", { name: "Pull requests" }));
    const diffRun = await screen.findByRole("combobox", { name: "Select run for diff inspection" });
    fireEvent.change(diffRun, { target: { value: otherRun.runId } });
    fireEvent.click(insights.getByRole("button", { name: "Usage" }));
    const usageRow = await screen.findByRole("row", { name: new RegExp(otherRun.task) });
    expect(usageRow.hasAttribute("aria-current")).toBe(false);
    expect(document.activeElement).not.toBe(usageRow);
    expect(window.location.search).toBe("");

    await act(async () => { window.history.back(); });
    await screen.findByRole("combobox", { name: "Select run for diff inspection" });
    await act(async () => { window.history.back(); });
    await screen.findByRole("heading", { name: "Usage" });
    const restored = await screen.findByRole("row", { name: new RegExp(run.task) });
    expect(restored.getAttribute("aria-current")).toBe("true");
    expect(window.location.search).toBe(`?inspectRun=${run.runId}`);
  });

  it("opens the returned approval from Chat and follows its server-linked run after approval", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/threads/");
    const originalFetch = fetch;
    let queued = false, approved = false;
    const payload = { task: "END_TO_END_DRAFT", publishPullRequest: false };
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url);
      if (path.startsWith("/api/runs") && options?.method === "POST") { queued = true; return Response.json({ approvalId: "server-gate" }); }
      if (path === "/api/approvals" && options?.method === "POST") { approved = true; return Response.json({ result: "approved" }); }
      if (path === "/api/approvals") return Response.json({ approvals: queued && !approved ? [{ approvalId: "server-gate", threadKey: "server-thread", task: payload.task, repoUrl: "", status: "pending", createdAt: 1, kind: "run", payload }] : [], decided: [] });
      if (path.startsWith("/api/runs")) return Response.json({ runs: approved ? [{ runId: "server-linked-run", task: payload.task, status: "completed", repoUrl: "", sandboxId: "fixture-sandbox", baseBranch: "main", publishPullRequest: false, generation: 1, createdAt: 1, updatedAt: 2, summary: "Captured fixture output", approval: { approvalId: "server-gate" } }] : [] });
      return originalFetch(url, options);
    }));
    render(<App />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Task draft" }), { target: { value: payload.task } });
    fireEvent.click(screen.getByRole("button", { name: "Review as work" }));
    fireEvent.click(screen.getByRole("button", { name: "Use automatic workspace" }));
    fireEvent.click(screen.getByRole("button", { name: "Queue fixture task" }));
    const approval = await screen.findByRole("dialog", { name: `Work inspector: ${payload.task}` }, { timeout: 5_000 });
    expect(window.location.pathname).toBe("/work/");
    expect(new URLSearchParams(window.location.search).get("task")).toBe("server-gate");
    expect(new URLSearchParams(window.location.search).get("taskKind")).toBe("approval");
    expect(approved).toBe(false);
    fireEvent.click(within(approval).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("task")).toBe("server-linked-run"));
    expect(new URLSearchParams(window.location.search).get("taskKind")).toBe("run");
    fireEvent.click(within(await screen.findByRole("dialog", { name: `Work inspector: ${payload.task}` })).getByRole("tab", { name: "Output" }));
    expect(await screen.findByText("Captured fixture output")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close task" }));
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    await screen.findByRole("textbox", { name: "Task draft" });
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    await screen.findByRole("region", { name: "Board view" });
    expect(screen.queryByRole("dialog")).toBeNull();
  }, 15_000);

  it("keeps the Work inspector on the original frozen approval decision path", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/work/?view=board&task=frozen-gate&taskKind=approval&tab=approval");
    const frozen = Object.freeze({ task: "EXACT_FROZEN_INPUT", repoUrl: "https://github.com/fixture/review", publishPullRequest: false });
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/approvals") return options?.method === "POST"
        ? Response.json({ result: "rejected" })
        : Response.json({ approvals: [{ approvalId: "frozen-gate", threadKey: "frozen-thread", task: "Inspect frozen approval", repoUrl: frozen.repoUrl, createdAt: 1, kind: "run", status: "pending", payload: frozen }], decided: [] });
      return originalFetch(url, options);
    }));
    render(<App />);
    const inspector = await screen.findByRole("dialog", { name: "Work inspector: Inspect frozen approval" });
    expect(JSON.parse(inspector.querySelector("pre")!.textContent!)).toEqual(frozen);
    expect(window.location.pathname).toBe("/work/");
    expect(fetch).not.toHaveBeenCalledWith("/api/approvals", expect.objectContaining({ method: "POST" }));
    fireEvent.click(within(inspector).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/approvals", expect.objectContaining({
      method: "POST", body: JSON.stringify({ threadKey: "frozen-thread", approvalId: "frozen-gate", approved: false }),
    })));
    expect(frozen.task).toBe("EXACT_FROZEN_INPUT");
    fireEvent.keyDown(inspector, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Work inspector: Inspect frozen approval" })).toBeNull());
    expect(new URLSearchParams(window.location.search).has("task")).toBe(false);
    expect(new URLSearchParams(window.location.search).get("view")).toBe("board");
  });

  it("keeps a prompt deep link through StrictMode render retries", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/app/?prompt=STRICT_PROMPT_FIXTURE");
    render(<StrictMode><App /></StrictMode>);
    const draft = await screen.findByRole("textbox", { name: "Task draft" });
    await waitFor(() => expect((draft as HTMLTextAreaElement).value).toBe("STRICT_PROMPT_FIXTURE"));
    expect(window.location.pathname).toBe("/threads/");
    expect(new URLSearchParams(window.location.search).has("prompt")).toBe(false);
  });

  it("waits for a recovering turn before asking for chat suggestions", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/threads/");
    const previous = { messages: mocks.chat.messages, isRecovering: mocks.chat.isRecovering };
    mocks.chat.messages = [{ id: "reply-1", role: "assistant", parts: [{ type: "text", text: "Done." }] }] as never;
    mocks.chat.isRecovering = true;
    const askedBefore = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/chat-suggestions")).length;
    try {
      const view = render(<App />);
      await screen.findByRole("textbox", { name: "Task draft" });
      await act(async () => {});
      expect(askedBefore()).toBe(0);
      mocks.chat.isRecovering = false;
      view.rerender(<App />);
      await waitFor(() => expect(askedBefore()).toBe(1));
    } finally {
      mocks.chat.messages = previous.messages;
      mocks.chat.isRecovering = previous.isRecovering;
    }
  });

  it("reviews the Chat draft in the existing Work composer without submitting it", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/threads/");
    render(<App />);
    const draft = await screen.findByRole("textbox", { name: "Task draft" });
    fireEvent.change(draft, { target: { value: "@Fixture inspect the release plan" } });
    fireEvent.click(screen.getByRole("button", { name: "Review as work" }));
    await screen.findByTestId("task-composer");
    expect((screen.getByRole("textbox", { name: "Task draft" }) as HTMLTextAreaElement).value).toBe("@Fixture inspect the release plan");
    expect(window.location.pathname).toBe("/threads/");
    expect(fetch).not.toHaveBeenCalledWith("/api/runs", expect.objectContaining({ method: "POST" }));
    expect(localStorage.getItem("shiba:conversation-mode:default")).toBe("work");
  });

  it.each([
    ["/app/?tab=run-registry", "/analytics/"],
    ["/app/?tab=orchestrator", "/activity/"],
    ["/app/?view=mailbox", "/inbox/"],
    ["/app/?tab=dashboard", "/dashboard/"],
    ["/app/?tab=integrations", "/integrations/"],
  ])("keeps legacy entry %s on its existing standalone surface", async (entry, expected) => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", entry);
    render(<App />);
    await waitFor(() => expect(window.location.pathname).toBe(expected));
    expect(fetch).not.toHaveBeenCalledWith("/api/runs", expect.objectContaining({ method: "POST" }));
  });

  it("opens the settings overview when no section is selected", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/settings/");
    render(<App />);
    await screen.findByRole("heading", { name: "Settings overview" });
    expect(new URLSearchParams(window.location.search).get("section")).toBe("overview");
  });

  it("restores the Settings section on history navigation without dispatching work", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/settings/?section=appearance");
    render(<App />);
    await screen.findByRole("heading", { name: "Settings" });
    expect(new URLSearchParams(window.location.search).get("section")).toBe("appearance");
    await act(async () => {
      window.history.pushState(null, "", "/work/?view=timeline");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await screen.findByRole("region", { name: "Timeline view" });
    await act(async () => {
      window.history.replaceState(null, "", "/settings/?section=appearance");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await screen.findByRole("heading", { name: "Settings" });
    expect(new URLSearchParams(window.location.search).get("section")).toBe("appearance");
    expect(fetch).not.toHaveBeenCalledWith("/api/runs", expect.objectContaining({ method: "POST" }));
  });

  it("lands a bare /settings/ on Overview, on first load and on history navigation, and keeps explicit sections", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    const section = () => new URLSearchParams(window.location.search).get("section");
    const travel = async (url: string) => {
      await act(async () => {
        window.history.pushState(null, "", url);
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
    };
    window.history.replaceState(null, "", "/settings/");
    render(<App />);
    await screen.findByRole("heading", { name: "Settings" });
    await waitFor(() => expect(section()).toBe("overview"));
    await travel("/work/?view=timeline");
    await screen.findByRole("region", { name: "Timeline view" });
    await travel("/settings/?section=appearance");
    await screen.findByRole("heading", { name: "Settings" });
    expect(section()).toBe("appearance");
    await travel("/work/?view=timeline");
    await screen.findByRole("region", { name: "Timeline view" });
    await travel("/settings/");
    await screen.findByRole("heading", { name: "Settings" });
    await waitFor(() => expect(section()).toBe("overview"));
  });

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
      if (String(url) === "/api/approvals") return Response.json({ approvals: [...receipts].map(([commandId, approvalId]) => ({
        approvalId, threadKey: "", task: attempts.find((attempt) => attempt.commandId === commandId)?.task,
        status: "pending", kind: "run", createdAt: 1,
      })), decided: [] });
      return originalFetch(url, options);
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Use automatic workspace" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Task draft" }), { target: { value: "Prepare an output bundle" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue fixture task" }));
    await screen.findByText(/Accepted response was lost/);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Task draft" }) as HTMLTextAreaElement).value).toBe("Prepare an output bundle"));
    fireEvent.click(screen.getByRole("button", { name: "Queue fixture task" }));
    await screen.findAllByText(/Draft queued/);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[0]?.executionTarget.workspaceId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(receipts.size).toBe(1);
    expect(window.location.pathname).toBe("/work/");
    fireEvent.click(await screen.findByRole("button", { name: "Close task" }));
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    await screen.findByRole("textbox", { name: "Task draft" });
    fireEvent.change(screen.getByRole("textbox", { name: "Task draft" }), { target: { value: "Prepare an output bundle" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue fixture task" }));
    await screen.findByText(/Accepted response was lost/);
    expect(attempts).toHaveLength(3);
    expect(attempts[2]?.commandId).not.toBe(attempts[0]?.commandId);
    expect(attempts[2]?.executionTarget.workspaceId).not.toBe(attempts[0]?.executionTarget.workspaceId);
    expect(receipts.size).toBe(2);
    fireEvent.change(screen.getByRole("textbox", { name: "Task draft" }), { target: { value: "Prepare a changed output bundle" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue fixture task" }));
    await screen.findAllByText(/Draft queued/);
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

  it("opens the Outputs video handoff as an unsent Chat draft", async () => {
    window.history.replaceState(null, "", `/threads/?${new URLSearchParams({ prompt: "Create a 9:16 video of " })}`);
    render(<App />);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Task draft" }) as HTMLTextAreaElement).value).toBe("Create a 9:16 video of "));
    expect(window.location.search).toBe("");
    expect(mocks.chat.sendMessage).not.toHaveBeenCalled();
    await act(async () => {});
    const posts = vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method === "POST").map(([url]) => String(url));
    expect(posts.filter((url) => /\/api\/(runs|sessions|approvals|outputs)|chat-suggestions|video|image/.test(url))).toEqual([]);
  });

  it("opens the task inbox at root and after popstate", async () => {
    window.history.replaceState(null, "", "/");
    render(<App />);
    await screen.findByRole("heading", { name: /Hand off the work/ });
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    await screen.findByRole("textbox", { name: "Task draft" });
    act(() => { window.history.replaceState(null, "", "/"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await screen.findByRole("heading", { name: /Hand off the work/ });
    expect(window.location.pathname).toBe("/tasks/");
  });

  it.each(["/work/", "/tasks/"])("does not redirect explicit %s when first-run progress resolves late", async (path) => {
    window.history.replaceState(null, "", path);
    const originalFetch = fetch;
    let resolveProgress!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/whoami") return Promise.resolve(Response.json({ agent: "test-operator", auth: "better-auth" }));
      if (String(url) === "/api/onboarding/progress") return new Promise<Response>((resolve) => { resolveProgress = resolve; });
      return originalFetch(url, options);
    }));
    render(<App />);
    await screen.findByRole("button", { name: "Chat" });
    await waitFor(() => expect(resolveProgress).toBeTypeOf("function"));
    await act(async () => resolveProgress(Response.json({ revision: 1, activatedAt: null, dismissedAt: null })));
    expect(window.location.pathname).toBe(path);
    expect(screen.queryByTestId("chat-composer")).toBeNull();
  });

  it("selects a custom agent explicitly and restores built-in defaults", async () => {
    window.history.replaceState(null, "", "/tasks/");
    const originalFetch = fetch;
    const template = EMPLOYEE_TEMPLATES.find((item) => item.id === "research")!;
    const profile = { id: "research-agent", slug: template.slug, version: 1, config: { ...template.config, harness: "codex", defaultRepoUrl: "https://github.com/custom/repo" } };
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/setup/status") return Response.json({ models: { harness: "opencode", coding: "default" }, doctor: { roles: [] } });
      if (String(url).startsWith("/api/runs") && options?.method === "POST") return Response.json({ error: "Repository access denied" }, { status: 403 });
      if (String(url) === "/api/custom-agents") return Response.json({ agents: [profile] });
      return originalFetch(url, options);
    }));
    render(<App />);
    const select = await screen.findByRole("combobox", { name: "Choose an agent" }) as HTMLSelectElement;
    await screen.findByRole("option", { name: new RegExp(profile.config.name) });
    const repo = screen.getByRole("combobox", { name: "GitHub repository" }) as HTMLInputElement;
    expect(select.value).toBe("");
    expect(repo.value).toBe("");
    fireEvent.change(repo, { target: { value: "my/repo" } });
    fireEvent.change(select, { target: { value: profile.id } });
    expect(select.value).toBe(profile.id);
    expect(screen.getByText("custom/repo")).toBeTruthy();
    await screen.findByText(/This model override has not been checked/);
    fireEvent.change(screen.getByRole("textbox", { name: "What do you want done?" }), { target: { value: "Fix the issue" } });
    fireEvent.submit(screen.getByRole("form", { name: "Hand off work" }));
    expect((await screen.findByText("Run could not be queued: Repository access denied")).getAttribute("role")).toBe("status");
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/api\/runs/), expect.objectContaining({ method: "POST", body: expect.stringContaining('"customAgentId":"research-agent"') }));
    fireEvent.change(select, { target: { value: "" } });
    expect(select.value).toBe("");
    expect((screen.getByRole("combobox", { name: "GitHub repository" }) as HTMLInputElement).value).toBe("my/repo");
  });

  it("keeps a quick-add draft in the composer after creating and navigating to a thread", async () => {
    window.history.replaceState(null, "", "/work/");
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
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
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
    const newTask = await screen.findByRole("button", { name: "New task" }) as HTMLButtonElement;
    const input = screen.getByRole("textbox", { name: "Add a task and press Enter" }) as HTMLInputElement;
    // Creation opens once the thread registry has answered; the burst must land on that state.
    await waitFor(() => expect(newTask.disabled || input.disabled).toBe(false));
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

  it("holds task creation until the thread registry answers", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    const originalFetch = fetch;
    let answerRegistry!: () => void;
    const registry = new Promise<void>((resolve) => { answerRegistry = resolve; });
    const createSession = vi.fn(async () => Response.json({ session: { id: "ready-thread", name: "New thread", agentName: "new-agent", updatedAt: 1 } }));
    // The registry read starts right after the commit that made private data
    // available, so the controls it finds are the ones that commit showed.
    const liveAtRegistryRead: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/sessions" && options?.method === "POST") return createSession();
      if (String(url) === "/api/sessions") {
        const controls = document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button[aria-label="New task"], input[aria-label="Add a task and press Enter"]');
        liveAtRegistryRead.push(...[...controls].filter((control) => !control.disabled).map((control) => control.getAttribute("aria-label")!));
        await registry;
        return Response.json({ sessions: [], defaultSessionId: "default" });
      }
      return originalFetch(url, options);
    }));
    render(<App />);
    const newTask = await screen.findByRole("button", { name: "New task" }) as HTMLButtonElement;
    const input = screen.getByRole("textbox", { name: "Add a task and press Enter" }) as HTMLInputElement;
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/sessions", expect.not.objectContaining({ method: "POST" })));
    expect(liveAtRegistryRead).toEqual([]);
    expect(newTask.disabled).toBe(true);
    expect(input.disabled).toBe(true);
    expect(screen.getByText("Loading your threads…")).toBeTruthy();
    fireEvent.click(newTask);
    fireEvent.keyDown(window, { key: "O", metaKey: true, shiftKey: true });
    expect(createSession).not.toHaveBeenCalled();
    await act(async () => answerRegistry());
    await waitFor(() => expect(newTask.disabled).toBe(false));
    expect(input.disabled).toBe(false);
    expect(screen.queryByText("Loading your threads…")).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    fireEvent.click(newTask);
    expect(createSession).toHaveBeenCalledOnce();
  });

  it("keeps the command menu's New task inert until the thread registry answers", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    const originalFetch = fetch;
    let answerRegistry!: () => void;
    const registry = new Promise<void>((resolve) => { answerRegistry = resolve; });
    const createSession = vi.fn(async () => Response.json({ session: { id: "palette-thread", name: "New thread", agentName: "new-agent", updatedAt: 1 } }));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/sessions" && options?.method === "POST") return createSession();
      if (String(url) === "/api/sessions") { await registry; return Response.json({ sessions: [], defaultSessionId: "default" }); }
      return originalFetch(url, options);
    }));
    render(<App />);
    await screen.findByRole("button", { name: "New task" });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/sessions", expect.not.objectContaining({ method: "POST" })));
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const option = (await screen.findByText("New task…")).closest<HTMLElement>("[role='option']")!;
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(within(option).getByText("Loading your threads…")).toBeTruthy();
    fireEvent.click(option);
    expect(createSession).not.toHaveBeenCalled();
    await act(async () => answerRegistry());
    await waitFor(() => expect(option.getAttribute("aria-disabled")).toBe("false"));
    expect(createSession).not.toHaveBeenCalled();
    fireEvent.click(option);
    await waitFor(() => expect(createSession).toHaveBeenCalledOnce());
  });

  it("creates one task from the new-task shortcut once the thread registry answers", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    const originalFetch = fetch;
    let answerRegistry!: () => void;
    const registry = new Promise<void>((resolve) => { answerRegistry = resolve; });
    let finish!: (response: Response) => void;
    const createSession = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/sessions" && options?.method === "POST") return createSession();
      if (String(url) === "/api/sessions") { await registry; return Response.json({ sessions: [], defaultSessionId: "default" }); }
      return originalFetch(url, options);
    }));
    render(<App />);
    const newTask = await screen.findByRole("button", { name: "New task" }) as HTMLButtonElement;
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/sessions", expect.not.objectContaining({ method: "POST" })));
    fireEvent.keyDown(window, { key: "O", ctrlKey: true, shiftKey: true });
    expect(createSession).not.toHaveBeenCalled();
    await act(async () => answerRegistry());
    await waitFor(() => expect(newTask.disabled).toBe(false));
    expect(createSession).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "O", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "O", metaKey: true, shiftKey: true });
    expect(createSession).toHaveBeenCalledOnce();
    await act(async () => finish(Response.json({ session: { id: "shortcut-thread", name: "New thread", agentName: "new-agent", updatedAt: 1 } })));
    expect(await screen.findByRole("button", { name: "Rename thread" })).toBeTruthy();
  });

  it("holds the employee sidebar's New thread until the thread registry answers", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/custom-agents/");
    const originalFetch = fetch;
    const template = EMPLOYEE_TEMPLATES.find((item) => item.id === "research")!;
    const profile = { id: "research-agent", slug: template.slug, version: 1, config: { ...template.config, harness: "opencode" } };
    let answerRegistry!: () => void;
    const registry = new Promise<void>((resolve) => { answerRegistry = resolve; });
    const createSession = vi.fn(async () => Response.json({ session: { id: "agent-thread", name: profile.config.name, agentName: "research-chat", updatedAt: 1, metadata: { customAgentId: profile.id } } }));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/custom-agents") return Response.json({ agents: [profile] });
      if (String(url) === "/api/sessions" && options?.method === "POST") return createSession();
      if (String(url) === "/api/sessions") { await registry; return Response.json({ sessions: [], defaultSessionId: "default" }); }
      return originalFetch(url, options);
    }));
    render(<App />);
    const start = await screen.findByRole("button", { name: `New thread with ${profile.config.name}` }) as HTMLButtonElement;
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/sessions", expect.not.objectContaining({ method: "POST" })));
    expect(start.disabled).toBe(true);
    expect(start.title).toBe("Loading your threads…");
    fireEvent.click(start);
    expect(createSession).not.toHaveBeenCalled();
    await act(async () => answerRegistry());
    await waitFor(() => expect(start.disabled).toBe(false));
    expect(createSession).not.toHaveBeenCalled();
    fireEvent.click(start);
    fireEvent.click(start);
    await waitFor(() => expect(createSession).toHaveBeenCalledOnce());
  });

  it("keeps task creation disabled with a reason when the server has no thread registry", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    const originalFetch = fetch;
    const createSession = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/sessions" && options?.method === "POST") return createSession();
      if (String(url) === "/api/sessions") return Response.json({}, { status: 404 });
      return originalFetch(url, options);
    }));
    render(<App />);
    const newTask = await screen.findByRole("button", { name: "New task" }) as HTMLButtonElement;
    await screen.findByText("Session creation is unavailable on this server.");
    expect(newTask.disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "Add a task and press Enter" }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(newTask);
    expect(createSession).not.toHaveBeenCalled();
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

  it("uses workspace actor IDs to assign and edit a team task with employee profiles", async () => {
    const workspaceId = `ws_${"a".repeat(24)}`;
    const actor = "owner@example.com";
    const builder = { id: `cag-${"b".repeat(24)}`, slug: "builder", version: 1, config: { name: "Builder", instructions: "Build.", harness: "opencode" } };
    const reviewer = { id: `cag-${"c".repeat(24)}`, slug: "reviewer", version: 1, config: { name: "Reviewer", instructions: "Review.", harness: "opencode" } };
    const builderActor = `agent:${builder.id}`;
    const reviewerActor = `agent:${reviewer.id}`;
    const workPath = `/api/workspaces/${workspaceId}/work`;
    const task = { id: `task_${"d".repeat(24)}`, workspaceId, roomId: "", roomTitle: "", title: "Ship the release", status: "todo", updatedAt: 1, assigneeKind: "agent", assigneeActorId: builderActor, ownerId: builderActor };
    const createTask = vi.fn((body: unknown) => {
      const ownerId = (body as { ownerId?: string }).ownerId;
      return ownerId === builderActor ? Response.json({ task }, { status: 201 }) : Response.json({ error: "Invalid actor ID" }, { status: 400 });
    });
    const editTask = vi.fn((body: { patch: { reviewerId: string } }) => Response.json({ task: { ...task, reviewerId: body.patch.reviewerId } }));
    localStorage.setItem(`shiba:team-workspace:${encodeURIComponent(actor)}`, workspaceId);
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url);
      if (path === "/api/whoami") return Response.json({ agent: actor, auth: "access" });
      if (path === "/api/workspaces") return Response.json({ workspaces: [{ workspaceId, name: "Design team", version: 1, createdAt: 1, membership: { workspaceId, userId: actor, role: "owner", version: 1, joinedAt: 1 } }] });
      if (path === "/api/custom-agents" && new Headers(options?.headers).get("X-Shiba-Workspace") === workspaceId) return Response.json({ agents: [builder, reviewer] });
      if (path === workPath) {
        return options?.method === "POST" ? createTask(JSON.parse(String(options.body))) : Response.json({ workspaceId, currentActorId: `human:${actor}`, tasks: [], truncated: false });
      }
      if (path === `${workPath}/${task.id}` && options?.method === "PATCH") return editTask(JSON.parse(String(options.body)));
      return originalFetch(url, options);
    }));
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Add details" }));
    const assignee = screen.getByRole("combobox", { name: "Assignee" });
    const builderOption = await within(assignee).findByRole<HTMLOptionElement>("option", { name: "Builder" });
    fireEvent.change(assignee, { target: { value: builderOption.value } });
    const title = screen.getByRole("textbox", { name: "Add a task and press Enter" });
    fireEvent.change(title, { target: { value: task.title } });
    fireEvent.keyDown(title, { key: "Enter" });
    await waitFor(() => expect(createTask).toHaveBeenCalledExactlyOnceWith({ title: task.title, ownerId: builderActor }));
    await waitFor(() => expect(title).toHaveProperty("value", ""));

    const list = screen.getByRole("region", { name: "List view" });
    const row = within(list).getByRole("button", { name: /^Ship the release\b/ });
    expect(within(row).getByRole("img", { name: "Builder" })).toBeTruthy();
    fireEvent.click(row);
    const detail = await screen.findByRole("complementary", { name: "Task details" });
    expect(within(detail).getByRole("combobox", { name: "Owner" })).toHaveProperty("value", builderActor);
    const reviewerSelect = within(detail).getByRole("combobox", { name: "Reviewer" });
    const reviewerOption = within(reviewerSelect).getByRole<HTMLOptionElement>("option", { name: "Reviewer" });
    fireEvent.change(reviewerSelect, { target: { value: reviewerOption.value } });
    await waitFor(() => expect(editTask).toHaveBeenCalledExactlyOnceWith({ patch: { reviewerId: reviewerActor } }));
  });

  it("returns to a linked room after selecting another room in legacy Collaboration", async () => {
    const id = `ws_${"a".repeat(24)}`;
    const actor = "owner@example.com";
    const roomA = `room_${"b".repeat(24)}`;
    const roomB = `room_${"c".repeat(24)}`;
    const linkedPath = `/threads/?workspace=${id}&room=${roomA}`;
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", linkedPath);
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url);
      if (path === "/api/whoami") return Response.json({ agent: actor, auth: "access" });
      if (path === "/api/workspaces") return Response.json({ workspaces: [{ workspaceId: id, name: "Design team", version: 1, createdAt: 1, membership: { workspaceId: id, userId: actor, role: "owner", version: 1, joinedAt: 1 } }] });
      if (path === "/api/collaboration/rooms") return Response.json({ rooms: [
        { roomId: roomA, title: "Room A", visibility: "private" },
        { roomId: roomB, title: "Room B", visibility: "private" },
      ] });
      if (path === `/api/collaboration/rooms/${roomA}` || path === `/api/collaboration/rooms/${roomB}`) {
        const roomId = path.endsWith(roomA) ? roomA : roomB;
        return Response.json({ room: { roomId, title: roomId === roomA ? "Room A" : "Room B", visibility: "private" }, currentUserId: actor, members: [], messages: [], handoffs: [] });
      }
      return originalFetch(url, options);
    }));

    render(<App />);
    await screen.findByRole("heading", { name: "Room A" });
    fireEvent.click(screen.getByRole("button", { name: "Open command menu" }));
    fireEvent.change(within(screen.getByRole("dialog", { name: "Search" })).getByRole("combobox"), { target: { value: "Collaboration" } });
    fireEvent.click(await screen.findByRole("option", { name: "Go to Collaboration" }));
    await waitFor(() => expect(window.location.pathname).toBe("/collaboration/"));
    expect(window.location.search).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /Room B private/ }));
    await screen.findByRole("heading", { name: "Room B" });

    await act(async () => { window.history.back(); });
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe(linkedPath));
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    await screen.findByRole("heading", { name: "Room A" });
    expect(screen.queryByRole("heading", { name: "Room B" })).toBeNull();
    expect(window.location.pathname + window.location.search).toBe(linkedPath);
  });

  it("preserves a linked room in history through Settings and legacy Collaboration", async () => {
    const id = `ws_${"a".repeat(24)}`;
    const actor = "owner@example.com";
    const roomA = `room_${"b".repeat(24)}`;
    const roomB = `room_${"c".repeat(24)}`;
    const linkedPath = `/threads/?workspace=${id}&room=${roomA}`;
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", linkedPath);
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url);
      if (path === "/api/whoami") return Response.json({ agent: actor, auth: "access" });
      if (path === "/api/workspaces") return Response.json({ workspaces: [{ workspaceId: id, name: "Design team", version: 1, createdAt: 1, membership: { workspaceId: id, userId: actor, role: "owner", version: 1, joinedAt: 1 } }] });
      if (path === "/api/collaboration/rooms") return Response.json({ rooms: [
        { roomId: roomA, title: "Room A", visibility: "private" },
        { roomId: roomB, title: "Room B", visibility: "private" },
      ] });
      if (path === `/api/collaboration/rooms/${roomA}` || path === `/api/collaboration/rooms/${roomB}`) {
        const roomId = path.endsWith(roomA) ? roomA : roomB;
        return Response.json({ room: { roomId, title: roomId === roomA ? "Room A" : "Room B", visibility: "private" }, currentUserId: actor, members: [], messages: [], handoffs: [] });
      }
      return originalFetch(url, options);
    }));

    render(<App />);
    await screen.findByRole("heading", { name: "Room A" });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(window.location.pathname).toBe("/settings/"));
    expect(window.location.search).toMatch(/^\?section=/);
    fireEvent.click(screen.getByRole("button", { name: "Open command menu" }));
    fireEvent.change(within(screen.getByRole("dialog", { name: "Search" })).getByRole("combobox"), { target: { value: "Collaboration" } });
    fireEvent.click(await screen.findByRole("option", { name: "Go to Collaboration" }));
    await waitFor(() => expect(window.location.pathname).toBe("/collaboration/"));
    fireEvent.click(screen.getByRole("button", { name: /Room B private/ }));
    await screen.findByRole("heading", { name: "Room B" });

    await act(async () => { window.history.back(); });
    await waitFor(() => expect(window.location.pathname).toBe("/settings/"));
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    await act(async () => { window.history.back(); });
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe(linkedPath));
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    await screen.findByRole("heading", { name: "Room A" });
    expect(screen.queryByRole("heading", { name: "Room B" })).toBeNull();
  });

  it("keeps the selected room and URL in sync after a directory refresh", async () => {
    const id = `ws_${"a".repeat(24)}`;
    const actor = "owner@example.com";
    const roomA = `room_${"b".repeat(24)}`;
    const roomB = `room_${"c".repeat(24)}`;
    const workspaceResponse = { workspaces: [{ workspaceId: id, name: "Design team", version: 1, createdAt: 1,
      membership: { workspaceId: id, userId: actor, role: "owner", version: 1, joinedAt: 1 } }] };
    let workspaceReads = 0;
    let finishRefresh!: (response: Response) => void;
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", `/threads/?workspace=${id}&room=${roomA}`);
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url);
      if (path === "/api/whoami") return Response.json({ agent: actor, auth: "access" });
      if (path === "/api/workspaces") {
        workspaceReads++;
        return workspaceReads === 1 ? Response.json(workspaceResponse) : new Promise<Response>((resolve) => { finishRefresh = resolve; });
      }
      if (path === "/api/collaboration/rooms") return Response.json({ rooms: [
        { roomId: roomA, title: "Room A", visibility: "private" },
        { roomId: roomB, title: "Room B", visibility: "private" },
      ] });
      if (path === `/api/collaboration/rooms/${roomA}` || path === `/api/collaboration/rooms/${roomB}`) {
        const roomId = path.endsWith(roomA) ? roomA : roomB;
        return Response.json({ room: { roomId, title: roomId === roomA ? "Room A" : "Room B", visibility: "private" }, currentUserId: actor, members: [], messages: [], handoffs: [] });
      }
      return originalFetch(url, options);
    }));

    render(<App />);
    await screen.findByRole("heading", { name: "Room A" });
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(workspaceReads).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: /Room B private/ }));
    await screen.findByRole("heading", { name: "Room B" });
    expect(new URLSearchParams(window.location.search).get("room")).toBe(roomA);

    await act(async () => finishRefresh(Response.json(workspaceResponse)));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("room")).toBe(roomB));
    expect(screen.getByRole("heading", { name: "Room B" })).toBeTruthy();
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
    await screen.findByRole("heading", { name: /Hand off the work/ });
    expect(window.location.pathname).toBe("/tasks/");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findAllByRole("button", { name: "Back to app" });
    expect(window.location.pathname).toBe("/settings/");
    expect(window.location.search).toContain("section=");
  });

  it("opens the new hire conversation, preselects them in Tool policy, and keeps later visits on the default employee", async () => {
    window.history.replaceState(null, "", "/custom-agents/");
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    const builder = { id: "cag-builder", slug: "builder", version: 1, config: { name: "Builder", instructions: "Build.", harness: "opencode" } };
    const scout = { id: "cag-scout", slug: "scout", version: 1, config: { name: "Scout", instructions: "Review the supplied data.", harness: "opencode" } };
    let hired = false;
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url);
      if (/^\/api\/employee-tools\/[^/]+\/policy$/.test(path)) return Response.json({ grants: [], toolScopes: [] });
      if (path === "/api/sessions" && options?.method === "POST") return Response.json({ session: { id: "scout-thread", name: scout.config.name, agentName: "scout-agent", updatedAt: 1, metadata: { customAgentId: scout.id } } });
      if (path !== "/api/custom-agents") return originalFetch(url, options);
      if (options?.method === "POST") {
        hired = true;
        return Response.json({ agent: scout }, { status: 201 });
      }
      return Response.json({ agents: hired ? [builder, scout] : [builder] });
    }));
    render(<App />);
    await screen.findByRole("heading", { name: "Your employee roster" });
    fireEvent.click(screen.getByRole("button", { name: "Hire employee" }));
    const name = screen.getByLabelText("Name");
    expect(document.activeElement).toBe(name);
    fireEvent.change(name, { target: { value: scout.config.name } });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: scout.config.instructions } });
    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    await waitFor(() => expect(hired).toBe(true));
    expect(await screen.findByRole("button", { name: "Rename thread" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Show details panel" }));
    fireEvent.click(within(await screen.findByRole("complementary", { name: "Agent details" })).getByRole("button", { name: /^Tools/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Employee tool policy" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Employee" })).toHaveProperty("value", scout.id));

    await act(async () => {
      window.history.pushState(null, "", "/settings/?section=overview");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    fireEvent.click(await screen.findByRole("button", { name: "Manage employee access" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Employee" })).toHaveProperty("value", builder.id));
  });

  it("switches destinations with Alt+number shortcuts", async () => {
    window.history.replaceState(null, "", "/");
    render(<App />);
    await screen.findByRole("heading", { name: /Hand off the work/ });
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
    fireEvent.click(screen.getByRole("button", { name: /(· workspace|^Workspace profile)$/ }));
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "Design team" }).getAttribute("aria-checked")).toBe("true"));
    expect(within(chats).queryByRole("button", { name: "Workspace" })).toBeNull();
    expect(screen.queryByText("Recents")).toBeNull();
    expect(screen.queryByText("Personal secret plan")).toBeNull();
    expect(screen.queryByText("Private budget notes")).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/sessions")).toBe(false);
  });

  it("shows Review publication on the Pull requests view for a pending pr_publish approval", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/diff/");
    const originalFetch = fetch;
    const run = { runId: "run-pub", task: "Ship the fix", status: "completed", repoUrl: "https://github.com/acme/shop", sandboxId: "s", baseBranch: "main", publishPullRequest: false, generation: 1, createdAt: 1, updatedAt: 2, diff: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n" };
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url);
      if (path.startsWith("/api/runs")) return Response.json({ runs: [run] });
      if (path === "/api/approvals") return Response.json({ approvals: [{ approvalId: "pr-publish:run-pub", threadKey: "t", status: "pending", kind: "pr_publish", task: "Publish", createdAt: 1, payload: { repoUrl: "https://github.com/acme/shop", baseBranch: "main", runId: "run-pub", sha256: "abc", bytes: 1, fileCount: 1 } }], decided: [] });
      return originalFetch(url, options);
    }));
    render(<App />);
    await screen.findByRole("button", { name: /Review publication/ });
  });

  describe("employee workspace navigation", () => {
    const employee = { id: "employee-1", slug: "finance-auditor", version: 1, config: { name: "Finance Auditor", instructions: "Review supplied records.", harness: "opencode", roleTemplateId: "finance" } };
    const stub = () => {
      const originalFetch = fetch;
      localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
      vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
        const path = String(url);
        if (path === "/api/whoami") return Response.json({ agent: "owner@example.com", auth: "access" });
        if (path === "/api/workspaces") return Response.json({ workspaces: [] });
        if (path.startsWith("/api/custom-agents")) return Response.json({ agents: [employee] });
        return originalFetch(url, options);
      }));
    };
    it("opens an employee workspace from the directory and Back returns", async () => {
      window.history.replaceState(null, "", "/custom-agents/");
      stub();
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: "Open workspace Finance Auditor" }));
      const back = await screen.findByRole("button", { name: "Back to employees" });
      fireEvent.click(back);
      await screen.findByRole("button", { name: "Open workspace Finance Auditor" });
      expect(screen.queryByRole("button", { name: "Back to employees" })).toBeNull();
    });
    it("opens that employee's workspace from the Chief of Staff page", async () => {
      window.history.replaceState(null, "", "/chief-of-staff/");
      stub();
      render(<App />);
      await screen.findByRole("region", { name: "Chief of staff" });
      fireEvent.click(await screen.findByRole("button", { name: /Finance Auditor/ }));
      await screen.findByRole("button", { name: "Back to employees" });
    });
  });

  it("shows the Chief of Staff page in personal scope and the personal-only notice in a team workspace", async () => {
    const id = `ws_${"e".repeat(24)}`, actor = "owner@example.com";
    window.history.replaceState(null, "", "/chief-of-staff/");
    const originalFetch = fetch;
    const mock = (workspaces: unknown[]) => vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const requested = String(url);
      if (requested === "/api/whoami") return Response.json({ agent: actor, auth: "access" });
      if (requested === "/api/workspaces") return Response.json({ workspaces });
      return originalFetch(url, options);
    }));
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    mock([]);
    const personal = render(<App />);
    await screen.findByRole("region", { name: "Chief of staff" });
    expect(screen.queryByRole("heading", { name: "Open this feature in your personal workspace" })).toBeNull();
    personal.unmount();
    mock([{ workspaceId: id, name: "Design team", version: 1, createdAt: 1, membership: { workspaceId: id, userId: actor, role: "owner", version: 1, joinedAt: 1 } }]);
    localStorage.setItem(`shiba:team-workspace:${encodeURIComponent(actor)}`, id);
    render(<App />);
    await screen.findByRole("heading", { name: "Open this feature in your personal workspace" });
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
    const start = await screen.findByRole("button", { name: `New thread with ${profile.config.name}` }) as HTMLButtonElement;
    // Starting a thread opens once the thread registry has answered.
    await waitFor(() => expect(start.disabled).toBe(false));
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
      if (String(url) === "/api/collaboration/rooms") return Response.json({ rooms: [{ roomId: "room-1", title: "Shared room", visibility: "private" }] });
      if (String(url) === `/api/collaboration/rooms/room-1`) return Response.json({
        room: { roomId: "room-1", title: "Shared room", visibility: "private" }, currentUserId: actor,
        members: [], messages: [], handoffs: [],
      });
      return originalFetch(url, options);
    }));
    render(<App />);
    await screen.findByText(/Chat with your team/);
    await screen.findByRole("heading", { name: "Shared room" });
    expect(window.location.pathname).toBe("/collaboration/");
    expect(window.location.search).toBe("");
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

describe("personal provider task selection", () => {
  it("prefills the connected default while preserving an explicit task choice", async () => {
    window.history.replaceState(null, "", "/threads/");
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    const priorFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/providers") return Response.json({ defaultProviderId: "codex", providers: [{
        id: "codex", harness: "codex-subscription", defaultModel: "openai/example", connection: { phase: "connected" },
      }] });
      return priorFetch(url, options);
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Review as work" }));
    await waitFor(() => expect(screen.getByTestId("selected-harness").textContent).toBe("codex-subscription"));
    fireEvent.click(screen.getByRole("button", { name: "Choose Claude API" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "Back to app" }))[0]!);
    await waitFor(() => expect(screen.getByTestId("selected-harness").textContent).toBe("claude-code"));
  });
});

describe("first-run setup reminders", () => {
  function installProgress(overrides: Partial<FirstRunProgressSnapshot> = {}) {
    let progress: FirstRunProgressSnapshot = {
      revision: 1, currentStep: "channels", dismissedAt: 1, activatedAt: null,
      connectionVerifiedAt: null, firstSuccessfulRunAt: null, acceptedArtifactAt: null,
      draftTaskId: null, draftTask: null,
      evidence: { connectedProvider: false, successfulRun: false, acceptedDeliverable: false },
      ...overrides,
    };
    const originalFetch = fetch;
    const updates = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/whoami") return Response.json({ agent: "test-operator", auth: "better-auth" });
      if (String(url) === "/api/onboarding/progress") {
        if (options?.method === "POST") {
          const body = JSON.parse(String(options.body));
          updates(body);
          progress = { ...progress, revision: progress.revision + 1,
            ...(body.action === "resume" ? { dismissedAt: null } : {}),
            ...(body.draftTask ? { draftTask: { ...EMPTY_ONBOARDING_DRAFT, ...progress.draftTask, ...body.draftTask } } : {}),
          };
        }
        return Response.json({ ...progress, status: deriveOnboardingStatus(progress) });
      }
      return originalFetch(url, options);
    }));
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    return updates;
  }

  it.each(["/threads/", "/work/"])("shows the popup once on %s and keeps the banner after Not now", async (path) => {
    window.history.replaceState(null, "", path);
    const updates = installProgress();
    render(<App />);
    const popup = await screen.findByRole("dialog", { name: "Your first task is waiting" });
    fireEvent.click(within(popup).getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog", { name: "Your first task is waiting" })).toBeNull();
    expect(screen.getByRole("region", { name: "Setup reminder" })).toBeTruthy();
    expect(updates).not.toHaveBeenCalled();
    cleanup();
    render(<App />);
    await screen.findByRole("region", { name: "Setup reminder" });
    expect(screen.queryByRole("dialog", { name: "Your first task is waiting" })).toBeNull();
    expect(window.location.pathname).toBe(path);
  });

  it("blocks app navigation and submit shortcuts while the popup is open", async () => {
    window.history.replaceState(null, "", "/threads/?prompt=Draft%20a%20brief");
    installProgress();
    render(<App />);
    await screen.findByRole("dialog", { name: "Your first task is waiting" });
    const sentBefore = mocks.chat.sendMessage.mock.calls.length;
    fireEvent.keyDown(window, { key: "2", code: "Digit2", altKey: true });
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    await act(async () => {});
    expect(window.location.pathname).toBe("/threads/");
    expect(mocks.chat.sendMessage.mock.calls.length).toBe(sentBefore);
    expect(vi.mocked(fetch).mock.calls.some(([url, options]) => String(url).startsWith("/api/runs") && options?.method === "POST")).toBe(false);
    expect(screen.getByRole("dialog", { name: "Your first task is waiting" })).toBeTruthy();
  });

  it("keeps banner dismissal in the tab session without changing server progress", async () => {
    const updates = installProgress();
    render(<App />);
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Your first task is waiting" })).getByRole("button", { name: "Not now" }));
    fireEvent.click(within(screen.getByRole("region", { name: "Setup reminder" })).getByRole("button", { name: "Dismiss for now" }));
    expect(screen.queryByRole("region", { name: "Setup reminder" })).toBeNull();
    cleanup();
    render(<App />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/onboarding/progress", expect.anything()));
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Setup reminder" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Your first task is waiting" })).toBeNull();
    expect(updates).not.toHaveBeenCalled();
    cleanup();
    sessionStorage.clear();
    render(<App />);
    await screen.findByRole("dialog", { name: "Your first task is waiting" });
    expect(screen.getByRole("region", { name: "Setup reminder" })).toBeTruthy();
  });

  it("never shows reminders for an activated account with old session flags", async () => {
    sessionStorage.setItem("shiba:onboarding-nudge:popup-shown:test-operator", "1");
    installProgress({ activatedAt: 9 });
    render(<App />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/onboarding/progress", expect.anything()));
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Setup reminder" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Your first task is waiting" })).toBeNull();
  });

  it("hides reminders while the guided first-result flow auto-opens", async () => {
    window.history.replaceState(null, "", "/threads/");
    installProgress({ dismissedAt: null });
    render(<App />);
    const journey = await screen.findByRole("region", { name: "Guided onboarding" });
    expect(journey.textContent).toContain("Step 2 of 6");
    // A signed-in account already owns its personal workspace, so the flow opens
    // on the first unfinished stage rather than re-asking for it.
    expect(journey.textContent).toContain("Step 2 of 6");
    expect(journey.querySelector('[aria-current="step"]')?.textContent).toContain("Connect a provider");
    expect(screen.queryByRole("region", { name: "Setup reminder" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Your first task is waiting" })).toBeNull();
  });

  it("re-reads provider readiness when the window returns, so a connection made in the session shows", async () => {
    window.history.replaceState(null, "", "/threads/");
    installProgress({ dismissedAt: null });
    const originalFetch = fetch;
    let connected = false;
    let providerReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/providers") {
        providerReads += 1;
        return Response.json({
          providers: [{ id: "codex", label: "Codex plan", connection: { phase: connected ? "connected" : "disconnected" } }],
        });
      }
      return originalFetch(url, options);
    }));
    render(<App />);
    const journey = await screen.findByRole("region", { name: "Guided onboarding" });
    await waitFor(() => expect(journey.textContent).toContain("No provider is ready yet"));
    const readsBefore = providerReads;
    connected = true;
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(providerReads).toBeGreaterThan(readsBefore));
    await waitFor(() =>
      expect(within(screen.getByRole("region", { name: "Guided onboarding" })).getByRole("button", { name: /^Connect a provider — Provider ready/ })).toBeTruthy(),
    );
  });

  it("keeps a returning account with completed work out of setup once the runs read lands", async () => {
    window.history.replaceState(null, "", "/threads/");
    installProgress({ dismissedAt: null });
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url).startsWith("/api/runs")) {
        return Response.json({
          runs: [{ runId: "old-run", task: "Ship the old brief", status: "completed", repoUrl: "", sandboxId: "s", baseBranch: "main", publishPullRequest: false, generation: 1, createdAt: 1, updatedAt: 2 }],
        });
      }
      return originalFetch(url, options);
    }));
    render(<App />);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Guided onboarding" })).toBeNull());
  });

  it("offers only the approval issued for the saved draft, and opens the Work review for it", async () => {
    window.history.replaceState(null, "", "/threads/");
    const draftTask = {
      ...EMPTY_ONBOARDING_DRAFT,
      goal: "Draft the launch brief",
      audience: "The team",
      acceptance: "A one-page brief",
      preparedAt: 2,
      employeeId: "employee_1",
      employeeVersion: 1,
    };
    installProgress({ dismissedAt: null, draftTaskId: "draft_1", draftTask });
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/approvals") {
        return Response.json({
          approvals: [
            { approvalId: "approval_linked", draftTaskId: "draft_1", task: "Draft the launch brief", repoUrl: "", threadKey: "personal" },
            // Same words as the draft, no server-issued draft association: it is
            // still someone else's decision and must not be offered here.
            { approvalId: "approval_lookalike", task: "Draft the launch brief", repoUrl: "", threadKey: "personal" },
          ],
          decided: [],
        });
      }
      return originalFetch(url, options);
    }));
    render(<App />);
    const journey = await screen.findByRole("region", { name: "Guided onboarding" });
    fireEvent.click(within(journey).getByRole("button", { name: /^Approve the run —/ }));
    await screen.findByRole("button", { name: "Review and approve this run" });
    // One linked approval, one text lookalike: only the linked one is offered.
    expect(screen.getAllByText("Draft the launch brief")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Approve and start" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review and approve this run" }));
    await waitFor(() => expect(window.location.pathname).toBe("/work/"));
    // The decision surface is the existing Work approval card, and focus lands on it.
    await waitFor(() => expect(screen.queryByRole("region", { name: "Guided onboarding" })).toBeNull());
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url) === "/api/approvals" && init?.method === "POST")).toBe(false);
  });

  it("offers no action when the only pending approval merely shares the draft's text", async () => {
    window.history.replaceState(null, "", "/threads/");
    const draftTask = {
      ...EMPTY_ONBOARDING_DRAFT,
      goal: "Draft the launch brief",
      audience: "The team",
      acceptance: "A one-page brief",
      preparedAt: 2,
      employeeId: "employee_1",
      employeeVersion: 1,
    };
    installProgress({ dismissedAt: null, draftTaskId: "draft_1", draftTask });
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/approvals") {
        return Response.json({
          approvals: [
            { approvalId: "approval_lookalike", task: "Draft the launch brief", repoUrl: "", threadKey: "personal" },
          ],
          decided: [],
        });
      }
      return originalFetch(url, options);
    }));
    render(<App />);
    const journey = await screen.findByRole("region", { name: "Guided onboarding" });
    fireEvent.click(within(journey).getByRole("button", { name: /^Approve the run —/ }));
    await screen.findByText(/One other approval is waiting/);
    expect(screen.queryByRole("button", { name: "Review and approve this run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve and start" })).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url) === "/api/approvals" && init?.method === "POST")).toBe(false);
  });

  it("saves the missing goal step before resuming first-task setup", async () => {
    const updates = installProgress({ draftTask: { ...EMPTY_ONBOARDING_DRAFT, currentStep: "review" } });
    render(<App />);
    const popup = await screen.findByRole("dialog", { name: "Your first task is waiting" });
    fireEvent.click(within(popup).getByRole("button", { name: "Continue setup" }));
    await screen.findByRole("region", { name: "First task setup" });
    expect(updates).toHaveBeenCalledWith(expect.objectContaining({ action: "save-draft", draftTask: { currentStep: "goal" } }));
    expect(screen.getByText("What should be ready when this is done?")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Setup reminder" })).toBeNull();
  });

  it("does not let a delayed Continue write interrupt newer navigation", async () => {
    installProgress({ draftTask: { ...EMPTY_ONBOARDING_DRAFT, currentStep: "review" } });
    const progressFetch = fetch;
    let finish!: () => void;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const response = await progressFetch(url, options);
      if (String(url) === "/api/onboarding/progress" && options?.method === "POST") {
        await new Promise<void>((resolve) => { finish = resolve; });
      }
      return response;
    }));
    render(<App />);
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Your first task is waiting" })).getByRole("button", { name: "Continue setup" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await act(async () => { window.history.pushState(null, "", "/team/"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await act(async () => finish());
    expect(window.location.pathname).toBe("/team/");
    expect(screen.queryByRole("region", { name: "First task setup" })).toBeNull();
  });

  it("resumes a prepared first task at Providers without writing progress", async () => {
    const updates = installProgress({ draftTaskId: "draft_fixture", draftTask: {
      ...EMPTY_ONBOARDING_DRAFT, goal: "A brief", audience: "My team", acceptance: "Reviewed", preparedAt: 1,
    } });
    render(<App />);
    const popup = await screen.findByRole("dialog", { name: "Your first task is waiting" });
    fireEvent.click(within(popup).getByRole("button", { name: "Continue setup" }));
    await waitFor(() => expect(window.location.pathname).toBe("/providers/"));
    expect(updates).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "First task setup" })).toBeNull();
  });

  it("does not show a personal reminder in a selected team workspace", async () => {
    const id = `ws_${"a".repeat(24)}`;
    const actor = "owner@example.com";
    localStorage.setItem(`shiba:team-workspace:${encodeURIComponent(actor)}`, id);
    installProgress();
    const progressFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/whoami") return Response.json({ agent: actor, auth: "better-auth" });
      if (String(url) === "/api/workspaces") return Response.json({ workspaces: [{ workspaceId: id, name: "Design team", version: 1, createdAt: 1,
        membership: { workspaceId: id, userId: actor, role: "owner", version: 1, joinedAt: 1 } }] });
      return progressFetch(url, options);
    }));
    render(<App />);
    await screen.findByRole("button", { name: /(· workspace|^Workspace profile)$/ });
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Setup reminder" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Your first task is waiting" })).toBeNull();
  });
});

describe("bot page without a thread", () => {
  const research = { id: "cag-research", orgId: "self-hosted", slug: "research", version: 1, config: { name: "Research bot", instructions: "Write briefs.", harness: "opencode" } };
  const engineering = { id: "cag-engineering", orgId: "self-hosted", slug: "engineering", version: 1, config: { name: "Engineering bot", instructions: "Review code.", harness: "opencode" } };
  const RESEARCH_THREAD = "11111111-1111-4111-8111-111111111111";
  const ENGINEERING_THREAD = "22222222-2222-4222-8222-222222222222";
  const researchThread = { id: RESEARCH_THREAD, name: "Competitor brief", agentName: `web:test-operator:${RESEARCH_THREAD}`, createdAt: 3, updatedAt: 3, metadata: { customAgentId: research.id } };
  const engineeringThreadRecord = { id: ENGINEERING_THREAD, name: "Flaky test triage", agentName: `web:test-operator:${ENGINEERING_THREAD}`, createdAt: 2, updatedAt: 2, metadata: { customAgentId: engineering.id } };

  /** Two bots; Research always has a thread, Engineering only when asked. */
  function stubBots(resume?: (path: string) => Promise<Response>, engineeringThread?: boolean) {
    const originalFetch = fetch;
    const request = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url);
      if (path === "/api/whoami") return Response.json({ agent: "test-operator", auth: "access" });
      if (path === "/api/custom-agents" && options?.method !== "POST") return Response.json({ agents: [research, engineering] });
      if (path === "/api/sessions" && options?.method === "POST") return Response.json({ status: 201, session: { id: "55555555-5555-4555-8555-555555555555", name: "Engineering bot", agentName: "web:test-operator:55555555-5555-4555-8555-555555555555", createdAt: 5, updatedAt: 5, metadata: { customAgentId: engineering.id } } });
      if (path === "/api/sessions" && options?.method !== "POST") return Response.json({ sessions: engineeringThread ? [researchThread, engineeringThreadRecord] : [researchThread], defaultSessionId: "default" });
      if (/^\/api\/sessions\/[^/]+\/resume$/.test(path)) return resume ? resume(path) : Response.json({ session: researchThread, resumed: true });
      if (path === "/api/agents") return Response.json({ agents: [] });
      if (path === "/api/approvals") return Response.json({ approvals: [], decided: [] });
      if (path.startsWith("/api/runs")) return Response.json({ runs: [] });
      return originalFetch(url, options);
    });
    vi.stubGlobal("fetch", request);
    return request;
  }

  /** A bot's page is reachable from the Agents view, where every bot is listed. */
  async function openBotFromAgentsView(name: RegExp) {
    await act(async () => {
      window.history.pushState(null, "", "/custom-agents/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const row = await screen.findAllByRole("button", { name });
    fireEvent.click(row[0]!);
  }

  it("opens a threadless bot without borrowing the previous bot's thread", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", `/threads/?session=${RESEARCH_THREAD}`);
    mocks.chat.messages = [];
    const request = stubBots();
    render(<App />);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(RESEARCH_THREAD));

    await openBotFromAgentsView(/Engineering bot/);

    await screen.findByRole("heading", { name: "Engineering bot has no thread yet" });
    expect(screen.queryByTestId("task-composer")).toBeNull();
    expect(screen.queryByLabelText(/Thread name|Rename thread/i)).toBeNull();
    await waitFor(() => expect(new URLSearchParams(window.location.search).has("session")).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "Start a thread with Engineering bot" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/sessions", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: "Engineering bot", metadata: { customAgentId: engineering.id } }),
    })));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe("55555555-5555-4555-8555-555555555555"));
    expect(screen.queryByRole("heading", { name: "Engineering bot has no thread yet" })).toBeNull();
  });

  it("resumes an employee's newest thread from the Threads panel without creating one", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    const OLDER_RESEARCH_THREAD = "33333333-3333-4333-8333-333333333333";
    const olderResearchThread = { ...researchThread, id: OLDER_RESEARCH_THREAD, name: "Older brief", agentName: `web:test-operator:${OLDER_RESEARCH_THREAD}`, createdAt: 1, updatedAt: 1 };
    window.history.replaceState(null, "", "/threads/");
    mocks.chat.messages = [];
    const bots = stubBots(undefined, true);
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) =>
      String(url) === "/api/sessions" && options?.method !== "POST"
        ? Response.json({ sessions: [olderResearchThread, researchThread, engineeringThreadRecord], defaultSessionId: "default" })
        : bots(url, options)));
    const urlSession = () => new URLSearchParams(window.location.search).get("session");
    const created = () => bots.mock.calls.filter(([url, options]) => String(url) === "/api/sessions" && (options as RequestInit | undefined)?.method === "POST");
    render(<App />);

    // A ready personal registry lists employees in place of the flat chat list; their threads stay collapsed.
    const employees = async () => within(await screen.findByRole("list", { name: "Employees" }));
    expect((await employees()).queryByText("Older brief")).toBeNull();
    fireEvent.click(await (await employees()).findByRole("button", { name: "Expand Research bot" }));
    expect((await employees()).getByRole("group", { name: "Research bot threads" })).toBeTruthy();
    expect((await employees()).getByText("Competitor brief")).toBeTruthy();
    expect((await employees()).getByText("Older brief")).toBeTruthy();

    // Choosing an employee resumes its newest thread, not an older one.
    fireEvent.click(await (await employees()).findByRole("button", { name: employeeRowName("Research bot") }));
    await waitFor(() => expect(urlSession()).toBe(RESEARCH_THREAD));
    expect(bots).toHaveBeenCalledWith(`/api/sessions/${RESEARCH_THREAD}/resume`, expect.objectContaining({ method: "POST" }));
    expect(bots).not.toHaveBeenCalledWith(`/api/sessions/${OLDER_RESEARCH_THREAD}/resume`, expect.anything());

    fireEvent.click((await employees()).getByRole("button", { name: employeeRowName("Engineering bot") }));
    await waitFor(() => expect(urlSession()).toBe(ENGINEERING_THREAD));
    expect(bots).toHaveBeenCalledWith(`/api/sessions/${ENGINEERING_THREAD}/resume`, expect.objectContaining({ method: "POST" }));
    expect(created()).toHaveLength(0);

    // An older thread is still reachable directly from the same list.
    fireEvent.click((await employees()).getByText("Older brief"));
    await waitFor(() => expect(urlSession()).toBe(OLDER_RESEARCH_THREAD));
    expect(created()).toHaveLength(0);

    // New chat and global search stay in this panel.
    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search all" }));
    expect(await screen.findByRole("dialog", { name: "Search" })).toBeTruthy();
  });

  it("opens an employee with no thread on its own empty page instead of creating a thread", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", `/threads/?session=${RESEARCH_THREAD}`);
    mocks.chat.messages = [];
    const request = stubBots();
    render(<App />);
    // The panel can re-mount while the registry settles, so look it up fresh each time.
    const engineeringRow = await waitFor(() => within(screen.getByRole("list", { name: "Employees" })).getByRole("button", { name: employeeRowName("Engineering bot") }));
    fireEvent.click(engineeringRow);
    await screen.findByRole("heading", { name: "Engineering bot has no thread yet" });
    expect(request.mock.calls.filter(([url, options]) => String(url) === "/api/sessions" && (options as RequestInit | undefined)?.method === "POST")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Start a thread with Engineering bot" })).toBeTruthy();
  });

  it("opens the general composer only after New chat succeeds from a threadless employee", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", `/threads/?session=${RESEARCH_THREAD}`);
    mocks.chat.messages = [];
    const bots = stubBots();
    const newThreadId = "66666666-6666-4666-8666-666666666666";
    const createGeneralThread = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({
        session: { id: newThreadId, name: "New chat", agentName: `web:test-operator:${newThreadId}`, updatedAt: 5 },
      }, { status: 201 }));
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, options?: RequestInit) =>
      String(url) === "/api/sessions" && options?.method === "POST"
        ? createGeneralThread(options.body)
        : bots(url, options)));
    render(<App />);

    const emptyPage = { name: "Engineering bot has no thread yet" };
    const employees = await screen.findByRole("list", { name: "Employees" });
    fireEvent.click(within(employees).getByRole("button", { name: employeeRowName("Engineering bot") }));
    await screen.findByRole("heading", emptyPage);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "New chat" })); });

    expect(createGeneralThread).toHaveBeenCalledExactlyOnceWith("{}");
    expect(screen.getByRole("heading", emptyPage)).toBeTruthy();
    expect(screen.queryByTestId("chat-composer")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await screen.findByTestId("chat-composer");
    expect(screen.queryByRole("heading", emptyPage)).toBeNull();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(newThreadId));
    expect(createGeneralThread.mock.calls).toEqual([["{}"], ["{}"]]);
  });

  it("opens Analytics without resuming a thread when selecting a recent run", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/threads/");
    mocks.chat.messages = [];
    const bots = stubBots();
    const run = { runId: "recent-run", task: "Compile the weekly brief", status: "completed", repoUrl: "", sandboxId: "s", baseBranch: "main", publishPullRequest: false, generation: 1, createdAt: 1, updatedAt: 2 };
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, options?: RequestInit) =>
      String(url).startsWith("/api/runs") ? Promise.resolve(Response.json({ runs: [run] })) : bots(url, options)));
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Compile the weekly brief/ }));
    await screen.findByRole("heading", { name: "Usage" });
    await waitFor(() => expect(window.location.pathname).toBe("/analytics/"));
    expect(bots.mock.calls.some(([url]) => String(url).endsWith("/resume"))).toBe(false);
  });

  it("shows the conversation's unarchived run in both progress and Work details, not a newer archived run", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", `/threads/?session=${RESEARCH_THREAD}`);
    mocks.chat.messages = [];
    const bots = stubBots();
    const run = { runId: "retained-review-run", task: "Compile the weekly brief", status: "completed", repoUrl: "", sandboxId: "s", baseBranch: "main", publishPullRequest: false, generation: 1, createdAt: 1, updatedAt: 2 };
    const archived = { ...run, runId: "archived-review-run", task: "Archived brief", updatedAt: 8, archivedAt: 8 };
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, options?: RequestInit) => {
      const path = new URL(String(url), window.location.origin);
      if (path.pathname !== "/api/runs") return bots(url, options);
      return Promise.resolve(Response.json({ runs: path.searchParams.get("session") === RESEARCH_THREAD ? [run, archived] : [] }));
    }));
    render(<App />);

    const progress = await screen.findByTestId("run-progress");
    expect(within(progress).getByText(run.task)).toBeTruthy();
    expect(within(progress).queryByText(archived.task)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Task details" }));
    await waitFor(() => {
      expect(window.location.pathname).toBe("/work/");
      const params = new URLSearchParams(window.location.search);
      expect(params.get("task")).toBe(run.runId);
      expect(params.get("taskKind")).toBe("run");
    });
  });

  it("omits Task details for shared work in default chat but still lists that work on Work", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/threads/");
    mocks.chat.messages = [];
    const bots = stubBots();
    const run = {
      runId: "shared-automation", task: "Shared automation result", status: "completed", repoUrl: "", sandboxId: "s",
      baseBranch: "main", publishPullRequest: false, generation: 1, createdAt: 1, updatedAt: 2, fromSharedStore: true,
    };
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, options?: RequestInit) =>
      String(url).startsWith("/api/runs") ? Promise.resolve(Response.json({ runs: [run] })) : bots(url, options)));
    render(<App />);

    expect(within(await screen.findByTestId("run-progress")).getByText(run.task)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Task details" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    const list = await screen.findByRole("region", { name: "List view" });
    expect(await within(list).findByText(run.task)).toBeTruthy();
  });

  it("keeps an employee's thread reachable from Tasks when the directory fails", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/tasks/");
    mocks.chat.messages = [];
    const bots = stubBots();
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, options?: RequestInit) =>
      String(url) === "/api/custom-agents" ? Promise.resolve(new Response(null, { status: 503 })) : bots(url, options)));
    render(<App />);

    await openSidebarThread(/Competitor brief/, "Unavailable employee");
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(RESEARCH_THREAD));
    expect(bots).toHaveBeenCalledWith(`/api/sessions/${RESEARCH_THREAD}/resume`, expect.objectContaining({ method: "POST" }));
  });

  it("does not leave the previous bot's composer live when a bot's thread fails to resume", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", `/threads/?session=${RESEARCH_THREAD}`);
    mocks.chat.messages = [];
    stubBots(async () => new Response(JSON.stringify({ error: "Session service unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } }), true);
    render(<App />);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(RESEARCH_THREAD));

    await openBotFromAgentsView(/Engineering bot/);

    await screen.findByRole("heading", { name: /Engineering bot's thread could not be opened/ });
    // The bot and its session commit together: no Research composer survives under this bot.
    expect(screen.queryByTestId("task-composer")).toBeNull();
    expect(screen.queryByTestId("chat-composer")).toBeNull();
    await waitFor(() => expect(new URLSearchParams(window.location.search).has("session")).toBe(false));
    // The keyboard send shortcut reaches nothing here either.
    mocks.chat.sendMessage.mockClear();
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    expect(mocks.chat.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["roster", "Chat sidebar"])("opens bot details from the %s without leaving the previous composer live", async (source) => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", `/threads/?session=${RESEARCH_THREAD}`);
    mocks.chat.messages = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    stubBots(async (path) => {
      if (!path.includes(ENGINEERING_THREAD)) return Response.json({ resumed: true });
      await held;
      return Response.json({ session: engineeringThreadRecord, resumed: true });
    }, true);
    render(<App />);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(RESEARCH_THREAD));

    const closeDetails = screen.queryByRole("button", { name: "Close agent details" });
    if (closeDetails) fireEvent.click(closeDetails);
    expect(screen.queryByRole("complementary", { name: "Agent details" })).toBeNull();
    expect(screen.getByTestId("chat-composer")).toBeTruthy();

    if (source === "roster") await openBotFromAgentsView(/Engineering bot/);
    else {
      const employees = await screen.findByRole("list", { name: "Employees" });
      fireEvent.click(within(employees).getByRole("button", { name: employeeRowName("Engineering bot") }));
    }
    const details = screen.getByRole("complementary", { name: "Agent details" });
    expect(within(details).getByRole("heading", { name: "Engineering bot" })).toBeTruthy();
    await screen.findByRole("heading", { name: /Opening Engineering bot/ });
    if (source === "Chat sidebar") {
      expect(new URLSearchParams(window.location.search).get("session")).toBe(RESEARCH_THREAD);
    }
    expect(screen.queryByTestId("task-composer")).toBeNull();
    expect(screen.queryByTestId("chat-composer")).toBeNull();
    mocks.chat.sendMessage.mockClear();
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    expect(mocks.chat.sendMessage).not.toHaveBeenCalled();

    await act(async () => { release?.(); await held; });
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(ENGINEERING_THREAD));
    expect(await screen.findByRole("button", { name: "Hide details panel" })).toBeTruthy();
    if (source === "Chat sidebar") {
      await act(async () => { window.history.back(); });
      await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(RESEARCH_THREAD));
    }
  });

  it("keeps Engineering as the recovery bot when its named thread was removed", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    // Start inside Research's named thread, with its conversation actually on
    // screen, then open Engineering, whose thread is gone.
    window.history.replaceState(null, "", `/threads/?session=${RESEARCH_THREAD}`);
    mocks.chat.messages = [{ id: "m1", role: "assistant", parts: [{ type: "text", text: "Annual report history" }] }] as never[];
    const request = stubBots(async (path) => {
      if (!path.includes(ENGINEERING_THREAD)) return Response.json({ resumed: true });
      return new Response(JSON.stringify({ error: "Session not found." }), { status: 404, headers: { "Content-Type": "application/json" } });
    }, true);
    render(<App />);
    // Wait for Research's own conversation and composer, not just the URL.
    await screen.findByText("Annual report history");
    await waitFor(() => expect(screen.getAllByRole("navigation", { name: "Breadcrumb" }).map((nav) => nav.textContent).join(" ")).toContain("Research bot"));
    expect(await screen.findByTestId("chat-composer")).toBeTruthy();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(RESEARCH_THREAD));

    await openBotFromAgentsView(/Engineering bot/);

    await screen.findByRole("heading", { name: /Engineering bot's thread could not be opened/ });
    expect(screen.getByText(/That thread was removed from this workspace/)).toBeTruthy();
    expect(screen.queryByTestId("chat-composer")).toBeNull();
    await waitFor(() => expect(new URLSearchParams(window.location.search).has("session")).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "Start a thread with Engineering bot" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/sessions", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: "Engineering bot", metadata: { customAgentId: engineering.id } }),
    })));
  });

  it("does not call a superseded resume a failure", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", `/threads/?session=${RESEARCH_THREAD}`);
    mocks.chat.messages = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    // Engineering's resume hangs, then fails after Research is selected again.
    stubBots(async (path) => {
      if (!path.includes(ENGINEERING_THREAD)) return Response.json({ resumed: true });
      await held;
      return new Response(JSON.stringify({ error: "late failure" }), { status: 503, headers: { "Content-Type": "application/json" } });
    }, true);
    render(<App />);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(RESEARCH_THREAD));

    await openBotFromAgentsView(/Engineering bot/);
    await screen.findByRole("heading", { name: /Opening Engineering bot/ });

    await openSidebarThread(/Competitor brief/, "Research bot");
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(RESEARCH_THREAD));
    await act(async () => { release?.(); await held; });
    await act(async () => { await Promise.resolve(); });

    // The newer Research selection owns the page; the stale failure is not narrated.
    expect(screen.queryByRole("heading", { name: /could not be opened/ })).toBeNull();
    expect(await screen.findByTestId("chat-composer")).toBeTruthy();
  });

  it("drops a resume reply that lands after a newer bot was opened", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/threads/");
    mocks.chat.messages = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    stubBots(async () => { await held; return Response.json({ session: researchThread, resumed: true }); });
    render(<App />);
    await openSidebarThread(/Competitor brief/, "Research bot");
    await openBotFromAgentsView(/Engineering bot/);
    await screen.findByRole("heading", { name: "Engineering bot has no thread yet" });

    await act(async () => { release?.(); await held; });
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole("heading", { name: "Engineering bot has no thread yet" })).toBeTruthy();
    await waitFor(() => expect(new URLSearchParams(window.location.search).has("session")).toBe(false));
    expect(screen.queryAllByRole("navigation", { name: "Breadcrumb" }).map((nav) => nav.textContent).join(" ")).not.toContain("Research bot");
  });
});

describe("bot run outputs across a thread switch", () => {
  const research = { id: "cag-research", orgId: "self-hosted", slug: "research", version: 1, config: { name: "Research bot", instructions: "Write briefs.", harness: "opencode" } };
  const THREAD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const THREAD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const threadA = { id: THREAD_A, name: "First brief", agentName: `web:test-operator:${THREAD_A}`, createdAt: 9, updatedAt: 9, metadata: { customAgentId: research.id } };
  const threadB = { id: THREAD_B, name: "Second brief", agentName: `web:test-operator:${THREAD_B}`, createdAt: 5, updatedAt: 5, metadata: { customAgentId: research.id } };
  const finishedRun = {
    runId: "run-a", sandboxId: "sandbox-1", repoUrl: "", task: "Write the brief", baseBranch: "main",
    publishPullRequest: false, generation: 1, status: "completed", createdAt: 1, updatedAt: 2,
    customAgentId: research.id, deliverables: [{ path: "reports/first.md", bytes: 10, mediaType: "text/markdown" }],
  };

  it("ignores a 405 resume that lands after the first thread was selected again", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", `/threads/?session=${THREAD_A}`);
    mocks.chat.messages = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const originalFetch = fetch;
    const runsRequests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const parsed = new URL(String(url), "http://localhost");
      if (parsed.pathname === "/api/whoami") return Response.json({ agent: "test-operator", auth: "access" });
      if (parsed.pathname === "/api/custom-agents" && options?.method !== "POST") return Response.json({ agents: [research] });
      if (parsed.pathname === "/api/sessions" && options?.method !== "POST") return Response.json({ sessions: [threadA, threadB], defaultSessionId: "default" });
      if (/^\/api\/sessions\/[^/]+\/resume$/.test(parsed.pathname)) {
        // The second thread's resume is held, then answers 405 (route unsupported);
        // the first thread's succeeds at once.
        if (!parsed.pathname.includes(THREAD_B)) return Response.json({ resumed: true });
        await held;
        return new Response(null, { status: 405 });
      }
      if (parsed.pathname === "/api/agents") return Response.json({ agents: [] });
      if (parsed.pathname === "/api/approvals") return Response.json({ approvals: [], decided: [] });
      if (parsed.pathname.startsWith("/api/runs")) {
        runsRequests.push(parsed.pathname + parsed.search);
        return Response.json({ runs: [] });
      }
      return originalFetch(url, options);
    }));
    render(<App />);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(THREAD_A));

    // Switch to the second thread (its resume hangs), then back to the first.
    fireEvent.click(await screen.findByRole("button", { name: /Second brief/ }));
    fireEvent.click(await screen.findByRole("button", { name: /First brief/ }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(THREAD_A));
    expect(await screen.findByTestId("chat-composer")).toBeTruthy();

    const before = runsRequests.length;
    await act(async () => { release?.(); await held; });
    await act(async () => { await Promise.resolve(); });

    // The abandoned resume's 405 must not switch session scoping off behind the
    // thread now on screen: that would send the next read to the default store.
    const after = runsRequests.slice(before);
    expect(after.filter((path) => !path.includes("session="))).toHaveLength(0);
    expect(screen.queryByText(/does not support session-scoped runs/)).toBeNull();
    expect(new URLSearchParams(window.location.search).get("session")).toBe(THREAD_A);
  });

  it("keeps the previous thread's file on its own session while the next read is pending", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", `/threads/?session=${THREAD_A}`);
    mocks.chat.messages = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const raw = String(url);
      const parsed = new URL(raw, "http://localhost");
      if (parsed.pathname === "/api/whoami") return Response.json({ agent: "test-operator", auth: "access" });
      if (parsed.pathname === "/api/custom-agents" && options?.method !== "POST") return Response.json({ agents: [research] });
      if (parsed.pathname === "/api/sessions" && options?.method !== "POST") return Response.json({ sessions: [threadA, threadB], defaultSessionId: "default" });
      if (/^\/api\/sessions\/[^/]+\/resume$/.test(parsed.pathname)) return Response.json({ resumed: true });
      if (parsed.pathname === "/api/agents") return Response.json({ agents: [] });
      if (parsed.pathname === "/api/approvals") return Response.json({ approvals: [], decided: [] });
      if (parsed.pathname.startsWith("/api/runs")) {
        // Hold the second thread's answer so the switch is observed mid-flight.
        if (parsed.searchParams.get("session") === THREAD_B) { await held; return Response.json({ runs: [] }); }
        return Response.json({ runs: [finishedRun] });
      }
      return originalFetch(url, options);
    }));
    render(<App />);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(THREAD_A));

    await act(async () => {
      window.history.pushState(null, "", "/custom-agents/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    fireEvent.click((await screen.findAllByRole("button", { name: /Research bot/ }))[0]!);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(THREAD_A));

    fireEvent.click(await screen.findByRole("tab", { name: "Library" }));
    const panel = within(await screen.findByRole("tabpanel", { name: "Library" }));
    const link = await panel.findByRole("link", { name: "Download reports/first.md" });
    expect(link.getAttribute("href")).toBe(`/api/runs/run-a/deliverables/0?session=${THREAD_A}`);

    fireEvent.click(await screen.findByRole("button", { name: /Second brief/ }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(THREAD_B));

    // The held answer means the old file is still in memory; it must not be
    // relabelled with the session that has not answered yet.
    await panel.findByText(/Loading this bot's captured files/);
    // Nothing anywhere on the page — panel or the conversation's own Deliverables
    // card — offers the retained file under the session that has not answered.
    expect(screen.queryAllByRole("link").map((anchor) => anchor.getAttribute("href") ?? "").join(" ")).not.toContain(THREAD_B);
    expect(screen.queryByRole("link", { name: "Download reports/first.md" })).toBeNull();

    await act(async () => { release?.(); await held; });
  });
});

describe("bot thread links", () => {
  const research = { id: "cag-research", orgId: "self-hosted", slug: "research", version: 1, config: { name: "Research bot", instructions: "Write briefs.", harness: "opencode" } };
  const engineering = { id: "cag-engineering", orgId: "self-hosted", slug: "engineering", version: 1, config: { name: "Engineering bot", instructions: "Review code.", harness: "opencode" } };
  const RESEARCH_THREAD = "11111111-1111-4111-8111-111111111111";
  const ENGINEERING_THREAD = "22222222-2222-4222-8222-222222222222";
  const threads = [
    { id: RESEARCH_THREAD, name: "Competitor brief", agentName: `web:test-operator:${RESEARCH_THREAD}`, createdAt: 3, updatedAt: 3, metadata: { customAgentId: research.id } },
    { id: ENGINEERING_THREAD, name: "Flaky test triage", agentName: `web:test-operator:${ENGINEERING_THREAD}`, createdAt: 2, updatedAt: 2, metadata: { customAgentId: engineering.id } },
  ];
  function stubThreads(sessions = threads) {
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url);
      if (path === "/api/whoami") return Response.json({ agent: "test-operator", auth: "access" });
      if (path === "/api/custom-agents" && options?.method !== "POST") return Response.json({ agents: [research, engineering] });
      if (path === "/api/sessions" && options?.method === "POST") return Response.json({ status: 201, session: { id: "44444444-4444-4444-8444-444444444444", name: "Research bot", agentName: "web:test-operator:44444444-4444-4444-8444-444444444444", createdAt: 4, updatedAt: 4, metadata: { customAgentId: research.id } } });
      if (path === "/api/sessions" && options?.method !== "POST") return Response.json({ sessions, defaultSessionId: "default" });
      if (/^\/api\/sessions\/[^/]+\/resume$/.test(path)) return Response.json({ session: sessions.find((item) => path.includes(item.id)) ?? null, resumed: true });
      if (path === "/api/agents") return Response.json({ agents: [] });
      if (path === "/api/approvals") return Response.json({ approvals: [], decided: [] });
      if (path.startsWith("/api/runs")) return Response.json({ runs: [] });
      return originalFetch(url, options);
    }));
  }

  it("reopens a linked thread with its bot identity and history, keeping the link", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", `/threads/?session=${RESEARCH_THREAD}`);
    mocks.chat.messages = [{ id: "m1", role: "assistant", parts: [{ type: "text", text: "Annual report history" }] }] as never[];
    stubThreads();
    render(<App />);
    await screen.findByText("Annual report history");
    // The bot labels come from the thread registry, not the open transcript;
    // wait for that surface instead of asserting it the moment chat renders.
    expect((await screen.findAllByText("Research bot")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Competitor brief")).length).toBeGreaterThan(0);
    expect(new URLSearchParams(window.location.search).get("session")).toBe(RESEARCH_THREAD);
  });

  it("switches bots through the thread list and rewrites the link with the thread's own bot", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", `/threads/?session=${RESEARCH_THREAD}`);
    mocks.chat.messages = [];
    stubThreads();
    render(<App />);
    await openSidebarThread(/Flaky test triage/, "Engineering bot");
    await waitFor(() => expect(screen.getAllByText("Flaky test triage").length).toBeGreaterThan(1));
    const crumbs = screen.getAllByRole("navigation", { name: "Breadcrumb" }).map((nav) => nav.textContent ?? "").join(" ");
    expect(crumbs).toContain("Engineering bot");
    expect(crumbs).not.toContain("Research bot");
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(ENGINEERING_THREAD));
  });

  it("falls back to the default session when the link names a thread this viewer cannot list", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/threads/?session=33333333-3333-4333-8333-333333333333");
    mocks.chat.messages = [];
    stubThreads();
    render(<App />);
    expect(await screen.findByText(/That thread isn't available to you/)).toBeTruthy();
    await waitFor(() => expect(new URLSearchParams(window.location.search).has("session")).toBe(false));
  });

  it("records a bot thread created from the bot's own row in the address bar", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/custom-agents/");
    mocks.chat.messages = [];
    stubThreads();
    render(<App />);
    const start = await screen.findByRole("button", { name: "New thread with Research bot" }) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe("44444444-4444-4444-8444-444444444444"));
    expect(fetch).toHaveBeenCalledWith("/api/sessions", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: "Research bot", metadata: { customAgentId: research.id } }),
    }));
  });

  it("walks back and forward across bot threads, including the selector-less default session", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/threads/");
    mocks.chat.messages = [];
    stubThreads();
    render(<App />);
    await openSidebarThread(/Flaky test triage/, "Engineering bot");
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(ENGINEERING_THREAD));
    await openSidebarThread(/Competitor brief/, "Research bot");
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(RESEARCH_THREAD));

    await act(async () => { window.history.back(); });
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(ENGINEERING_THREAD));
    expect(screen.getAllByRole("navigation", { name: "Breadcrumb" }).map((nav) => nav.textContent).join(" ")).toContain("Engineering bot");

    await act(async () => { window.history.back(); });
    await waitFor(() => expect(new URLSearchParams(window.location.search).has("session")).toBe(false));
    const defaultCrumbs = screen.getAllByRole("navigation", { name: "Breadcrumb" }).map((nav) => nav.textContent).join(" ");
    expect(defaultCrumbs).not.toContain("Research bot");

    await act(async () => { window.history.forward(); });
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(ENGINEERING_THREAD));
    expect(screen.getAllByRole("navigation", { name: "Breadcrumb" }).map((nav) => nav.textContent).join(" ")).toContain("Engineering bot");
  });

  it("restores a remembered thread by replacing the entry instead of adding one", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    localStorage.setItem("shiba:selected-session", RESEARCH_THREAD);
    window.history.replaceState(null, "", "/threads/");
    mocks.chat.messages = [];
    stubThreads();
    const before = window.history.length;
    render(<App />);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(RESEARCH_THREAD));
    expect(window.history.length).toBe(before);
  });

  it("lands a ?prompt= handoff in the remembered thread's visible composer without sending", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    localStorage.setItem("shiba:selected-session", RESEARCH_THREAD);
    writeDraft(composerDraftScope("test-operator", "default"), "Default thread draft");
    window.history.replaceState(null, "", "/threads/?prompt=https%3A%2F%2Fexample.com%2Fdocs");
    mocks.chat.messages = [];
    mocks.chat.sendMessage.mockClear();
    stubThreads();
    render(<App />);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(RESEARCH_THREAD));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Runtime message" }) as HTMLTextAreaElement).value).toBe("https://example.com/docs"));
    expect(new URLSearchParams(window.location.search).has("prompt")).toBe(false);
    expect(readDraft(composerDraftScope("test-operator", RESEARCH_THREAD))).toBe("https://example.com/docs");
    expect(readDraft(composerDraftScope("test-operator", "default"))).toBe("Default thread draft");
    expect(mocks.chat.sendMessage).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.some(([url, options]) => options?.method === "POST" && /^\/api\/(?:runs|sessions|approvals)/.test(String(url)))).toBe(false);
  });

  it("adds a ?prompt= handoff below the remembered thread's unsent draft instead of replacing it", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    localStorage.setItem("shiba:selected-session", RESEARCH_THREAD);
    writeDraft(composerDraftScope("test-operator", RESEARCH_THREAD), "Unsent research notes");
    window.history.replaceState(null, "", "/threads/?prompt=https%3A%2F%2Fexample.com%2Fdocs");
    mocks.chat.messages = [];
    mocks.chat.sendMessage.mockClear();
    stubThreads();
    render(<App />);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Runtime message" }) as HTMLTextAreaElement).value).toBe("Unsent research notes\n\nhttps://example.com/docs"));
    expect(new URLSearchParams(window.location.search).get("session")).toBe(RESEARCH_THREAD);
    expect(readDraft(composerDraftScope("test-operator", RESEARCH_THREAD))).toBe("Unsent research notes\n\nhttps://example.com/docs");
    expect(mocks.chat.sendMessage).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.some(([url, options]) => options?.method === "POST" && /^\/api\/(?:runs|sessions|approvals)/.test(String(url)))).toBe(false);
  });

  it("lands the Outputs video handoff in the remembered thread without asking for suggestions", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    localStorage.setItem("shiba:selected-session", RESEARCH_THREAD);
    window.history.replaceState(null, "", `/threads/?${new URLSearchParams({ prompt: "Create a 9:16 video of " })}`);
    mocks.chat.messages = [];
    mocks.chat.sendMessage.mockClear();
    stubThreads();
    render(<App />);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(RESEARCH_THREAD));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Runtime message" }) as HTMLTextAreaElement).value).toBe("Create a 9:16 video of "));
    await act(async () => {});
    expect(mocks.chat.sendMessage).not.toHaveBeenCalled();
    const posts = vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method === "POST").map(([url]) => String(url));
    expect(posts.filter((url) => /\/api\/(runs|sessions|approvals|outputs)|chat-suggestions|video|image/.test(url))).toEqual([]);
  });

  it("replaces a dead thread link instead of leaving it in history", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/threads/?session=33333333-3333-4333-8333-333333333333");
    mocks.chat.messages = [];
    stubThreads();
    const before = window.history.length;
    render(<App />);
    await screen.findByText(/That thread isn't available to you/);
    await waitFor(() => expect(new URLSearchParams(window.location.search).has("session")).toBe(false));
    expect(window.history.length).toBe(before);
  });

  it("rewrites a dead thread reached with Back in place, leaving Forward intact", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    mocks.chat.messages = [];
    // The research thread is gone from this viewer's registry: deleted, or
    // another workspace's. The engineering thread is live.
    stubThreads(threads.filter((thread) => thread.id !== RESEARCH_THREAD));
    window.history.replaceState(null, "", "/threads/?session=" + ENGINEERING_THREAD);
    window.history.pushState(null, "", "/threads/?session=" + RESEARCH_THREAD);
    window.history.pushState(null, "", "/threads/?session=" + ENGINEERING_THREAD);
    render(<App />);
    await waitFor(() => expect(screen.getAllByRole("navigation", { name: "Breadcrumb" }).map((nav) => nav.textContent).join(" ")).toContain("Engineering bot"));

    const pushed = vi.spyOn(window.history, "pushState");
    await act(async () => { window.history.back(); });
    await screen.findByText(/That thread isn't available to you/);
    expect(new URLSearchParams(window.location.search).has("session")).toBe(false);
    expect(screen.getAllByRole("navigation", { name: "Breadcrumb" }).map((nav) => nav.textContent).join(" ")).not.toContain("Engineering bot");
    // Rewriting the dead entry in place is what preserves the Forward entry: a
    // push would spend it. (happy-dom drops the Forward stack on any replace, so
    // this asserts the write the browser honours rather than a forward() walk.)
    expect(pushed).not.toHaveBeenCalled();
    pushed.mockRestore();
  });

  it("recovers an unreadable thread selector reached with Back", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    mocks.chat.messages = [];
    stubThreads();
    window.history.replaceState(null, "", "/threads/");
    render(<App />);
    await act(async () => {});
    await act(async () => {
      window.history.pushState(null, "", "/threads/?session=not-a-thread");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await screen.findByText(/That thread isn't available to you/);
    expect(new URLSearchParams(window.location.search).has("session")).toBe(false);
  });

  it("saves successive library edits with the version the previous save returned", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", `/threads/?session=${RESEARCH_THREAD}`);
    mocks.chat.messages = [];
    const saves: { expectedVersion: number; expected: string[] }[] = [];
    let version = research.version;
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url);
      if (path === "/api/whoami") return Response.json({ agent: "test-operator", auth: "access" });
      if (path === "/api/sessions" && options?.method !== "POST") return Response.json({ sessions: threads, defaultSessionId: "default" });
      // The list keeps answering the version it was opened with, so only the
      // save's own answer can move the record forward.
      if (path === "/api/custom-agents" && options?.method !== "POST") {
        return Response.json({ agents: [research, engineering] });
      }
      if (path === `/api/custom-agents/${research.id}` && options?.method === "PATCH") {
        const body = JSON.parse(String(options.body)) as { config: { expectedDeliverables?: string[] }; expectedVersion: number };
        saves.push({ expectedVersion: body.expectedVersion, expected: body.config.expectedDeliverables ?? [] });
        version += 1;
        return Response.json({ agent: { ...research, version, config: { ...research.config, expectedDeliverables: body.config.expectedDeliverables } } });
      }
      if (path === "/api/agents") return Response.json({ agents: [] });
      if (path === "/api/approvals") return Response.json({ approvals: [], decided: [] });
      if (path.startsWith("/api/runs")) return Response.json({ runs: [] });
      return originalFetch(url, options);
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Show details panel" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Library" }));
    fireEvent.change(await screen.findByLabelText("Add a required output"), { target: { value: "brief.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(saves).toHaveLength(1));

    // The second edit runs before any list refetch: it must still send the
    // version the first save returned, or the server refuses it as stale.
    await act(async () => {});
    fireEvent.change(await screen.findByLabelText("Add a required output"), { target: { value: "summary.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[0]).toEqual({ expectedVersion: 1, expected: ["brief.md"] });
    expect(saves[1]).toEqual({ expectedVersion: 2, expected: ["brief.md", "summary.md"] });
  });

  it("leaves a shared room link intact and never attaches a private thread to it", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    const workspaceId = `ws_${"a".repeat(24)}`;
    window.history.replaceState(null, "", `/threads/?workspace=${workspaceId}&room=room_${"b".repeat(24)}`);
    mocks.chat.messages = [];
    stubThreads();
    render(<App />);
    await act(async () => {});
    const params = new URLSearchParams(window.location.search);
    expect(params.get("room")).toBe(`room_${"b".repeat(24)}`);
    expect(params.get("workspace")).toBe(workspaceId);
    expect(params.has("session")).toBe(false);
  });

  it("keeps an unconfirmed link in the address bar and opens it once the registry answers", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", `/threads/?session=${RESEARCH_THREAD}`);
    mocks.chat.messages = [];
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/sessions" && options?.method !== "POST") return pending;
      if (String(url) === "/api/custom-agents" && options?.method !== "POST") return Response.json({ agents: [research, engineering] });
      return originalFetch(url, options);
    }));
    render(<App />);
    await act(async () => {});
    // The followed link is not rewritten before the registry answers.
    expect(new URLSearchParams(window.location.search).get("session")).toBe(RESEARCH_THREAD);
    await act(async () => { finish(Response.json({ sessions: threads, defaultSessionId: "default" })); });
    await waitFor(() => expect(screen.getAllByText("Research bot").length).toBeGreaterThan(0));
    expect(new URLSearchParams(window.location.search).get("session")).toBe(RESEARCH_THREAD);
  });

  it("keeps a shared room's address when Back returns to it", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    const workspaceId = `ws_${"a".repeat(24)}`;
    const roomId = `room_${"b".repeat(24)}`;
    window.history.replaceState(null, "", `/threads/?workspace=${workspaceId}&room=${roomId}`);
    mocks.chat.messages = [];
    stubThreads();
    render(<App />);
    await act(async () => {});
    await act(async () => { window.history.pushState(null, "", "/team/"); });
    await act(async () => { window.history.back(); });
    await waitFor(() => expect(window.location.pathname).toBe("/threads/"));
    const params = new URLSearchParams(window.location.search);
    expect(params.get("room")).toBe(roomId);
    expect(params.get("workspace")).toBe(workspaceId);
  });

  it("drops the private thread selector inside a team workspace", async () => {
    const id = `ws_${"a".repeat(24)}`;
    const actor = "owner@example.com";
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    localStorage.setItem(`shiba:team-workspace:${encodeURIComponent(actor)}`, id);
    window.history.replaceState(null, "", `/threads/?session=${RESEARCH_THREAD}`);
    mocks.chat.messages = [];
    stubThreads();
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === "/api/whoami") return Response.json({ agent: actor, auth: "better-auth" });
      if (String(url) === "/api/workspaces") return Response.json({ workspaces: [{ workspaceId: id, name: "Design team", version: 1, createdAt: 1,
        membership: { workspaceId: id, userId: actor, role: "owner", version: 1, joinedAt: 1 } }] });
      return originalFetch(url, options);
    }));
    render(<App />);
    await waitFor(() => expect(new URLSearchParams(window.location.search).has("session")).toBe(false));
  });
});

describe("Work approval receipts survive refresh and Back", () => {
  const run = (runId: string, approvalId: string, summary: string) => ({ runId, task: "SAME_TEXT_TASK", status: "completed", repoUrl: "", sandboxId: "fixture-sandbox", baseBranch: "main", publishPullRequest: false, generation: 1, createdAt: 1, updatedAt: 2, summary, approval: { approvalId } });
  const decided = (approvalId: string, status: "approved" | "rejected", task: string) => ({ approvalId, threadKey: "fixture-thread", task, repoUrl: "", createdAt: 1, decidedAt: 2, kind: "run", status });
  function stub(body: { runs?: unknown[]; approvals?: unknown[]; decided?: unknown[]; decision?: unknown; approvalsDelayMs?: number; runsDelayMs?: number }) {
    const originalFetch = fetch;
    const later = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url);
      if (path === "/api/approvals" && options?.method === "POST") return Response.json(body.decision ?? { result: "unknown" });
      if (path === "/api/approvals" && !options?.method) { await later(body.approvalsDelayMs); return Response.json({ approvals: body.approvals ?? [], decided: body.decided ?? [] }); }
      if (path.startsWith("/api/runs") && !options?.method) { await later(body.runsDelayMs); return Response.json({ runs: body.runs ?? [] }); }
      return originalFetch(url, options);
    }));
  }
  const posted = () => vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method === "POST" && (options.body ? String(options.body).includes("approvalId") : false));

  it("restores an approval receipt to its exact linked run with a replaced entry and no decision POST", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/work/?view=board&task=gate-a&taskKind=approval&tab=approval");
    const entries = window.history.length;
    stub({ runs: [run("decoy-run", "gate-b", "DECOY_OUTPUT"), run("linked-run", "gate-a", "LINKED_OUTPUT")], decided: [decided("gate-a", "approved", "SAME_TEXT_TASK")] });
    render(<App />);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("task")).toBe("linked-run"));
    expect(new URLSearchParams(window.location.search).get("taskKind")).toBe("run");
    expect(window.location.pathname).toBe("/work/");
    expect(window.history.length).toBe(entries);
    const inspector = await screen.findByRole("dialog", { name: "Work inspector: SAME_TEXT_TASK" });
    fireEvent.click(within(inspector).getByRole("tab", { name: "Output" }));
    expect(await screen.findByText("LINKED_OUTPUT")).toBeTruthy();
    expect(screen.queryByText("DECOY_OUTPUT")).toBeNull();
    expect(posted()).toHaveLength(0);
  });

  it("keeps a decided approval without a run open on its server-recorded outcome", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/work/?view=board&task=gate-c&taskKind=approval&tab=approval");
    stub({ decided: [decided("gate-c", "rejected", "REJECTED_RECEIPT")] });
    render(<App />);
    const inspector = await screen.findByRole("dialog", { name: "Work inspector: REJECTED_RECEIPT" });
    expect(within(inspector).getAllByText("Rejected").length).toBeGreaterThan(1);
    expect(within(inspector).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(inspector).queryByText(/sandbox starting/)).toBeNull();
    expect(new URLSearchParams(window.location.search).get("task")).toBe("gate-c");
    expect(posted()).toHaveLength(0);
  });

  const runsAnswered = async () => {
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith("/api/runs"))).toBe(true));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  };

  it("fails closed when more than one run claims the same approval", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/work/?view=board&task=gate-d&taskKind=approval&tab=approval");
    stub({ runs: [run("first-run", "gate-d", "FIRST_OUTPUT"), run("second-run", "gate-d", "SECOND_OUTPUT")], decided: [decided("gate-d", "approved", "AMBIGUOUS_RECEIPT")] });
    render(<App />);
    expect(await screen.findByText(/more than one run/)).toBeTruthy();
    await runsAnswered();
    expect(new URLSearchParams(window.location.search).get("task")).toBe("gate-d");
    expect(new URLSearchParams(window.location.search).get("taskKind")).toBe("approval");
    expect(posted()).toHaveLength(0);
  });

  it.each([
    ["an email receipt", { ...decided("mail-1", "approved", "MAIL_RECEIPT"), kind: "email_send" }],
    ["a rejected receipt", decided("mail-1", "rejected", "MAIL_RECEIPT")],
  ])("keeps %s when a stale run names its approval id", async (_label, receipt) => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/work/?view=board&task=mail-1&taskKind=approval&tab=approval");
    stub({ runs: [{ ...run("stale-run", "mail-1", "STALE_OUTPUT"), task: "STALE_RUN" }], decided: [receipt] });
    render(<App />);
    await screen.findByRole("dialog", { name: "Work inspector: MAIL_RECEIPT" });
    await runsAnswered();
    expect(new URLSearchParams(window.location.search).get("task")).toBe("mail-1");
    expect(screen.queryByRole("dialog", { name: "Work inspector: STALE_RUN" })).toBeNull();
  });

  it.each([
    ["runs answer first", { approvalsDelayMs: 300 }],
    ["approvals answer first", { runsDelayMs: 300 }],
  ])("keeps a decided email receipt against a stale run when %s", async (_label, delays) => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/work/?view=board&task=mail-2&taskKind=approval&tab=approval");
    stub({ ...delays, runs: [{ ...run("stale-run", "mail-2", "STALE_OUTPUT"), task: "STALE_RUN" }], decided: [{ ...decided("mail-2", "approved", "MAIL_RECEIPT_2"), kind: "email_send" }] });
    render(<App />);
    await screen.findByRole("dialog", { name: "Work inspector: MAIL_RECEIPT_2" }, { timeout: 3000 });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(new URLSearchParams(window.location.search).get("task")).toBe("mail-2");
    expect(screen.queryByRole("dialog", { name: "Work inspector: STALE_RUN" })).toBeNull();
  });

  it("keeps the receipt URL and the ambiguity notice when no receipt is listed", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/work/?view=board&task=gate-g&taskKind=approval&tab=approval");
    stub({ runs: [run("first-run", "gate-g", "FIRST_OUTPUT"), run("second-run", "gate-g", "SECOND_OUTPUT")] });
    render(<App />);
    expect(await screen.findByText(/more than one run/)).toBeTruthy();
    await runsAnswered();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    expect(new URLSearchParams(window.location.search).get("task")).toBe("gate-g");
    expect(screen.queryByText(/isn't available in this workspace/)).toBeNull();
    expect(screen.getByText(/more than one run/)).toBeTruthy();
  });

  it("resolves an already-loaded linked run when Back or Forward restores a receipt inside Work", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/work/?view=board&task=gate-e&taskKind=approval&tab=approval");
    stub({ runs: [run("run-f", "gate-f", "RUN_F_OUTPUT")], decided: [decided("gate-e", "rejected", "RECEIPT_E"), decided("gate-f", "approved", "SAME_TEXT_TASK")] });
    render(<App />);
    await screen.findByRole("dialog", { name: "Work inspector: RECEIPT_E" });
    await runsAnswered();
    const answered = vi.mocked(fetch).mock.calls.length;
    await act(async () => {
      window.history.pushState(null, "", "/work/?view=board&task=gate-f&taskKind=approval&tab=approval");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("task")).toBe("run-f"));
    expect(vi.mocked(fetch).mock.calls.slice(answered).some(([url]) => String(url).startsWith("/api/runs"))).toBe(false);
    expect(posted()).toHaveLength(0);
  });

  it("shows a queued decision as queued on the Work receipt", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/work/?view=board&task=gate-q&taskKind=approval&tab=approval");
    stub({ approvals: [{ approvalId: "gate-q", threadKey: "fixture-thread", task: "QUEUED_RECEIPT", repoUrl: "https://github.com/fixture/repo", createdAt: 1, kind: "run", status: "pending" }], decision: { result: "queued", code: "repo_claim_queued" } });
    render(<App />);
    const inspector = await screen.findByRole("dialog", { name: "Work inspector: QUEUED_RECEIPT" });
    fireEvent.click(within(inspector).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(await within(inspector).findByText(/queued behind another run/)).toBeTruthy();
    expect(within(inspector).queryByText(/sandbox starting/)).toBeNull();
  });

  it("replaces an unknown receipt link without leaking a title or adding history", async () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    window.history.replaceState(null, "", "/work/?view=board&task=ghost-gate&taskKind=approval&tab=approval");
    const entries = window.history.length;
    stub({ runs: [run("other-run", "other-gate", "OTHER_OUTPUT")] });
    render(<App />);
    await waitFor(() => expect(new URLSearchParams(window.location.search).has("task")).toBe(false));
    expect(new URLSearchParams(window.location.search).get("view")).toBe("board");
    expect(window.history.length).toBe(entries);
    expect(await screen.findByText(/That item isn't available in this workspace/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posted()).toHaveLength(0);
  });
});
