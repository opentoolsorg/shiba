// @vitest-environment happy-dom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConversationalOnboarding } from "./ConversationalOnboarding";
import { EMPTY_ONBOARDING_DRAFT, type OnboardingDraft } from "../onboarding-draft";
import { OnboardingConflictError, type FirstRunProgressUpdate } from "../onboarding-progress-client";
import type { FirstRunProgressSnapshot } from "./FirstRunWizard";

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
const id = "draft_00000000-0000-4000-8000-000000000001";
const initial: FirstRunProgressSnapshot = {
  schemaVersion: 2, currentStep: "channels", dismissedAt: null, connectionVerifiedAt: null,
  firstSuccessfulRunAt: null, acceptedArtifactAt: null, activatedAt: null, revision: 0,
  draftTaskId: null, draftTask: null,
  evidence: { connectedProvider: false, successfulRun: false, acceptedDeliverable: false },
};
const reviewDraft: OnboardingDraft = { ...EMPTY_ONBOARDING_DRAFT, version: 1, currentStep: "review", goal: "Prepare a grounded reply", audience: "A customer", acceptance: "Only supported facts; no sending", employeeTemplateId: "research", employeeTemplateVersion: 1, completedSteps: ["goal", "audience", "acceptance", "employee"] };

function harness(options: { draft?: OnboardingDraft; fail?: (update: FirstRunProgressUpdate) => Promise<void> } = {}) {
  let server = { ...initial, ...(options.draft ? { draftTaskId: id, draftTask: options.draft } : {}) };
  const resume = vi.fn(async () => {}), refresh = vi.fn(async () => {}), dismiss = vi.fn(async () => {});
  const close = vi.fn(), navigate = vi.fn(), useDraft = vi.fn(), legacy = vi.fn();
  const updates: FirstRunProgressUpdate[] = [];
  function Harness({ account = "owner-a" }: { account?: string }) {
    const [progress, setProgress] = useState(server);
    const update = async (body: FirstRunProgressUpdate) => {
      updates.push(body);
      await options.fail?.(body);
      const prior = server.draftTask ?? EMPTY_ONBOARDING_DRAFT;
      const draft: OnboardingDraft = body.action === "prepare-task"
        ? { ...prior, preparedAt: 100, currentStep: "review", completedSteps: [...new Set([...prior.completedSteps, "review" as const])] }
        : { ...prior, ...body.draftTask, version: prior.version + 1 };
      server = { ...server, draftTaskId: id, draftTask: draft, revision: server.revision + 1 };
      setProgress(server);
    };
    return <ConversationalOnboarding progress={progress} onUpdate={update} onResume={resume} onRefresh={refresh} onDismiss={dismiss} onClose={close} onNavigate={navigate} onLegacyGuide={legacy} onUseDraft={useDraft} draftScope={account} />;
  }
  return { Harness, updates, resume, refresh, dismiss, close, navigate, useDraft, legacy, get server() { return server; } };
}

