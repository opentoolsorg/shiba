// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AutomationsView } from "./AutomationsView";

vi.mock("./CustomAgentsView", () => ({ useCustomAgentOptions: () => ({ agents: [{ id: "bot-1", config: { name: "Reviewer" } }] }) }));
const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function respond(automations: unknown[] = []) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ automations }) });
}

describe("AutomationsView", () => {
  it("shows a quiet empty state and opens recipes from New automation", async () => {
    respond();
    render(<AutomationsView />);
    expect(await screen.findByText("No automations yet. Start with a recipe.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New automation" }));
    expect(screen.getByRole("heading", { name: "Start with a recipe" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Use recipe" })).toHaveLength(6);
  });

  it("searches and collapses status groups without hiding manual run actions", async () => {
    respond([
      { id: "manual-audit", repoUrl: "https://github.com/acme/app", prompt: "Audit", enabled: true, triggers: [{ kind: "manual" }] },
      { id: "nightly-lint", repoUrl: "https://github.com/acme/other", prompt: "Lint", enabled: false, triggers: [{ kind: "schedule" }] },
    ]);
    render(<AutomationsView />);
    const group = await screen.findByRole("button", { name: "Enabled 1" });
    fireEvent.click(group);
    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
    fireEvent.click(group);
    fireEvent.change(screen.getByRole("textbox", { name: "Search automations" }), { target: { value: "acme/app" } });
    expect(screen.queryByRole("button", { name: "Disabled 1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/automations/manual-audit/run", { method: "POST" }));
  });

  it("keeps recipe validation and sends the existing creation contract", async () => {
    respond();
    render(<AutomationsView />);
    await screen.findByText("No automations yet. Start with a recipe.");
    fireEvent.click(screen.getByRole("button", { name: "New automation" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search automations" }), { target: { value: "Repository audit" } });
    fireEvent.click(screen.getByRole("button", { name: "Use recipe" }));
    expect(screen.getByRole("status").textContent).toContain("Enter a GitHub repository URL first.");
    fireEvent.change(screen.getByRole("textbox", { name: "Repository URL" }), { target: { value: "https://github.com/acme/app" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Bot for new automations" }), { target: { value: "bot-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Use recipe" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/automations", expect.objectContaining({ method: "POST", body: expect.any(String) })));
    const call = fetchMock.mock.calls.find((entry) => entry[1]?.method === "POST");
    expect(JSON.parse(call?.[1].body)).toMatchObject({ id: "manual-audit", repoUrl: "https://github.com/acme/app", enabled: true, customAgentId: "bot-1", triggers: [{ kind: "manual" }] });
  });

  it("shows load failures and retries", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    render(<AutomationsView />);
    expect(await screen.findByText("Automations could not be loaded (503).")).toBeTruthy();
    respond();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText("No automations yet. Start with a recipe.")).toBeTruthy();
  });

  it("copies trigger endpoints and reports clipboard errors", async () => {
    respond();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<AutomationsView />);
    fireEvent.click(screen.getByRole("button", { name: "Triggers" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy webhook endpoint" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy webhook endpoint" }).textContent).toBe("Copied"));
    expect(writeText).toHaveBeenCalledWith("/api/github/webhook");
    writeText.mockRejectedValueOnce(new Error("Denied"));
    fireEvent.click(screen.getByRole("button", { name: "Copy events endpoint" }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Could not copy the endpoint. Select and copy it instead.");
  });
});
