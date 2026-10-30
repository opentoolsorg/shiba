// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FirstRunWizard, ONBOARDING_STORAGE_KEY } from "./FirstRunWizard";

afterEach(() => {
  cleanup();
  localStorage.removeItem(ONBOARDING_STORAGE_KEY);
  vi.unstubAllGlobals();
});

describe("FirstRunWizard employee handoff", () => {
  it("offers role templates and opens employee setup from the final onboarding step", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/providers") return Response.json({ providers: [] });
      if (path === "/api/mailboxes") return Response.json({ mailboxes: [] });
      return Response.json({
        slack: { signingSecret: false, botToken: false, approvers: 0, channelRepos: false },
        github: { token: false, app: false, publish: false, webhookSecret: false },
        linear: { webhookSecret: false, apiToken: false, defaultRepo: false },
        slackVerification: { signingSecret: false },
        gateway: { id: "gateway", token: false, reachable: "unknown" },
        access: { required: false },
        betterAuth: { configured: true },
        models: { orchestrator: "", coding: "", harness: "", roles: [] },
        automations: { enabled: false, typeSafe: false },
        mailbox: { addressOverride: false, sendEnabled: false },
        doctor: { ok: true, checkedAt: 0, findings: [], roles: [] },
      });
    }));
    const onStartEmployeeSetup = vi.fn();
    const onClose = vi.fn();
    render(<FirstRunWizard open onClose={onClose} onStartEmployeeSetup={onStartEmployeeSetup} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByRole("heading", { name: "Your first employee" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Model routing" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Your first employee" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set up research →" }));
    expect(onStartEmployeeSetup).toHaveBeenCalledWith(expect.objectContaining({ id: "research" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe("done");
  });
});
