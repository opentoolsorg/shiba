// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CustomAgentConfig } from "@shiba/shared";
import { EMPLOYEE_TEMPLATES } from "../employee-templates";
import { CustomAgentsView, type CustomAgentWire } from "./CustomAgentsView";

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

interface SaveBody { slug?: string; config: CustomAgentConfig; expectedVersion?: number }

function stubDirectory(initial: CustomAgentWire[] = []) {
  let agents = [...initial];
  const writes: { method: string; url: string; body: SaveBody }[] = [];
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" || init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as SaveBody;
      writes.push({ method: init.method, url, body });
      if (url === "/api/custom-agents" && init.method === "POST") {
        const agent: CustomAgentWire = { id: `saved-${agents.length}`, slug: body.slug ?? "", version: 1, config: body.config };
        agents = [...agents, agent];
        return Response.json({ agent }, { status: 201 });
      }
      const previous = agents.find((agent) => url === `/api/custom-agents/${agent.id}`);
      if (!previous || body.expectedVersion !== previous.version) return Response.json({ error: "Version conflict" }, { status: 409 });
      const agent = { ...previous, version: previous.version + 1, config: body.config };
      agents = agents.map((item) => item.id === agent.id ? agent : item);
      return Response.json({ agent });
    }
    return Response.json({ agents });
  });
  vi.stubGlobal("fetch", request);
  return { request, writes };
}

