// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AutomationsView } from "./AutomationsView";

vi.mock("./CustomAgentsView", () => ({ useCustomAgentOptions: () => ({ agents: [{ id: "bot-1", config: { name: "Reviewer" } }] }) }));
const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });

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

  it.each([true, false])("updates enabled=%s through the existing PATCH contract", async (enabled) => {
    const automation = { id: "nightly-lint", repoUrl: "https://github.com/acme/app", prompt: "Lint", enabled, triggers: [{ kind: "schedule" }] };
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        automation.enabled = JSON.parse(String(init.body)).enabled;
        return Response.json({ automation });
      }
      return Response.json({ automations: [automation] });
    });
    render(<AutomationsView />);
    fireEvent.click(await screen.findByRole("button", { name: `${enabled ? "Disable" : "Enable"} nightly-lint` }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/automations/nightly-lint", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !enabled }),
    }));
    expect(await screen.findByRole("button", { name: `${enabled ? "Enable" : "Disable"} nightly-lint` })).toBeTruthy();
  });

  it("keeps an automation unchanged when its update fails", async () => {
    respond([{ id: "nightly-lint", repoUrl: "https://github.com/acme/app", prompt: "Lint", enabled: true, triggers: [{ kind: "schedule" }] }]);
    render(<AutomationsView />);
    const disable = await screen.findByRole("button", { name: "Disable nightly-lint" });
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Update refused" }, { status: 503 }));
    fireEvent.click(disable);
    expect(await screen.findByText("Update refused")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Disable nightly-lint" }) as HTMLButtonElement).disabled).toBe(false);
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

  it("resets copy feedback after a short delay", async () => {
    respond();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(<AutomationsView />);
    await screen.findByText("No automations yet. Start with a recipe.");
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Triggers" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy webhook endpoint" })); });
    expect(screen.getByRole("button", { name: "Copy webhook endpoint" }).textContent).toBe("Copied");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole("button", { name: "Copy webhook endpoint" }).textContent).toBe("Copy");
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
    expect(screen.getByRole("button", { name: "Copy webhook endpoint" }).textContent).toBe("Copy");
    fireEvent.click(screen.getByRole("button", { name: "Copy events endpoint" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.getByRole("button", { name: "Copy events endpoint" }).textContent).toBe("Copied");
  });
});
