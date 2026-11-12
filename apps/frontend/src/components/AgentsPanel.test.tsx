// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebThread } from "../agent-threads";
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

    expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Search agents" })).toBeTruthy();
    const newBtn = screen.getByRole("button", { name: "New agent" });
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
    expect(document.querySelector('img[src^="/assets/mascot/shiba-sticker-"]')).toBeTruthy();
    expect(screen.getAllByText("Alice · You").length).toBeGreaterThan(0);

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

    expect(screen.getAllByText("Acme Corp · Workspace").length).toBeGreaterThan(0);
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
          ...mockThreads,
          { id: "loose", name: "Quick question", agentName: "web:user:4", updatedAt: 400 },
        ]}
      />,
    );

    const group = screen.getByRole("group", { name: "Shiba threads" });
    expect(group.textContent).toContain("Quick question");
    expect(group.textContent).toContain("Default session");
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
    expect(localStorage.getItem("shiba.agents.pinned")).toBe(JSON.stringify(["agent-2"]));
    localStorage.removeItem("shiba.agents.pinned");
  });

  it("shows a hire empty state that opens the catalog when there are no custom agents", () => {
    const onOpenCatalog = vi.fn();
    render(
      <AgentsPanel
        scope="personal"
        onScopeChange={vi.fn()}
        active=""
        onSelect={vi.fn()}
        onOpenCatalog={onOpenCatalog}
      />,
    );

    expect(screen.getByText("Shiba")).toBeTruthy();
    expect(screen.queryByText("No agents yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hire your first teammate" }));
    expect(onOpenCatalog).toHaveBeenCalledOnce();
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

    fireEvent.click(screen.getByRole("button", { name: "Search agents" }));
    const input = screen.getByPlaceholderText("Search agents…");
    fireEvent.change(input, { target: { value: "Lead" } });

    expect(screen.getByText("Engineering Lead")).toBeTruthy();
    expect(screen.queryByText("Research Partner")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close search" }));
    expect(screen.getByText("Research Partner")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Search agents" }));
    fireEvent.change(screen.getByPlaceholderText("Search agents…"), { target: { value: "zzz" } });
    expect(screen.getByText("No matching agents")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Hire your first teammate" })).toBeNull();
  });
});