const change = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const value = (label: string | RegExp) => (screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
const connections = [{ id: "conn-openai", label: "Approved OpenAI", service: "openai", status: "ready" as const }];

describe("role drafts in the Bots directory", () => {

  it("creates from the primary fields using the keyboard and leaves optional settings collapsed", async () => {
    const server = stubDirectory();
    render(<CustomAgentsView />);
    const advanced = screen.getByText("Advanced settings").closest("details");
    const templates = screen.getByText("Use a role template").closest("details");
    expect(advanced?.open).toBe(false);
    expect(templates?.open).toBe(false);
    expect(screen.getByLabelText("Name").closest("details")).toBeNull();
    expect(screen.getByLabelText(/^Instructions/).closest("details")).toBeNull();
    change("Name", "My Research Helper");
    change(/^Instructions/, "Review the supplied sources and write a brief.");
    fireEvent.keyDown(screen.getByLabelText(/^Instructions/), { key: "Enter", ctrlKey: true });
    await screen.findByText("Bot created.");
    expect(server.writes).toEqual([{ method: "POST", url: "/api/custom-agents", body: {
      slug: "my-research-helper", config: { name: "My Research Helper", instructions: "Review the supplied sources and write a brief.", harness: "opencode" },
    } }]);
  });

  it("expands native advanced controls and restores their values from the account draft", () => {
    stubDirectory();
    const view = render(<CustomAgentsView draftScope="owner-a" connections={connections} />);
    const summary = screen.getByText("Advanced settings");
    expect(summary.tagName).toBe("SUMMARY");
    fireEvent.click(summary);
    expect(summary.closest("details")?.open).toBe(true);
    change("Name", "Research helper");
    change(/^Instructions/, "Keep these instructions");
    change("Harness", "codex"); change("Model", "openai/gpt-6-sol");
    change(/^Model connection/, "conn-openai"); change(/^Sandbox/, "docker-local");
    change("Default repository", "https://github.com/example/research");
    view.unmount();
    render(<CustomAgentsView draftScope="owner-a" connections={connections} />);
    const restoredSummary = screen.getByText("Advanced settings");
    expect(restoredSummary.closest("details")?.open).toBe(false);
    fireEvent.click(restoredSummary);
    expect(restoredSummary.closest("details")?.open).toBe(true);
    expect(value("Harness")).toBe("codex");
    expect(value("Model")).toBe("openai/gpt-6-sol");
    expect(value(/^Model connection/)).toBe("conn-openai");
    expect(value(/^Sandbox/)).toBe("docker-local");
    expect(value("Default repository")).toBe("https://github.com/example/research");
    expect(value(/^Instructions/)).toBe("Keep these instructions");
  });

  it("restores a browser draft after remount, isolates owners, and clears it only after creation", async () => {
    const server = stubDirectory();
    const view = render(<CustomAgentsView draftScope="owner-a" />);
    fireEvent.click(screen.getByRole("button", { name: "Research" }));
    change("Name", "My research helper");
    change("Default repository", "https://github.com/example/research");
    view.unmount();
    const other = render(<CustomAgentsView draftScope="owner-b" />);
    expect(value("Name")).toBe("");
    other.unmount();
    const resumed = render(<CustomAgentsView draftScope="owner-a" initialTemplateId="marketing" />);
    expect(value("Name")).toBe("My research helper");
    expect(value("Default repository")).toBe("https://github.com/example/research");
    expect(screen.getByRole("alertdialog", { name: /Marketing/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep current draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    await screen.findByText("Bot created.");
    expect(server.writes).toHaveLength(1);
    resumed.unmount();
    render(<CustomAgentsView draftScope="owner-a" />);
    expect(value("Name")).toBe("");
    expect(localStorage.getItem("shiba-role-draft-v1:owner-a")).toBeNull();
  });

  it("keeps the editor usable when browser storage is blocked", () => {
    stubDirectory();
    vi.stubGlobal("localStorage", { getItem: () => null, removeItem: () => {}, clear: () => {}, setItem: () => { throw new Error("Storage blocked"); } });
    render(<CustomAgentsView draftScope="owner-a" />);
    fireEvent.click(screen.getByRole("button", { name: "Operations" }));
    expect(value("Name")).toBe("Operations bot");
    expect(screen.getByText(/Browser storage is unavailable/)).toBeTruthy();
  });

  it("sends one create request for repeated form submissions while saving", async () => {
    let finish: ((response: Response) => void) | undefined;
    const request = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : Response.json({ agents: [] }));
    vi.stubGlobal("fetch", request);
    render(<CustomAgentsView />);
    fireEvent.click(screen.getByRole("button", { name: "Operations" }));
    const instructions = screen.getByLabelText(/^Instructions/);
    fireEvent.keyDown(instructions, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(instructions, { key: "Enter", ctrlKey: true });
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    finish?.(Response.json({ agent: { id: "operations", slug: "operations-bot", version: 1, config: { name: "Operations bot", instructions: "Write a runbook", harness: "opencode" } } }));
    await screen.findByText("Bot created.");
  });

  it("renders a renamed employee by slug and an unknown slug as custom without saving", async () => {
    const server = stubDirectory([
      { id: "known", slug: "design-bot", version: 1, config: { name: "Interface partner", harness: "codex", instructions: "Review the interface" } },
      { id: "custom", slug: "my-design-bot", version: 1, config: { name: "Design bot", harness: "opencode", instructions: "My own role" } },
    ]);
    render(<CustomAgentsView />);
    const known = (await screen.findByText("Interface partner")).closest("li");
    const custom = screen.getByText("Design bot").closest("li");
    expect(known?.querySelector('[data-employee-role="design"]')).toBeTruthy();
    expect(custom?.querySelector('[data-employee-role="custom"]')).toBeTruthy();
    expect(known?.textContent).toContain("Runs on codex");
    expect(server.writes).toEqual([]);

  });

  it.each(EMPLOYEE_TEMPLATES)("turns $label into an editable draft, then saves only when Create bot is chosen", async (template) => {
    const server = stubDirectory();
    const launch = vi.fn();
    render(<CustomAgentsView onStartThread={launch} />);
    await screen.findByText("No bots");
    const roleCard = screen.getByRole("button", { name: template.label });
    expect(roleCard.querySelector(`[data-employee-role="${template.id}"]`)).toBeTruthy();
    fireEvent.click(roleCard);
    expect(value("Name")).toBe(template.config.name);
    expect(value("Slug")).toBe(template.slug);
    expect(value("Mark")).toBe(template.config.emoji);
    expect(value(/^Instructions/)).toBe(template.config.instructions);
    expect(value(/^Required deliverables/)).toBe(template.config.expectedDeliverables?.join("\n") ?? "");
    expect(server.writes).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
    expect(screen.getByText(/External posting needs a supported connection and separate approval/)).toBeTruthy();

    const editedName = `${template.label} assistant`;
    change("Name", editedName);
    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    await screen.findByText("Bot created.");
    expect(server.writes).toHaveLength(1);
    expect(server.writes[0]).toEqual({
      method: "POST", url: "/api/custom-agents",
      body: {
        slug: template.slug,
        config: {
          name: editedName, emoji: template.config.emoji, instructions: template.config.instructions, harness: "opencode",
          ...(template.config.expectedDeliverables?.length ? { expectedDeliverables: template.config.expectedDeliverables } : {}),
        },
      },
    });
    expect(launch).not.toHaveBeenCalled();
    expect(server.request.mock.calls.every(([url]) => url === "/api/custom-agents")).toBe(true);
  });

  it("keeps a nonempty draft on cancel or Escape and prevents saving an unresolved replacement", async () => {
    const server = stubDirectory();
    render(<CustomAgentsView />);
    await screen.findByText("No bots");
    change("Name", "My draft"); change("Slug", "my-draft"); change("Mark", "X");
    change(/^Instructions/, "Keep this content.");
    change(/^Required deliverables/, "existing/notes.md");
    fireEvent.click(screen.getByRole("button", { name: "Marketing" }));
    const confirmation = screen.getByRole("alertdialog", { name: /Marketing/ });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep current draft" }));
    expect(value("Name")).toBe("My draft");
    expect(value(/^Instructions/)).toBe("Keep this content.");
    expect((screen.getByRole("button", { name: "Create bot" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(confirmation, { key: "Enter", ctrlKey: true });
    expect(server.writes).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Keep current draft" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(value(/^Required deliverables/)).toBe("existing/notes.md");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Marketing" }));
    fireEvent.click(screen.getByRole("button", { name: "Research" }));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(value("Name")).toBe("My draft");
    expect(value("Slug")).toBe("my-draft");
    expect(value("Mark")).toBe("X");
    expect(server.writes).toEqual([]);
  });

  it("replaces only the confirmed role fields and preserves the latest selected routing and repository", async () => {
    const server = stubDirectory();
    render(<CustomAgentsView connections={connections} />);
    await screen.findByText("No bots");
    change("Name", "Prior draft"); change(/^Instructions/, "Prior instructions");
    change("Harness", "codex"); change("Model", "openai/gpt-6-sol");
    change(/^Model connection/, "conn-openai"); change(/^Sandbox/, "docker-local");
    change("Default repository", "https://github.com/example/original");
    fireEvent.click(screen.getByRole("button", { name: "Marketing" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    change("Default repository", "https://github.com/example/latest");
    fireEvent.click(screen.getByRole("button", { name: "Replace draft" }));
    expect(value("Name")).toBe("Marketing bot");
    expect(value("Harness")).toBe("codex");
    expect(value("Model")).toBe("openai/gpt-6-sol");
    expect(value(/^Model connection/)).toBe("conn-openai");
    expect(value(/^Sandbox/)).toBe("docker-local");
    expect(value("Default repository")).toBe("https://github.com/example/latest");
    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    await screen.findByText("Bot created.");
    expect(server.writes[0]?.body.config).toMatchObject({
      name: "Marketing bot", harness: "codex", codingModel: "openai/gpt-6-sol", connectionId: "conn-openai",
      sandboxProvider: "docker-local", defaultRepoUrl: "https://github.com/example/latest",
      expectedDeliverables: ["marketing/brief.md", "marketing/campaign.md"],
    });
  });

  it("does not apply templates while editing a saved bot and preserves its saved settings", async () => {
    const bot: CustomAgentWire = { id: "existing", slug: "existing", version: 7, config: {
      name: "Existing bot", instructions: "Saved instructions", harness: "codex", codingModel: "openai/gpt-6-sol",
      connectionId: "conn-openai", approvalPolicy: "standard", defaultRepoUrl: "https://github.com/example/existing",
      expectedDeliverables: ["existing/report.json"],
    } };
    const server = stubDirectory([bot]);
    render(<CustomAgentsView connections={connections} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit bot" }));
    expect(screen.getByText("Advanced settings").closest("details")?.open).toBe(true);
    for (const template of EMPLOYEE_TEMPLATES) {
      const button = screen.getByRole("button", { name: template.label }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(value("Name")).toBe("Existing bot");
    expect(value(/^Required deliverables/)).toBe("existing/report.json");
    expect(server.writes).toEqual([]);
    change(/^Instructions/, "Updated by the user");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Bot updated.");
    expect(server.writes[0]).toEqual({ method: "PATCH", url: "/api/custom-agents/existing", body: {
      expectedVersion: 7, config: { ...bot.config, instructions: "Updated by the user" },
    } });
  });

  it("clears an existing required-file list only when the user clears that field", async () => {
    const server = stubDirectory([{ id: "existing", slug: "existing", version: 1, config: {
      name: "Existing bot", instructions: "Keep instructions", harness: "opencode", expectedDeliverables: ["existing/report.md"],
    } }]);
    render(<CustomAgentsView />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit bot" }));
    change(/^Required deliverables/, "");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Bot updated.");
    expect(server.writes[0]?.body.config).not.toHaveProperty("expectedDeliverables");
    expect(server.writes[0]?.body.config.instructions).toBe("Keep instructions");
  });

  it("rejects more than eight requested paths without saving or discarding the draft", async () => {
    const server = stubDirectory();
    render(<CustomAgentsView />);
    await screen.findByText("No bots");
    fireEvent.click(screen.getByRole("button", { name: "Operations" }));
    const paths = Array.from({ length: 9 }, (_, index) => `reports/file-${index}.md`).join("\n");
    change(/^Required deliverables/, paths);
    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("at most 8"));
    expect(value(/^Required deliverables/)).toBe(paths);
    expect(value("Name")).toBe("Operations bot");
    expect(server.writes).toEqual([]);
  });
});
