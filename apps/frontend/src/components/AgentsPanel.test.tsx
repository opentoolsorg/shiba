// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { threadAgentId, type WebThread } from "../agent-threads";
import { AgentsPanel } from "./AgentsPanel";
import type { CustomAgentWire } from "./CustomAgentsView";

afterEach(() => {
  cleanup();
});

const mockAgents: CustomAgentWire[] = [
  {
    id: "agent-1",
    slug: "researcher",
    version: 1,
    config: {
      name: "Research Partner",
      instructions: "Find evidence and cite sources.",
      harness: "opencode",
      roleTemplateId: "research",
    },
  },
  {
    id: "agent-2",
    slug: "coder",
    version: 1,
    config: {
      name: "Engineering Lead",
      emoji: "💻",
      instructions: "Review code and write tests.",
      harness: "opencode",
    },
  },
];

const mockThreads: WebThread[] = [
  {
    id: "thread-1",
    name: "Competitor analysis",
    agentName: "web:user:1",
    updatedAt: 100,
    metadata: { customAgentId: "agent-1" },
  },
  {
    id: "thread-2",
    name: "Tech debt review",
    agentName: "web:user:2",
    updatedAt: 200,
    metadata: { customAgentId: "agent-2" },
  },
  {
    id: "thread-3",
    name: "Literature review",
    agentName: "web:user:3",
    updatedAt: 300,
    metadata: { customAgentId: "agent-1" },
  },
];

