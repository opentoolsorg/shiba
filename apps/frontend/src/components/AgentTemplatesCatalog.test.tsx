// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AgentTemplatesCatalog } from "./AgentTemplatesCatalog";
import { AGENT_TEMPLATES, CURATED_MCP_VENDORS } from "@shiba/shared";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("AgentTemplatesCatalog", () => {
  it("retains a saved teammate mascot and settings when cloning from My templates", async () => {
    const config = { name: "My scout", instructions: "Review supplied facts.", harness: "opencode", mascotPreset: "sleeping", codingModel: "google/gemini-2.5-pro", defaultRepoUrl: "https://github.com/example/project" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ agents: [{ id: "saved-1", slug: "scout", version: 1, config }] })));
    const onUse = vi.fn().mockResolvedValue(undefined);
    render(<AgentTemplatesCatalog onUse={onUse} />);
    fireEvent.click(screen.getByRole("button", { name: /My templates/i }));
    const heading = await screen.findByRole("heading", { name: "My scout" });
    const card = heading.closest("article")!;
    expect(card.querySelector(".shiba-agent-mascot")?.getAttribute("data-eyes")).toBe("sleepy");
    fireEvent.click(Array.from(card.querySelectorAll("button")).find((button) => /Hire/.test(button.textContent ?? ""))!);
    await waitFor(() => expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ id: "scout" }), config));
  });
  it("filters real catalog cards with search and category chips", () => {
    render(<AgentTemplatesCatalog onUse={vi.fn()} />);
    expect(document.querySelectorAll(".agent-template-card")).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: "engineering" }));
    expect(document.querySelectorAll(".agent-template-card")).toHaveLength(4);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search templates" }), { target: { value: "reviewer" } });
    expect(document.querySelectorAll(".agent-template-card")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "PR Reviewer" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search templates" }), { target: { value: "no-such-teammate" } });
    expect(screen.getByText(/No teammates match your search/)).toBeTruthy();
  });

  it("hires the Sales report template with both required output files", async () => {
    const onUse = vi.fn().mockResolvedValue(undefined);
    render(<AgentTemplatesCatalog onUse={onUse} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search templates" }), { target: { value: "Sales report" } });
    expect(screen.getByRole("heading", { name: "Sales report" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hire" }));
    await waitFor(() => expect(onUse).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      id: "sales-report",
      expectedDeliverables: ["report.pdf", "sales.xlsx"],
    })));
  });

  it("shows a featured row only for the unfiltered catalog and hires from it", async () => {
    const onUse = vi.fn().mockResolvedValue(undefined);
    render(<AgentTemplatesCatalog onUse={onUse} />);
    const featured = screen.getByRole("region", { name: "Featured teammates" });
    const featuredIds = AGENT_TEMPLATES.filter((item) => item.categories.includes("featured"));
    expect(featured.querySelectorAll("button")).toHaveLength(featuredIds.length);
    const [first] = featuredIds;
    const firstButton = featured.querySelector("button");
    if (!first || !firstButton) throw new Error("Expected a featured teammate.");
    fireEvent.click(firstButton);
    await waitFor(() => expect(onUse).toHaveBeenCalledWith(first));
    expect((await screen.findByRole("status")).textContent).toContain(`${first.name} added to your bots`);
    fireEvent.click(screen.getByRole("button", { name: "ops" }));
    expect(screen.queryByRole("region", { name: "Featured teammates" })).toBeNull();
  });

  it("renders mascot, category tag and capability chips derived from the template", () => {
    render(<AgentTemplatesCatalog onUse={vi.fn()} />);
    const card = screen.getByRole("heading", { name: "Coding Coworker" }).closest("article");
    const mascot = card?.querySelector(".agent-avatar .shiba-agent-mascot");
    if (!card || !mascot) throw new Error("Expected a card with a mascot.");
    expect(mascot.getAttribute("data-shape")).toBe("pointed");
    expect(mascot.getAttribute("data-eyes")).toBe("happy");
    expect(card.querySelector(".agent-category")?.textContent).toBe("engineering");
    expect(Array.from(card.querySelectorAll(".agent-capabilities span"), (chip) => chip.textContent)).toEqual(["repository work", "slack threads", "Approval-gated"]);
  });
  it("reviews a complete catalog bundle without creating a bot or installing metadata skills", async () => {
    const request = vi.fn(async (_url: string, init?: RequestInit) => Response.json({
      recipe: JSON.parse(String(init?.body)).recipe, previewId: "ebp-preview", digest: "d".repeat(64), expiresAt: Date.now() + 60_000,
    }));
    vi.stubGlobal("fetch", request);
    const onUse = vi.fn();
    render(<AgentTemplatesCatalog onUse={onUse}/>);
    fireEvent.click(screen.getAllByRole("button", { name: "Review bundle" })[0]!);
    await screen.findByText(/Review digest:/);
    expect(onUse).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
    expect(body.recipe.skills).toEqual([]);
    expect(body.recipe.requirements).toEqual([expect.objectContaining({ kind: "skill", name: "repository-work" })]);
    expect(screen.getByText(/no managed skill body is included/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Import archived bot and draft skills" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers a reviewed new archived copy without claiming ownership of a legacy shared bot", async () => {
    const request = vi.fn(async (url: string, init?: RequestInit) => url === "/api/custom-agents" ? Response.json({ agents: [{
      id: "cag-old", version: 4, slug: "shared-people", config: { name: "Shared people", instructions: "Approved shared facts.", roleTemplateId: "hr", harness: "codex" },
    }] }) : Response.json({ recipe: JSON.parse(String(init?.body)).recipe, previewId: "ebp-preview", digest: "d".repeat(64), expiresAt: Date.now() + 60_000 }));
    vi.stubGlobal("fetch", request);
    render(<AgentTemplatesCatalog onUse={vi.fn()}/>);
    fireEvent.change(screen.getByRole("combobox", { name: "Template category" }), { target: { value: "my" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save as new archived bot" }));
    await screen.findByText(/Review digest:/);
    expect(request.mock.calls.map(([url]) => url)).toEqual(["/api/custom-agents", "/api/employee-bundles/preview"]);
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body)).recipe.profile.provenance).toEqual({ kind: "employee", id: "cag-old", revision: "4" });
  });

  it("keeps the detail dialog open with the error when hiring fails, and closes it once hiring succeeds", async () => {
    const onUse = vi.fn().mockRejectedValueOnce(new Error("Name already used")).mockResolvedValueOnce(undefined);
    render(<AgentTemplatesCatalog onUse={onUse} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^Details/ })[0]!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Hire/ }));
    expect((await within(dialog).findByRole("status")).textContent).toContain("Name already used");
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Hire/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onUse).toHaveBeenCalledTimes(2);
  });

  it("copies a JSON and Markdown pack and imports it through custom-agent creation", async () => {
    let copied = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async (value: string) => { copied = value; }) } });
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ agent: { id: "new-agent" } }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentTemplatesCatalog onUse={async () => undefined} />);

    const copyButton = screen.getAllByRole("button", { name: "Copy pack" })[0];
    if (!copyButton) throw new Error("Expected a copy action.");
    fireEvent.click(copyButton);
    await waitFor(() => expect(copied).toContain("--- INSTRUCTIONS.md ---"));
    fireEvent.click(screen.getByText("Paste import"));
    fireEvent.change(screen.getByLabelText("Template pack JSON"), { target: { value: copied } });
    fireEvent.click(screen.getByRole("button", { name: "Create bot from pack" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(request[1].body)) as { slug: string; config: { name: string; instructions: string } };
    expect(request[0]).toBe("/api/custom-agents");
    expect(body.slug).toBe(AGENT_TEMPLATES[0]?.id);
    expect(body.config.instructions).toContain("approval must precede sandbox work");
  });

  it("uses a catalog template by creating a custom bot", async () => {
    const onUse = vi.fn().mockResolvedValue(undefined);
    render(<AgentTemplatesCatalog onUse={onUse} />);
    const useButton = screen.getAllByRole("button", { name: "Hire" })[0];
    if (!useButton) throw new Error("Expected a use action.");
    fireEvent.click(useButton);
    await waitFor(() => expect(onUse).toHaveBeenCalledWith(AGENT_TEMPLATES[0]));
  });

  it("round-trips an explicitly chosen role and required outputs through a saved bot pack", async () => {
    let copied = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async (value: string) => { copied = value; }) } });
    const request = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? Response.json({ agent: { id: "imported" } }, { status: 201 })
      : Response.json({ agents: [{ slug: "people-partner", config: { name: "People partner", roleTemplateId: "hr", instructions: "Draft only from approved policies.", harness: "codex", expectedDeliverables: ["hr/workflow.md"] } }] }));
    vi.stubGlobal("fetch", request);
    render(<AgentTemplatesCatalog onUse={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Template category" }), { target: { value: "my" } });
    await screen.findByRole("heading", { name: /People partner/ });
    fireEvent.click(screen.getByRole("button", { name: "Copy pack" }));
    await waitFor(() => expect(copied).toContain('"roleTemplateId": "hr"'));
    fireEvent.click(screen.getByText("Paste import"));
    fireEvent.change(screen.getByLabelText("Template pack JSON"), { target: { value: copied } });
    fireEvent.click(screen.getByRole("button", { name: "Create bot from pack" }));
    await screen.findByText("People partner imported as a bot.");
    const write = request.mock.calls.find(([, init]) => init?.method === "POST");
    expect(write?.[0]).toBe("/api/custom-agents");
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({ slug: "people-partner", config: {
      name: "People partner", roleTemplateId: "hr", instructions: "Draft only from approved policies.", harness: "codex", expectedDeliverables: ["hr/workflow.md"],
    } });
  });

  it("rejects a forged role identifier before creating an imported bot", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    render(<AgentTemplatesCatalog onUse={vi.fn()} />);
    fireEvent.click(screen.getByText("Paste import"));
    fireEvent.change(screen.getByLabelText("Template pack JSON"), { target: { value: JSON.stringify({ template: { ...AGENT_TEMPLATES[0], roleTemplateId: "administrator" }, instructions: "Draft." }) } });
    fireEvent.click(screen.getByRole("button", { name: "Create bot from pack" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("roleTemplateId"));
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["denied", "unavailable"])("reports a copy error when clipboard access is %s", async (access) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: access === "denied"
        ? { writeText: vi.fn().mockRejectedValue(new DOMException("Permission denied", "NotAllowedError")) }
        : undefined,
    });
    render(<AgentTemplatesCatalog onUse={async () => undefined} />);
    const copyButton = screen.getAllByRole("button", { name: "Copy pack" })[0];
    if (!copyButton) throw new Error("Expected a copy action.");

    fireEvent.click(copyButton);

    expect((await screen.findByRole("status")).textContent).toContain("Could not copy this pack. Check clipboard access and try again.");
    expect(screen.queryByText(/pack copied\./)).toBeNull();
  });

  it("switches between employee templates and the read-only MCP server list", () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    render(<AgentTemplatesCatalog onUse={vi.fn()} />);
    const employees = screen.getByRole("tab", { name: "Employee templates" });
    const servers = screen.getByRole("tab", { name: "MCP servers" });
    expect(employees.getAttribute("aria-selected")).toBe("true");
    expect(servers.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(servers);
    expect(servers.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(servers.id);
    expect(document.querySelectorAll(".agent-template-card")).toHaveLength(0);
    expect(screen.queryByRole("searchbox", { name: "Search templates" })).toBeNull();
    const list = within(screen.getByRole("region", { name: "MCP servers" }));
    expect(list.getAllByRole("listitem")).toHaveLength(CURATED_MCP_VENDORS.length);
    expect(list.getAllByRole("link", { name: /^Docs for / })[0]?.getAttribute("href")).toBe(CURATED_MCP_VENDORS[0]?.docsUrl);
    expect(screen.getByText(/Connecting a server does not give any employee access/).textContent).toBe("Connecting a server does not give any employee access. Grant access separately in Tool policy.");
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(employees);
    expect(document.querySelectorAll(".agent-template-card")).toHaveLength(12);
  });

  it("moves between kind tabs with the arrow keys", () => {
    render(<AgentTemplatesCatalog onUse={vi.fn()} />);
    const employees = screen.getByRole("tab", { name: "Employee templates" });
    fireEvent.keyDown(employees, { key: "ArrowRight" });
    const servers = screen.getByRole("tab", { name: "MCP servers" });
    expect(servers.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(servers);
    expect(servers.tabIndex).toBe(0);
    expect(employees.tabIndex).toBe(-1);
    fireEvent.keyDown(servers, { key: "ArrowLeft" });
    expect(employees.getAttribute("aria-selected")).toBe("true");
  });

  it("opens a template detail panel with recommendations marked not installed and no grant claims", () => {
    render(<AgentTemplatesCatalog onUse={vi.fn()} />);
    const template = AGENT_TEMPLATES.find((item) => item.id === "coding-coworker");
    if (!template) throw new Error("Expected the Coding Coworker template.");
    const card = screen.getByRole("heading", { name: template.name, level: 3 }).closest("article");
    if (!card) throw new Error("Expected a template card.");
    const opener = within(card).getByRole("button", { name: `Details for ${template.name}` });
    opener.focus();
    fireEvent.click(opener);
    const dialog = within(screen.getByRole("dialog", { name: template.name }));
    expect(dialog.getByText(template.description)).toBeTruthy();
    expect(dialog.getByText("Recommended, not installed")).toBeTruthy();
    expect(dialog.getByText("repository work")).toBeTruthy();
    expect(dialog.getByText("Not included: credentials, network access, or external permissions")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).not.toMatch(/verified|rating|installs|downloads/i);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("hires and copies from the detail panel through the existing actions", async () => {
    let copied = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async (value: string) => { copied = value; }) } });
    const onUse = vi.fn().mockResolvedValue(undefined);
    render(<AgentTemplatesCatalog onUse={onUse} />);
    const template = AGENT_TEMPLATES[0];
    const details = screen.getAllByRole("button", { name: /^Details for / })[0];
    if (!template || !details) throw new Error("Expected a template with a details action.");
    fireEvent.click(details);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Copy pack" }));
    await waitFor(() => expect(copied).toContain("--- INSTRUCTIONS.md ---"));
    expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toBe(`${template.name} pack copied.`);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Hire" }));
    await waitFor(() => expect(onUse).toHaveBeenCalledExactlyOnceWith(template));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await screen.findByRole("status")).textContent).toContain(`${template.name} added to your bots`);
  });

  it("states that imported bundles arrive archived with no grants", () => {
    render(<AgentTemplatesCatalog onUse={vi.fn()} />);
    const share = within(screen.getByRole("region", { name: "Share an employee" }));
    expect(share.getByText(/creates an archived bot with no grants/).textContent).toContain("no tool access is given");
    expect(share.getByText(/templates\/ directory/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "MCP servers" }));
    expect(screen.queryByRole("region", { name: "Share an employee" })).toBeNull();
  });
});