const send = async (label: string, text: string) => {
  fireEvent.change(screen.getByRole("textbox", { name: `Your answer: ${label}` }), { target: { value: text } });
  fireEvent.keyDown(screen.getByRole("textbox", { name: `Your answer: ${label}` }), { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(screen.queryByText("Saving your setup…")).toBeNull());
};

describe("conversational first task setup", () => {
  it("saves chips and free answers into an honest transcript, then requires explicit draft creation", async () => {
    const h = harness();
    vi.stubGlobal("fetch", vi.fn());
    render(<h.Harness />);
    fireEvent.click(screen.getByRole("button", { name: "A research brief with sources" }));
    await screen.findByRole("textbox", { name: "Your answer: Audience" });
    fireEvent.click(screen.getByRole("button", { name: "A customer" }));
    await screen.findByRole("textbox", { name: "Your answer: Acceptance" });
    await send("Acceptance", "Cite supplied sources and flag every gap.");
    await screen.findByRole("textbox", { name: "Your answer: Your role" });
    expect(within(screen.getByRole("log", { name: "Setup conversation" })).getByText("Cite supplied sources and flag every gap.")).toBeTruthy();
    for (const label of ["Your role", "Help"]) {
      expect(screen.getByRole("textbox", { name: `Your answer: ${label}` })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Skip question" }));
      await waitFor(() => expect(screen.queryByText("Saving your setup…")).toBeNull());
    }
    fireEvent.click(screen.getByRole("button", { name: /Research Produce a sourced report/ }));
    await screen.findByRole("textbox", { name: "Your answer: Context" });
    await send("Context", "Use these supplied facts; this is not a source grant.");
    await screen.findByRole("textbox", { name: "Your answer: Connections" });
    fireEvent.click(screen.getByRole("button", { name: "I will use supplied context first" }));
    await screen.findByRole("region", { name: "First task draft review" });
    expect(screen.getByText("Research template · employee configuration pending")).toBeTruthy();
    expect(h.updates.every((body) => body.action === "save-draft")).toBe(true);
    expect(h.server.draftTask?.completedSteps).not.toContain("connections");
    expect(h.server.draftTask?.skippedSteps).toContain("connections");
    fireEvent.click(screen.getByRole("button", { name: "Create first task draft" }));
    await screen.findByRole("heading", { name: "First task draft saved" });
    expect(h.close).not.toHaveBeenCalled(); expect(h.useDraft).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use first task draft in Work" }));
    expect(h.useDraft).toHaveBeenCalledWith({ draftTaskId: id, version: h.server.draftTask?.version, draftTask: h.server.draftTask });
  });

  it("retains unsent answers across remount, supports Back, and keeps account drafts separate", async () => {
    const h = harness();
    const view = render(<h.Harness />);
    await send("Goal", "Prepare a sourced brief");
    await screen.findByRole("textbox", { name: "Your answer: Audience" });
    fireEvent.change(screen.getByRole("textbox", { name: "Your answer: Audience" }), { target: { value: "My pending audience" } });
    view.unmount();
    const resumed = render(<h.Harness />);
    expect((screen.getByRole("textbox", { name: "Your answer: Audience" }) as HTMLTextAreaElement).value).toBe("My pending audience");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("textbox", { name: "Your answer: Goal" });
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Your answer: Goal" }) as HTMLTextAreaElement).value).toBe("Prepare a sourced brief"));
    resumed.unmount();
    render(<h.Harness account="owner-b" />);
    expect((screen.getByRole("textbox", { name: "Your answer: Goal" }) as HTMLTextAreaElement).value).toBe("Prepare a sourced brief");
    expect(localStorage.getItem("shiba-composer-drafts-v1")).not.toContain('"onboarding:owner-b:audience"');
  });

  it("waits for saved dismissal before optional connection navigation", async () => {
    const h = harness({ draft: { ...reviewDraft, currentStep: "connections" } });
    let finish: (() => void) | undefined;
    h.dismiss.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<h.Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Review connections, then return" }));
    expect(h.navigate).not.toHaveBeenCalled();
    finish?.();
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith("integrations"));
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("preserves failed answers for explicit retry and never retries a conflict automatically", async () => {
    let attempts = 0;
    const h = harness({ fail: async () => { if (++attempts === 1) throw new OnboardingConflictError("Setup changed in another tab."); } });
    render(<h.Harness />);
    await send("Goal", "Keep my answer");
    await screen.findByRole("alert");
    expect(h.updates).toHaveLength(1);
    expect(screen.getByText("Your pending answer: Keep my answer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry my answer after review" }));
    await screen.findByRole("textbox", { name: "Your answer: Audience" });
    expect(h.updates).toHaveLength(2);
    expect(h.server.draftTask?.goal).toBe("Keep my answer");
  });

  it("blocks double creation, keeps preparation separate from execution, and resumes prepared review", async () => {
    let finish: (() => void) | undefined;
    const h = harness({ draft: reviewDraft, fail: (update) => update.action === "prepare-task" ? new Promise<void>((resolve) => { finish = resolve; }) : Promise.resolve() });
    const view = render(<h.Harness />);
    const create = screen.getByRole("button", { name: "Create first task draft" });
    fireEvent.click(create); fireEvent.click(create);
    expect(h.updates).toHaveLength(1); expect(h.useDraft).not.toHaveBeenCalled();
    await act(async () => { finish?.(); });
    await screen.findByRole("heading", { name: "First task draft saved" });
    view.unmount(); render(<h.Harness />);
    expect(screen.getByRole("heading", { name: "First task draft saved" })).toBeTruthy();
    expect(h.updates.filter((body) => body.action === "prepare-task")).toHaveLength(1);
  });

  it("requires all three outcome answers and saves custom employee needs as unconfigured", async () => {
    const h = harness({ draft: { ...reviewDraft, currentStep: "employee", employeeTemplateId: null, employeeTemplateVersion: null } });
    render(<h.Harness />);
    await send("Employee", "I need a translator");
    await screen.findByRole("textbox", { name: "Your answer: Context" });
    expect(h.server.draftTask?.employeeAnswer).toBe("I need a translator");
    expect(h.server.draftTask?.skippedSteps).toContain("employee");
    expect(h.server.draftTask?.employeeId).toBeNull();
    cleanup();
    const missing = harness({ draft: { ...reviewDraft, audience: "" } });
    render(<missing.Harness />);
    expect(screen.getByRole("button", { name: "Create first task draft" }).hasAttribute("disabled")).toBe(true);
  });
});
