// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FirstRunWizard, type FirstRunProgressSnapshot } from "./FirstRunWizard";

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

const progress: FirstRunProgressSnapshot = {
  currentStep: "channels", dismissedAt: null, connectionVerifiedAt: null,
  firstSuccessfulRunAt: null, acceptedArtifactAt: null, activatedAt: null, revision: 0,
  evidence: { connectedProvider: false, successfulRun: false, acceptedDeliverable: false },
};

function setupFetch() {
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
      access: { required: false }, betterAuth: { configured: true },
      models: { orchestrator: "", coding: "", harness: "", roles: [] },
      automations: { enabled: false, typeSafe: false },
      mailbox: { addressOverride: false, sendEnabled: false },
      doctor: { ok: true, checkedAt: 0, findings: [], roles: [] },
    });
  }));
}

describe("FirstRunWizard persisted progress", () => {
  it("saves navigation and resumes the persisted step after close and reopen", async () => {
    setupFetch();
    const onStepChange = vi.fn(async () => {});
    const onResume = vi.fn(async () => {});
    const onDismiss = vi.fn(async () => {});
    const onClose = vi.fn();
    const view = render(<FirstRunWizard open progress={progress} onStepChange={onStepChange} onResume={onResume} onDismiss={onDismiss} onClose={onClose} />);
    await waitFor(() => expect(onResume).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(onStepChange).toHaveBeenCalledWith("agent"));
    await screen.findByRole("heading", { name: "Your agent" });
    fireEvent.click(screen.getByRole("button", { name: "Close setup" }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith("agent"));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(localStorage.length).toBe(0);
    const saved = { ...progress, currentStep: "agent" as const, dismissedAt: 500, revision: 2 };
    view.rerender(<FirstRunWizard open={false} progress={saved} onClose={onClose} />);
    view.rerender(<FirstRunWizard open progress={saved} onClose={onClose} />);
    expect(screen.getByRole("heading", { name: "Your agent" })).toBeTruthy();
  });

  it("waits for dismissal to be persisted before closing", async () => {
    setupFetch();
    let finishDismiss: (() => void) | undefined;
    const onDismiss = vi.fn(() => new Promise<void>((resolve) => { finishDismiss = resolve; }));
    const onClose = vi.fn();
    render(<FirstRunWizard open progress={progress} onDismiss={onDismiss} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close setup" }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith("channels"));
    expect(onClose).not.toHaveBeenCalled();
    finishDismiss?.();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("shows server evidence and keeps manual guides usable without account persistence", async () => {
    setupFetch();
    const onClose = vi.fn();
    render(<FirstRunWizard open progress={null} onClose={onClose} />);
    expect(screen.getByText(/not linked to a signed-in account/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(localStorage.length).toBe(0);
  });
});
