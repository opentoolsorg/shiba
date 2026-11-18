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

describe("agent sidebar entry point", () => {
  it("opens the bot's own page and panel when a host supplies the bot entry point", () => {
    const onOpenAgent = vi.fn();
    render(<AgentSidebar agents={[agent]} threads={threads} selectedId="bound" onOpenThread={vi.fn()} onNewThread={vi.fn()} onManage={vi.fn()} onOpenAgent={onOpenAgent} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Research bot/ })[0]!);
    expect(onOpenAgent).toHaveBeenCalledWith(agent);
  });

  it("falls back to the bot's newest thread when no bot entry point is supplied", () => {
    const onOpenThread = vi.fn();
    render(<AgentSidebar agents={[agent]} threads={threads} selectedId="bound" onOpenThread={onOpenThread} onNewThread={vi.fn()} onManage={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Research bot/ })[0]!);
    expect(onOpenThread).toHaveBeenCalledWith("bound");
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
    expect(screen.getByText("Cloud sandbox")).toBeTruthy();
    expect(screen.getByText("docker-local")).toBeTruthy();

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
    expect(screen.getByText("No required outputs yet.")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Computer" }));
    // An unset override is not a missing choice: the deployment resolves one.
    const panel = within(screen.getByRole("tabpanel", { name: "Computer" }));
    expect(panel.getByText("opencode")).toBeTruthy();
    expect(panel.getByText("Deployment default")).toBeTruthy();
    expect(panel.getByText(/runs in the deployment's sandbox/)).toBeTruthy();
    expect(panel.queryByText(/needs one selected|Not configured/)).toBeNull();
    expect(panel.getByText("None paired")).toBeTruthy();
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

describe("bot profile tabs", () => {
  const libraryAgent: CustomAgentWire = {
    ...agent,
    version: 3,
    config: { ...agent.config, expectedDeliverables: ["brief.md", "sources.json"] },
  };

  it("attaches a required output and saves it through the bot's profile", async () => {
    const save = vi.fn(async () => {});
    render(<AgentDetailsPanel agent={{ ...agent, config: { ...agent.config, expectedDeliverables: undefined } }} onClose={vi.fn()} onEdit={vi.fn()} onLibrarySave={save} />);
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    expect(screen.getByText("No required outputs yet.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Add a required output"), { target: { value: "brief.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(["brief.md"]));
    expect(await screen.findByRole("button", { name: "Remove brief.md" })).toBeTruthy();
  });

  it("removes a required output without touching the other entries", async () => {
    const save = vi.fn(async () => {});
    render(<AgentDetailsPanel agent={libraryAgent} onClose={vi.fn()} onEdit={vi.fn()} onLibrarySave={save} />);
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove brief.md" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(["sources.json"]));
    expect(screen.queryByRole("button", { name: "Remove brief.md" })).toBeNull();
    expect(screen.getByText("sources.json")).toBeTruthy();
  });

  it("rolls the library back and explains a refused save", async () => {
    const save = vi.fn(async () => { throw new Error("This bot changed since it was opened."); });
    render(<AgentDetailsPanel agent={libraryAgent} onClose={vi.fn()} onEdit={vi.fn()} onLibrarySave={save} />);
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove brief.md" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("changed since it was opened");
    expect(screen.getByRole("button", { name: "Remove brief.md" })).toBeTruthy();
  });

  it("keeps the library read-only when no save path is supplied", () => {
    render(<AgentDetailsPanel agent={libraryAgent} onClose={vi.fn()} onEdit={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    expect(screen.getByText("brief.md")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove brief.md" })).toBeNull();
    expect(screen.queryByLabelText("Add a required output")).toBeNull();
  });

  it("shows the saved version and the real computer state", () => {
    const { container } = render(<AgentDetailsPanel agent={libraryAgent} onClose={vi.fn()} onEdit={vi.fn()} />);
    expect(within(container).getByText("v3")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Computer" }));
    expect(screen.getByText("opencode")).toBeTruthy();
    expect(screen.getByText("None paired")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports each paired computer's real state, including a failed registry", () => {
    const runtime = {
      harness: "codex", sandboxProvider: "e2b", localAvailable: false,
      paired: [
        { machineId: "m1", hostname: "studio", state: "busy" as const },
        { machineId: "m2", hostname: "mini", state: "offline" as const },
        { machineId: "m3", hostname: "air", state: "incompatible" as const },
      ],
      loading: false, error: null as string | null,
    };
    const { rerender } = render(<AgentDetailsPanel agent={libraryAgent} onClose={vi.fn()} onEdit={vi.fn()} runtime={runtime} />);
    fireEvent.click(screen.getByRole("tab", { name: "Computer" }));
    expect(screen.getByText("0 of 3 ready")).toBeTruthy();
    expect(screen.getByText("studio")).toBeTruthy();
    expect(screen.getByText("In use")).toBeTruthy();
    expect(screen.getByText("mini")).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText("air")).toBeTruthy();
    expect(screen.getByText("Can't run this harness")).toBeTruthy();
    expect(screen.getByText("e2b")).toBeTruthy();
    expect(screen.getByText(/No paired computer can start this bot right now/)).toBeTruthy();
    rerender(<AgentDetailsPanel agent={libraryAgent} onClose={vi.fn()} onEdit={vi.fn()} runtime={{ ...runtime, error: "Local execution is not enabled on this deployment." }} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Local execution is not enabled");
    // An unreadable registry is unknown, never "none paired".
    expect(screen.getByText("Unknown")).toBeTruthy();
    expect(screen.queryByText("None paired")).toBeNull();
    expect(screen.queryByText(/stay available/)).toBeNull();
    expect(screen.getByText(/starts in this sandbox only after you approve/)).toBeTruthy();
  });

  it("separates an unsupported harness from a paired computer that is merely unavailable", () => {
    const runtime = {
      harness: "gemini", localAvailable: false,
      paired: [{ machineId: "m1", hostname: "studio", state: "incompatible" as const }],
      loading: false, error: null,
    };
    render(<AgentDetailsPanel agent={libraryAgent} onClose={vi.fn()} onEdit={vi.fn()} runtime={runtime} />);
    fireEvent.click(screen.getByRole("tab", { name: "Computer" }));
    expect(screen.getByText(/Local execution cannot run gemini on a paired computer/)).toBeTruthy();
    expect(screen.queryByText(/No paired computer can start this bot right now/)).toBeNull();
    // No override means the deployment's default, never a required choice and
    // never a claim that a sandbox was checked or is available.
    const panel = within(screen.getByRole("tabpanel", { name: "Computer" }));
    expect(panel.getByText("Deployment default")).toBeTruthy();
    expect(panel.getByText(/runs in the deployment's sandbox/)).toBeTruthy();
    expect(panel.queryByText(/needs one selected|available|verified/i)).toBeNull();
  });
});

describe("bot panel workflows", () => {
  const withFiles: CustomAgentWire = {
    ...agent,
    config: { ...agent.config, libraryFileIds: ["file_aaaaaaaaaaaa", "file_bbbbbbbbbbbb", "file_cccccccccccc"] },
  };

  /** Routes the panel's own reads: the tool policy and each linked file. */
  function stubPanelFetch(files: Record<string, unknown>) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/employee-tools/")) return Response.json({ ok: true, employeeVersion: 1, toolScopes: [], grants: [] });
      const match = /^\/api\/files\/([^/]+)$/.exec(url);
      if (match) {
        const file = files[match[1]!];
        return file ? Response.json({ file }) : Response.json({ error: "File not found." }, { status: 404 });
      }
      return Response.json({ files: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const linkedFile = (id: string, name: string, mime = "text/markdown", scope = "workspace") => ({
    id, workspaceId: "ws_1", scope, folderId: null, name, mime, size: 480, sha256: "a".repeat(64),
    projectId: null, version: 1, createdBy: "me", createdAt: 1, updatedAt: 2, ingestion: { state: "done" },
  });

  it("lists a bot's linked documents, previews a supported one and marks an unreadable link", async () => {
    stubPanelFetch({
      file_aaaaaaaaaaaa: linkedFile("file_aaaaaaaaaaaa", "brief.md"),
      file_bbbbbbbbbbbb: linkedFile("file_bbbbbbbbbbbb", "data.parquet", "application/octet-stream"),
    });
    render(<AgentDetailsPanel agent={withFiles} onClose={vi.fn()} onEdit={vi.fn()} editing onConfigSave={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    expect(await screen.findByText("brief.md")).toBeTruthy();
    expect(screen.getByText("data.parquet")).toBeTruthy();
    // The third link is not readable by this viewer: it says so instead of disappearing.
    expect(await screen.findByText("Removed, or not available to you.")).toBeTruthy();
    expect(screen.getByText("Workspace file · 480 B · text/markdown")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Preview brief.md" }));
    expect(await screen.findByRole("link", { name: "Download brief.md" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview data.parquet" }));
    expect(screen.getByText("No in-panel preview for .parquet files. Download it to open it.")).toBeTruthy();
  });

  it("unlinks one document through a versioned config edit without touching the others", async () => {
    stubPanelFetch({ file_aaaaaaaaaaaa: linkedFile("file_aaaaaaaaaaaa", "brief.md") });
    const save = vi.fn(async () => {});
    render(<AgentDetailsPanel agent={withFiles} onClose={vi.fn()} onEdit={vi.fn()} editing onConfigSave={save} />);
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove brief.md" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ libraryFileIds: ["file_bbbbbbbbbbbb", "file_cccccccccccc"] }));
  });

  it("saves instructions for this bot and reports a refused save", async () => {
    const save = vi.fn(async () => { throw new Error("This bot changed since it was opened. Reload the latest version before saving."); });
    render(<AgentDetailsPanel agent={withFiles} onClose={vi.fn()} onEdit={vi.fn()} editing onConfigSave={save} />);
    fireEvent.click(screen.getByRole("button", { name: /^Instructions/ }));
    fireEvent.change(screen.getByLabelText(/What this bot should do/), { target: { value: "  Cite every source.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save instructions" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ instructions: "Cite every source." }));
    expect((await screen.findByRole("alert")).textContent).toContain("changed since it was opened");
  });

  it("keeps an unsaved instruction draft when the directory refreshes mid-edit", () => {
    const save = vi.fn(async () => {});
    const { rerender } = render(<AgentDetailsPanel agent={withFiles} onClose={vi.fn()} onEdit={vi.fn()} editing onConfigSave={save} />);
    fireEvent.click(screen.getByRole("button", { name: /^Instructions/ }));
    fireEvent.change(screen.getByLabelText(/What this bot should do/), { target: { value: "Draft only." } });
    // The same bot arrives again with a refreshed config object, as a poll would.
    rerender(<AgentDetailsPanel agent={{ ...withFiles, config: { ...withFiles.config } }} onClose={vi.fn()} onEdit={vi.fn()} editing onConfigSave={save} />);
    expect((screen.getByLabelText(/What this bot should do/) as HTMLTextAreaElement).value).toBe("Draft only.");
    fireEvent.click(screen.getByRole("button", { name: "Save instructions" }));
    return waitFor(() => expect(save).toHaveBeenCalledWith({ instructions: "Draft only." }));
  });

  it("follows a stored instruction change when there is no local draft", () => {
    const { rerender } = render(<AgentDetailsPanel agent={withFiles} onClose={vi.fn()} onEdit={vi.fn()} editing onConfigSave={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole("button", { name: /^Instructions/ }));
    rerender(<AgentDetailsPanel agent={{ ...withFiles, config: { ...withFiles.config, instructions: "Changed elsewhere." } }} onClose={vi.fn()} onEdit={vi.fn()} editing onConfigSave={vi.fn(async () => {})} />);
    expect((screen.getByLabelText(/What this bot should do/) as HTMLTextAreaElement).value).toBe("Changed elsewhere.");
  });

  it("disables every edit control when the panel has no save path", () => {
    render(<AgentDetailsPanel agent={withFiles} onClose={vi.fn()} onEdit={vi.fn()} editing={false} />);
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    expect(screen.queryByRole("button", { name: "Attach a file" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Details" }));
    fireEvent.click(screen.getByRole("button", { name: /^Instructions/ }));
    expect((screen.getByLabelText(/What this bot should do/) as HTMLTextAreaElement).readOnly).toBe(true);
  });

  it("shows this bot's approved runs on the Computer tab and opens one", () => {
    const onOpenRun = vi.fn();
    render(<AgentDetailsPanel
      agent={withFiles}
      onClose={vi.fn()}
      onEdit={vi.fn()}
      onOpenRun={onOpenRun}
      pendingApprovals={1}
      runs={[
        { runId: "run_1", status: "completed", task: "Write the brief", createdAt: 1, updatedAt: 2 },
        { runId: "run_2", status: "pending", task: "Second task", createdAt: 3, updatedAt: 4 },
      ]}
    />);
    fireEvent.click(screen.getByRole("tab", { name: "Computer" }));
    const runs = within(screen.getByRole("region", { name: "Approved runs" }));
    expect(runs.getByText("completed")).toBeTruthy();
    expect(runs.getByText("Write the brief")).toBeTruthy();
    fireEvent.click(runs.getAllByRole("button", { name: "Open this run" })[0]!);
    expect(onOpenRun).toHaveBeenCalledWith("run_1");
    expect(screen.getByText("1 task waiting for approval.")).toBeTruthy();
  });

  it("says a persistent bot computer does not exist instead of offering a fake power control", () => {
    render(<AgentDetailsPanel agent={withFiles} onClose={vi.fn()} onEdit={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Computer" }));
    expect(screen.getByText(/A persistent bot computer/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /wake|start|power|take over/i })).toBeNull();
  });

  it("reports real tool state and never offers a toggle the worker would refuse", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/employee-tools/")) {
        return Response.json({
          ok: true, employeeVersion: 4,
          toolScopes: ["mcp:shiba:gmail_read"],
          grants: [
            { subjectType: "actor", subjectId: "me", capabilityId: "mcp:shiba:gmail_read", resourceId: "inbox-1", lifecycle: "active" },
            { subjectType: "actor", subjectId: "me", capabilityId: "mcp:shiba:run_status", resourceId: "run-1", lifecycle: "active" },
          ],
        });
      }
      return Response.json({ files: [] });
    }));
    render(<AgentDetailsPanel agent={withFiles} onClose={vi.fn()} onEdit={vi.fn()} editing onConfigSave={vi.fn(async () => {})} onManageTools={vi.fn()} webSearchReady />);
    fireEvent.click(screen.getByRole("button", { name: /^Tools/ }));
    expect(await screen.findByText("On")).toBeTruthy();
    expect(screen.getAllByText("Off").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Not granted").length).toBeGreaterThan(0);
    expect(within(screen.getByRole("list", { name: "Bot tools" })).queryByRole("switch")).toBeNull();
    expect(screen.getByRole("button", { name: /Employee tool policy/ })).toBeTruthy();
  });

  it("drops the previous bot's library, instructions and runs when the panel moves to another bot", async () => {
    stubPanelFetch({ file_aaaaaaaaaaaa: linkedFile("file_aaaaaaaaaaaa", "brief.md") });
    const other: CustomAgentWire = {
      id: "engineering-1",
      slug: "engineering-bot",
      version: 7,
      config: { name: "Engineering bot", instructions: "Review diffs.", harness: "codex", expectedDeliverables: ["out/fix.md"] },
    };
    const { rerender } = render(<AgentDetailsPanel key={agent.id} agent={withFiles} onClose={vi.fn()} onEdit={vi.fn()} editing onConfigSave={vi.fn(async () => {})} runs={[{ runId: "run_1", status: "completed", task: "Research task", createdAt: 1, updatedAt: 2 }]} />);
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    expect(await screen.findByText("brief.md")).toBeTruthy();
    rerender(<AgentDetailsPanel key={other.id} agent={other} onClose={vi.fn()} onEdit={vi.fn()} editing onConfigSave={vi.fn(async () => {})} runs={[]} />);
    expect(screen.queryByText("brief.md")).toBeNull();
    expect(screen.getByText("Engineering bot")).toBeTruthy();
    expect(screen.queryByText("Research task")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    expect(screen.getByText("out/fix.md")).toBeTruthy();
    expect(screen.queryByText("brief.md")).toBeNull();
  });

  it("shows a loading state instead of another bot's details while the directory resolves", () => {
    render(<AgentDetailsPanel agent={undefined} directoryLoading onClose={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toBe("Loading this bot…");
    expect(screen.queryByRole("button", { name: "Edit description" })).toBeNull();
  });
});
