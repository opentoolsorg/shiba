// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentConversationEmpty, AgentDetailsPanel, AgentPageHeader, AgentSidebar, EmployeeOnboarding, createEmployeeAgent, employeeExamples } from "./AgentExperience";
import type { CustomAgentWire } from "./CustomAgentsView";
import { EMPLOYEE_TEMPLATES } from "../employee-templates";

const research = EMPLOYEE_TEMPLATES.find((template) => template.id === "research")!;
const agent: CustomAgentWire = { id: "research-1", slug: research.slug, version: 1, config: { ...research.config, harness: "opencode" } };
const threads = [
  { id: "bound", name: "Competitor brief", agentName: "chat-1", updatedAt: 1, metadata: { customAgentId: agent.id } },
  { id: "legacy", name: "Existing conversation", agentName: "chat-2", updatedAt: 2 },
];
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("agent sidebar", () => {
  it("expands and collapses agent threads and starts a fresh thread with the plus action", () => {
    const onNewThread = vi.fn();
    const onOpenThread = vi.fn();
    render(<AgentSidebar agents={[agent]} threads={threads} selectedId="bound" onNewThread={onNewThread} onOpenThread={onOpenThread} onManage={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Competitor brief" })).toBeNull();
    const expand = screen.getByRole("button", { name: "Expand Research bot threads" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(expand);
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Competitor brief" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByRole("button", { name: "Competitor brief" }));
    expect(onOpenThread).toHaveBeenCalledWith("bound");
    fireEvent.click(screen.getByRole("button", { name: "New thread with Research bot" }));
    expect(onNewThread).toHaveBeenCalledWith(agent);
    fireEvent.click(expand);
    expect(screen.queryByRole("button", { name: "Competitor brief" })).toBeNull();
    expect(screen.getByRole("button", { name: "Existing conversation" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New thread with Shiba" }));
    expect(onNewThread).toHaveBeenCalledWith(undefined);
  });
});

describe("agent conversation", () => {
  it("starts a shared conversation only after a click, without transferring private participants or history", () => {
    const share = vi.fn();
    render(<AgentPageHeader name="Research bot" detailsOpen={false} onToggleDetails={vi.fn()} onShareWithTeam={share} />);
    expect(share).not.toHaveBeenCalled();
    expect(screen.getByText(/Your private history is not automatically included/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Participants" }).textContent).toContain("You and agent");
    fireEvent.click(screen.getByRole("button", { name: "Start shared conversation" }));
    expect(share).toHaveBeenCalledWith(); expect(share).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Participants" }));
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getAllByText("Research bot").length).toBeGreaterThan(0);
    expect(screen.queryByText("Team members")).toBeNull();
  });
  it("hides team sharing if no shared-conversation capability is supplied", () => {
    render(<AgentPageHeader name="Shiba" detailsOpen={false} onToggleDetails={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Start shared conversation" })).toBeNull();
  });
  it("uses the built-in SVG Shiba for the built-in profile, not a custom employee label", () => {
    const { container } = render(<AgentDetailsPanel onClose={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText("Shiba · Runs on workspace default")).toBeTruthy();
    expect(container.querySelector("svg.shiba-agent-mascot")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-employee-role="custom"]')).toBeNull();
  });

  it("shows actual saved instructions even when the slug matches a role template", () => {
    const instructions = "Only review my supplied evidence; do not research competitors.";
    render(<AgentDetailsPanel agent={{ ...agent, config: { ...agent.config, instructions } }} onClose={vi.fn()} onEdit={vi.fn()} />);
    const panel = screen.getByRole("complementary", { name: "Agent details" });
    expect(panel.querySelector(".line-clamp-4")?.textContent).toBe(instructions);
    expect(within(screen.getByRole("region", { name: "Agent information" })).getAllByText(instructions).length).toBeGreaterThan(0);
    expect(screen.queryByText(research.description)).toBeNull();
  });

  it("keeps renamed role identities consistent across sidebar, header, details and empty state", () => {
    const renamed = { ...agent, slug: "evidence-partner", config: { ...agent.config, name: "Evidence partner", harness: "codex" } };
    const { container } = render(<>
      <AgentSidebar agents={[renamed]} threads={threads} onOpenThread={vi.fn()} onNewThread={vi.fn()} onManage={vi.fn()} />
      <AgentPageHeader name={renamed.config.name} slug={renamed.slug} role={renamed.config.roleTemplateId} detailsOpen onToggleDetails={vi.fn()} />
      <AgentDetailsPanel agent={renamed} onClose={vi.fn()} onEdit={vi.fn()} />
      <AgentConversationEmpty name={renamed.config.name} slug={renamed.slug} role={renamed.config.roleTemplateId} onPrefill={vi.fn()} />
    </>);
    expect(container.querySelectorAll('[data-employee-role="research"]')).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Evidence partner" })).toBeTruthy();
    expect(screen.getByText("Research · Runs on codex")).toBeTruthy();
    expect(renamed.config.name).toBe("Evidence partner");
    expect(employeeExamples(renamed)).toEqual(employeeExamples(agent));
  });

  it("closes participants on Escape and outside pointer activation", () => {
    render(<AgentPageHeader name="Shiba" detailsOpen={false} onToggleDetails={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Participants" });
    fireEvent.click(trigger);
    expect(screen.getByText("You")).toBeTruthy();
    expect(trigger.textContent).toContain("You and agent");
    expect(trigger.textContent).not.toContain("2");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("You")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByText("You")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it.each([800, 1440])("reveals narrow in-flow details without animation, leaving desktop scroll unchanged at %s px", (width) => {
    const originalWidth = window.innerWidth;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    const scroll = vi.fn();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    try {
      render(<AgentDetailsPanel agent={agent} onClose={vi.fn()} onEdit={vi.fn()} />);
      if (width < 1280) expect(scroll).toHaveBeenCalledWith({ block: "nearest", behavior: "instant" });
      else expect(scroll).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
      if (descriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it("shows the breadcrumb, actual participants, details toggle and empty conversation with prefill-only examples", () => {
    const onPrefill = vi.fn();
    const toggle = vi.fn();
    render(<><AgentPageHeader name={agent.config.name} detailsOpen={false} onToggleDetails={toggle} /><AgentConversationEmpty name={agent.config.name} examples={employeeExamples(agent)} onPrefill={onPrefill} /></>);
    expect(screen.getByText("Personal")).toBeTruthy();
    expect(screen.getByText("Agents")).toBeTruthy();
    expect(screen.getByText(/This is the beginning of your conversation/)).toBeTruthy();
    expect(screen.getByText(/Planning can start now. Every sandbox execution requires human approval/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Participants" }));
    expect(screen.getByText("You")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Toggle agent details" }));
    expect(toggle).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Research my top three competitors and write a one-page brief" }));
    expect(onPrefill).toHaveBeenCalledWith("Research my top three competitors and write a one-page brief");
  });

  it("shows saved configuration with Details, Library, and Computer tabs", () => {
    const onClose = vi.fn();
    render(
      <AgentDetailsPanel
        agent={{
          ...agent,
          config: {
            ...agent.config,
            expectedDeliverables: ["research/report.md"],
            sandboxProvider: "docker-local",
          },
        }}
        onClose={onClose}
        onEdit={vi.fn()}
      />
    );
    const panel = screen.getByRole("complementary", { name: "Agent details" });
    expect(panel.className).not.toContain("absolute");
    expect(panel.className).toContain("w-full");
    expect(panel.className).toContain("xl:w-[370px]");
    const details = screen.getByRole("region", { name: "Agent information" });
    for (const label of ["Model", "Instructions", "Tools", "Advanced"]) expect(within(details).getByText(label)).toBeTruthy();
    expect(within(details).getAllByText("Workspace default").length).toBeGreaterThan(0);
    expect(details.textContent).toContain(agent.config.instructions);
    expect(screen.getByRole("tablist", { name: "Agent details tabs" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Details" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Library" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Computer" })).toBeTruthy();
    expect(screen.getByText("Research · Runs on opencode")).toBeTruthy();
    expect(panel.querySelector('[data-employee-role="research"]')).toBeTruthy();

    // Check switching to Library tab
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    expect(screen.getByText("research/report.md")).toBeTruthy();

    // Check switching to Computer tab
    fireEvent.click(screen.getByRole("tab", { name: "Computer" }));
    expect(screen.getByText(/Sandbox: docker-local/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close agent details" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows empty library and computer states when not configured", () => {
    const emptyAgent: CustomAgentWire = {
      ...agent,
      config: {
        ...agent.config,
        expectedDeliverables: [],
        sandboxProvider: undefined,
      },
    };
    render(<AgentDetailsPanel agent={emptyAgent} onClose={vi.fn()} onEdit={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    expect(screen.getByText("No files yet")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Computer" }));
    expect(screen.getByText("No computer")).toBeTruthy();
  });
});

describe("employee onboarding", () => {
  it("forwards only an explicit team selector when creating the selected role", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ agent })); vi.stubGlobal("fetch", fetcher);
    const workspaceId = `ws_${"a".repeat(24)}`;
    await createEmployeeAgent(research, workspaceId);
    expect(fetcher).toHaveBeenCalledWith("/api/custom-agents", expect.objectContaining({ credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Shiba-Workspace": workspaceId } }));
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body)).toEqual({ slug: research.slug, config: { ...research.config, harness: "opencode", approvalPolicy: "standard" } });
  });
  it("renders all ten optional roles and skips without creating anything", () => {
    const onSkip = vi.fn();
    const onSelect = vi.fn();
    render(<EmployeeOnboarding onSelect={onSelect} onSkip={onSkip} />);
    expect(screen.getByRole("heading", { name: "Set up your AI employees" })).toBeTruthy();
    for (const template of EMPLOYEE_TEMPLATES) {
      const button = screen.getByRole("button", { name: new RegExp(template.label) });
      expect(button.querySelector(`[data-employee-role="${template.id}"]`)).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkip).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each(EMPLOYEE_TEMPLATES.filter((template) => ["gtm", "hr", "finance"].includes(template.id)))("creates $label only when selected and grants no tools or connections", async (template) => {
    const saved = { id: template.id, slug: `my-${template.id}`, version: 1, config: { ...template.config, harness: "opencode" } };
    const request = vi.fn().mockResolvedValue(Response.json({ agent: saved }, { status: 201 }));
    vi.stubGlobal("fetch", request);
    render(<EmployeeOnboarding onSelect={async (choice) => { await createEmployeeAgent(choice); }} onSkip={vi.fn()} />);
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${template.label}`) }));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
    expect(body.config).toEqual({ ...template.config, harness: "opencode", approvalPolicy: "standard" });
    expect(body.config).not.toHaveProperty("connectionId");
    expect(body.config).not.toHaveProperty("toolScopes");
  });

  it("creates a real custom agent with the existing API payload and role instructions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ agent }));
    vi.stubGlobal("fetch", fetchMock);
    const onSelect = vi.fn(async (template) => { await createEmployeeAgent(template); });
    render(<EmployeeOnboarding onSelect={onSelect} onSkip={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Research/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(onSelect).toHaveBeenCalledWith(research);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/custom-agents");
    expect(JSON.parse(options.body)).toEqual({ slug: research.slug, config: { ...research.config, harness: "opencode", approvalPolicy: "standard" } });
  });

  it("keeps the choice available and reports creation failures", async () => {
    render(<EmployeeOnboarding onSelect={vi.fn().mockRejectedValue(new Error("Backend unavailable"))} onSkip={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Sales/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("Backend unavailable");
    await waitFor(() => expect((screen.getByRole("button", { name: /Sales/ }) as HTMLButtonElement).disabled).toBe(false));
  });
});