describe("AgentsPanel", () => {
  it("renders panel title and actions without duplicating the app-wide workspace picker", () => {
    const onScopeChange = vi.fn();
    const onNewAgent = vi.fn();
    render(
      <AgentsPanel
        scope="personal"
        onScopeChange={onScopeChange}
        active="agent-1"
        onSelect={vi.fn()}
        onNewAgent={onNewAgent}
        agents={mockAgents}
        threads={mockThreads}
      />,
    );

    expect(screen.getByRole("heading", { name: "Employees" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Search employees" })).toBeTruthy();
    const newBtn = screen.getByRole("button", { name: "Hire employee" });
    expect(newBtn).toBeTruthy();
    fireEvent.click(newBtn);
    expect(onNewAgent).toHaveBeenCalledOnce();

    expect(screen.queryByRole("button", { name: "Personal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Workspace" })).toBeNull();
    expect(onScopeChange).not.toHaveBeenCalled();
  });

  it("renders real custom agents with owner or workspace subtitles", () => {
    const { rerender } = render(
      <AgentsPanel
        scope="personal"
        onScopeChange={vi.fn()}
        active="agent-1"
        onSelect={vi.fn()}
        ownerName="Alice"
        agents={mockAgents}
        threads={mockThreads}
      />,
    );

    expect(screen.getByText("Research Partner")).toBeTruthy();
    expect(screen.getByText("Engineering Lead")).toBeTruthy();
    expect(document.querySelector(".shiba-agent-mascot")).toBeTruthy();
    expect(screen.getAllByText("Alice · Personal chief of staff").length).toBeGreaterThan(0);

    rerender(
      <AgentsPanel
        scope="workspace"
        onScopeChange={vi.fn()}
        active="agent-1"
        onSelect={vi.fn()}
        workspaceName="Acme Corp"
        agents={mockAgents}
        threads={mockThreads}
      />,
    );

    expect(screen.getAllByText("Acme Corp · Workspace chief of staff").length).toBeGreaterThan(0);
  });

  it("selects agent and triggers onNewThread with hover plus action", () => {
    const onSelectAgent = vi.fn();
    const onSelect = vi.fn();
    const onNewThread = vi.fn();

    render(
      <AgentsPanel
        scope="personal"
        onScopeChange={vi.fn()}
        active=""
        onSelect={onSelect}
        onSelectAgent={onSelectAgent}
        onNewThread={onNewThread}
        agents={mockAgents}
        threads={mockThreads}
      />,
    );

    fireEvent.click(screen.getByText("Research Partner"));
    expect(onSelectAgent).toHaveBeenCalledWith("agent-1");
    expect(onSelect).toHaveBeenCalledWith("agent-1");

    const plusBtn = screen.getByRole("button", { name: "New thread with Research Partner" });
    fireEvent.click(plusBtn);
    expect(onNewThread).toHaveBeenCalledWith("agent-1");
  });

  it("opens each bot's own page and panel when a host supplies the bot entry point", () => {
    const onOpenAgent = vi.fn();
    const onSelectAgent = vi.fn();
    render(
      <AgentsPanel
        scope="personal"
        onScopeChange={vi.fn()}
        active=""
        onSelect={vi.fn()}
        onSelectAgent={onSelectAgent}
        onOpenAgent={onOpenAgent}
        onNewThread={vi.fn()}
        agents={mockAgents}
        threads={mockThreads}
      />,
    );
    fireEvent.click(screen.getByText("Research Partner"));
    fireEvent.click(screen.getByText("Engineering Lead"));
    expect(onOpenAgent.mock.calls).toEqual([["agent-1"], ["agent-2"]]);
    // The roster hand-off must not also fire, or one click would do two things.
    expect(onSelectAgent).not.toHaveBeenCalled();
  });

  it("keeps the workspace hand-off when no bot entry point is supplied", () => {
    const onSelectAgent = vi.fn();
    render(
      <AgentsPanel
        scope="personal"
        onScopeChange={vi.fn()}
        active=""
        onSelect={vi.fn()}
        onSelectAgent={onSelectAgent}
        agents={mockAgents}
        threads={mockThreads}
      />,
    );
    fireEvent.click(screen.getByText("Research Partner"));
    expect(onSelectAgent).toHaveBeenCalledWith("agent-1");
  });

  it("shows thread matches when searching by employee role or thread title", () => {
    render(
      <AgentsPanel
        scope="personal"
        onScopeChange={vi.fn()}
        active=""
        onSelect={vi.fn()}
        agents={mockAgents}
        threads={mockThreads}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Search employees" }));
    const search = screen.getByPlaceholderText("Search employees…");
    fireEvent.change(search, { target: { value: "Research" } });
    expect(screen.getByText("Literature review")).toBeTruthy();
    expect(screen.getByText("Competitor analysis")).toBeTruthy();
    expect(screen.queryByText("Tech debt review")).toBeNull();

    fireEvent.change(search, { target: { value: "Tech debt" } });
    expect(screen.getByText("Tech debt review")).toBeTruthy();
    expect(screen.queryByText("Literature review")).toBeNull();
  });

  it("keeps the selected older run available and sorts recent runs by update time", () => {
    const onSelectRun = vi.fn();
    const runs = Array.from({ length: 10 }, (_, index) => ({
      id: `run-${index}`,
      title: index === 0 ? "Older selected run" : `Run ${index}`,
      repoName: "shiba",
      status: "completed",
      updatedAt: index,
    }));
    render(
      <AgentsPanel
        scope="personal"
        onScopeChange={vi.fn()}
        active="run-0"
        onSelect={vi.fn()}
        onSelectRun={onSelectRun}
        runs={runs}
        agents={mockAgents}
        threads={mockThreads}
      />,
    );
    const recent = screen.getByRole("region", { name: "Recent runs" });
    const titles = [...recent.querySelectorAll("button:not([aria-expanded])")].map((button) => button.textContent ?? "");
    expect(titles).toHaveLength(10);
    expect(titles[0]).toContain("Run 9");
    expect(titles[9]).toContain("Older selected run");
    fireEvent.click(screen.getByRole("button", { name: /Older selected run/ }));
    expect(onSelectRun).toHaveBeenCalledWith("run-0");
  });

  it("expands agent threads and selects a thread", () => {
    const onSelectThread = vi.fn();
    const onSelect = vi.fn();

    render(
      <AgentsPanel
        scope="personal"
        onScopeChange={vi.fn()}
        active=""
        onSelect={onSelect}
        onSelectThread={onSelectThread}
        agents={mockAgents}
        threads={mockThreads}
      />,
    );

    expect(screen.queryByText("Competitor analysis")).toBeNull();
    const expandBtn = screen.getByRole("button", { name: "Expand Research Partner" });
    expect(expandBtn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(expandBtn);
    expect(expandBtn.getAttribute("aria-expanded")).toBe("true");

    const group = screen.getByRole("group", { name: "Research Partner threads" });
    const buttons = group.querySelectorAll("button");
    expect(buttons[0]?.textContent).toContain("Literature review");
    expect(buttons[1]?.textContent).toContain("Competitor analysis");
    expect(screen.queryByText("Tech debt review")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Competitor analysis/ }));
    expect(onSelectThread).toHaveBeenCalledWith("thread-1");
    expect(onSelect).toHaveBeenCalledWith("thread-1");

    fireEvent.click(screen.getByRole("button", { name: "Collapse Research Partner" }));
    expect(screen.queryByText("Competitor analysis")).toBeNull();
  });

  it("shows a loading state instead of an empty Shiba thread while sessions load", () => {
    render(
      <AgentsPanel
        scope="personal"
        onScopeChange={vi.fn()}
        active="default"
        onSelect={vi.fn()}
        threadsLoading
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Loading threads");
    expect(screen.queryByRole("group", { name: "Shiba threads" })).toBeNull();
  });

  it("always lists the default agent with the default session and unbound threads", () => {
    const onSelectThread = vi.fn();
    const onNewThread = vi.fn();
    render(
      <AgentsPanel
        scope="personal"
        onScopeChange={vi.fn()}
        active=""
        onSelect={vi.fn()}
        onSelectThread={onSelectThread}
        onNewThread={onNewThread}
        agents={mockAgents}
        threads={[
          ...mockThreads.filter((thread) => threadAgentId(thread) !== "agent-2"),
          { id: "loose", name: "Quick question", agentName: "web:user:4", updatedAt: 400 },
        ]}
        unavailableThreads={mockThreads.filter((thread) => threadAgentId(thread) === "agent-2")}
      />,
    );

    const group = screen.getByRole("group", { name: "Shiba threads" });
    expect(group.textContent).toContain("Default session");
    expect(group.textContent).toContain("Quick question");
    expect(group.textContent).not.toContain("Competitor analysis");

    fireEvent.click(screen.getByText("Shiba"));
    expect(onSelectThread).toHaveBeenCalledWith("loose");
    fireEvent.click(screen.getByRole("button", { name: "New thread with Shiba" }));
    expect(onNewThread).toHaveBeenCalledWith(undefined);
  });

  it("shows role and provider subtitles and live thread status", () => {
    render(
      <AgentsPanel
        scope="personal"
        onScopeChange={vi.fn()}
        active="thread-3"
        onSelect={vi.fn()}
        agents={mockAgents}
        threads={mockThreads}
        threadStates={{ "thread-3": "working" }}
      />,
    );

    expect(screen.getByText("Research · opencode")).toBeTruthy();
    expect(screen.getByText("Custom · opencode")).toBeTruthy();
    // The row holding the active thread opens on its own.
    expect(screen.getByRole("button", { name: "Collapse Research Partner" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Literature review/ }).textContent).toContain(
      "Working",
    );
    expect(screen.getAllByRole("img", { name: "working" }).length).toBe(1);
  });

  it("pins an agent to the top of the list and remembers it", () => {
    localStorage.removeItem("shiba.agents.pinned");
    render(
      <AgentsPanel
        scope="personal"
        onScopeChange={vi.fn()}
        active=""
        onSelect={vi.fn()}
        agents={mockAgents}
      />,
    );

    const names = () => screen.getAllByRole("listitem").map((item) => item.textContent ?? "");
    expect(names()[1]).toContain("Research Partner");
    const pin = screen.getByRole("button", { name: "Pin Engineering Lead" });
    fireEvent.click(pin);
    expect(
      screen.getByRole("button", { name: "Unpin Engineering Lead" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(names()[1]).toContain("Engineering Lead");
    expect(screen.getByRole("heading", { name: "Pinned" })).toBeTruthy();
    expect(localStorage.getItem("shiba.agents.pinned")).toBe(JSON.stringify(["agent-2"]));
    localStorage.removeItem("shiba.agents.pinned");
  });

  it("always includes the built-in Shiba employee", () => {
    render(<AgentsPanel scope="personal" onScopeChange={vi.fn()} active="" onSelect={vi.fn()} />);
    expect(screen.getByText("Shiba")).toBeTruthy();
    expect(screen.queryByText("No agents yet")).toBeNull();
    expect(screen.queryByRole("button", { name: "Hire your first teammate" })).toBeNull();
  });

  it("renders panel navigation items for Tool policy, Swarm, and Tasks", () => {
    const onSelect = vi.fn();
    render(
      <AgentsPanel
        scope="personal"
        onScopeChange={vi.fn()}
        active="employee-tools"
        onSelect={onSelect}
        agents={mockAgents}
      />,
    );

    const toolsBtn = screen.getByRole("button", { name: /Tool policy/ });
    const swarmBtn = screen.getByRole("button", { name: /Swarm/ });
    const tasksBtn = screen.getByRole("button", { name: /Tasks/ });

    expect(toolsBtn.getAttribute("aria-current")).toBe("page");
    expect(swarmBtn.getAttribute("aria-current")).toBeNull();
    expect(tasksBtn.getAttribute("aria-current")).toBeNull();

    fireEvent.click(swarmBtn);
    expect(onSelect).toHaveBeenCalledWith("swarm");

    fireEvent.click(tasksBtn);
    expect(onSelect).toHaveBeenCalledWith("tasks");
  });

  it("filters agents using the search input", () => {
    render(
      <AgentsPanel
        scope="personal"
        onScopeChange={vi.fn()}
        active=""
        onSelect={vi.fn()}
        agents={mockAgents}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Search employees" }));
    const input = screen.getByPlaceholderText("Search employees…");
    fireEvent.change(input, { target: { value: "Lead" } });

    expect(screen.getByText("Engineering Lead")).toBeTruthy();
    expect(screen.queryByText("Research Partner")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close search" }));
    expect(screen.getByText("Research Partner")).toBeTruthy();
  });

  it("groups archived employee threads without a Shiba new-thread action", () => {
    const onSelectThread = vi.fn();
    render(
      <AgentsPanel
        scope="personal"
        onScopeChange={vi.fn()}
        active=""
        onSelect={onSelectThread}
        onSelectThread={onSelectThread}
        agents={mockAgents}
        threads={[]}
        unavailableThreads={[{ id: "orphan", name: "Archived employee thread", agentName: "web:user:orphan", updatedAt: 500, metadata: { customAgentId: "archived-agent" } }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand Unavailable employee" }));
    const orphanGroup = screen.getByRole("group", { name: "Unavailable employee threads" });
    expect(orphanGroup.textContent).toContain("Archived employee thread");
    expect(screen.queryByRole("button", { name: "New thread with Unavailable employee" })).toBeNull();
    expect(screen.getByRole("group", { name: "Shiba threads" }).textContent).not.toContain("Archived employee thread");
    fireEvent.click(screen.getByRole("button", { name: /Archived employee thread/ }));
    expect(onSelectThread).toHaveBeenCalledWith("orphan");
  });

  it("reports no matches when the search excludes every agent", () => {
    render(
      <AgentsPanel
        scope="personal"
        onScopeChange={vi.fn()}
        active=""
        onSelect={vi.fn()}
        agents={mockAgents}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Search employees" }));
    fireEvent.change(screen.getByPlaceholderText("Search employees…"), { target: { value: "zzz" } });
    expect(screen.getByText("No matching employees")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Hire your first teammate" })).toBeNull();
  });
});
