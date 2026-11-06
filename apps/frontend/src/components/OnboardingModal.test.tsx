// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { detectSetupSteps, OnboardingModal } from "./OnboardingModal";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

describe("optional onboarding setup paths", () => {
  it("does not infer a Cloudflare plan or task readiness from reachable setup endpoints", async () => {
    expect(await detectSetupSteps()).toEqual(new Set());
    render(<OnboardingModal isOpen onClose={() => {}} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByText("Core setup complete!")).toBeNull();
    expect(screen.queryByText(/ready to launch/)).toBeNull();
    expect(screen.getByRole("link", { name: "Claude and Codex providers" }).getAttribute("href")).toBe("/providers/");
    expect(screen.getByRole("link", { name: "Apps and MCP servers" }).getAttribute("href")).toBe("/integrations/");
    expect(screen.getByRole("link", { name: "Review skills" }).getAttribute("href")).toBe("/skills/");
  });

  it("reports configured metadata without treating it as verified runtime access", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input) => Response.json(String(input) === "/api/setup/status"
      ? { github: { token: true }, access: { required: true }, slack: { signingSecret: true, botToken: true, approvers: 1 } }
      : String(input) === "/api/org/model-keys" ? { keys: [{ configured: true }] } : {})));
    const detected = await detectSetupSteps();
    expect(detected).toEqual(new Set(["github-token", "access-bypass", "slack-bot", "connect-model"]));
    expect(detected.has("workers-paid")).toBe(false);
    expect(detected.has("connect-sandbox")).toBe(false);
  });

  it.each(["claude", "codex"])("requires an explicit %s choice before creating only a starter draft", async (harness) => {
    localStorage.setItem("shiba_onboarding_completed_steps", JSON.stringify(["github-token", "connect-sandbox", "connect-model"]));
    const select = vi.fn(), close = vi.fn();
    render(<OnboardingModal isOpen onClose={close} onSelectStarterTask={select} />);
    const draft = screen.getByRole("button", { name: "Draft Starter Task →" });
    expect((draft as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Setup options reviewed")).toBeTruthy();
    expect(screen.queryByText(/ready to launch/)).toBeNull();
    expect(select).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "Starter task coding tool" }), { target: { value: harness } });
    fireEvent.click(draft);
    expect(select).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith("https://github.com/cloudflare/ai-chat", "Add unit tests for error handling and verify the test suite passes.", harness);
    expect(close).toHaveBeenCalledOnce();
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("ignores malformed legacy checklist state instead of crashing setup", () => {
    localStorage.setItem("shiba_onboarding_completed_steps", JSON.stringify({ complete: true }));
    render(<OnboardingModal isOpen onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Quick Setup & Onboarding" })).toBeTruthy();
    expect(screen.queryByText("Setup options reviewed")).toBeNull();
  });
});
