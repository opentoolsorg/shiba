// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsPanel } from "./AgentsPanel";
import type { CustomAgentWire } from "./CustomAgentsView";
import type { WebThread } from "../agent-threads";

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
  it("renders panel title, search and new agent action buttons, and scope switch", () => {
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
      />
    );

    expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Search agents" })).toBeTruthy();
    const newBtn = screen.getByRole("button", { name: "New agent" });
    expect(newBtn).toBeTruthy();
    fireEvent.click(newBtn);
    expect(onNewAgent).toHaveBeenCalledOnce();

    const personalTab = screen.getByRole("button", { name: "Personal" });
    const workspaceTab = screen.getByRole("button", { name: "Workspace" });
    expect(personalTab.getAttribute("aria-pressed")).toBe("true");
    expect(workspaceTab.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(workspaceTab);
    expect(onScopeChange).toHaveBeenCalledWith("workspace");
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
      />
    );

    expect(screen.getByText("Research Partner")).toBeTruthy();
    expect(screen.getByText("Engineering Lead")).toBeTruthy();
    expect(screen.getByText("💻")).toBeTruthy();
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
      />
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
      />
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
      />
    );

    expect(screen.queryByText("Competitor analysis")).toBeNull();
    const expandBtn = screen.getByRole("button", { name: "Expand Research Partner" });
    expect(expandBtn.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(expandBtn);
    expect(expandBtn.getAttribute("aria-expanded")).toBe("true");

    const thread1 = screen.getByRole("button", { name: /Competitor analysis/ });
    const thread3 = screen.getByRole("button", { name: /Literature review/ });
    expect(thread1).toBeTruthy();
    expect(thread3).toBeTruthy();
    expect(screen.queryByText("Tech debt review")).toBeNull();

    fireEvent.click(thread1);
    expect(onSelectThread).toHaveBeenCalledWith("thread-1");
    expect(onSelect).toHaveBeenCalledWith("thread-1");

    fireEvent.click(screen.getByRole("button", { name: "Collapse Research Partner" }));
    expect(screen.queryByText("Competitor analysis")).toBeNull();
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
      />
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
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Search agents" }));
    const input = screen.getByPlaceholderText("Search agents…");
    fireEvent.change(input, { target: { value: "Lead" } });

    expect(screen.getByText("Engineering Lead")).toBeTruthy();
    expect(screen.queryByText("Research Partner")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close search" }));
    expect(screen.getByText("Research Partner")).toBeTruthy();
  });
});
