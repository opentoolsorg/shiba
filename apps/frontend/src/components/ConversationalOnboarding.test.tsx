// @vitest-environment happy-dom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConversationalOnboarding } from "./ConversationalOnboarding";
import { EMPTY_ONBOARDING_DRAFT, type OnboardingDraft } from "../onboarding-draft";
import { OnboardingConflictError, type FirstRunProgressUpdate } from "../onboarding-progress-client";
import type { FirstRunProgressSnapshot } from "./FirstRunWizard";
import { EMPLOYEE_TEMPLATES } from "../employee-templates";
import { writeDraft } from "../saved";

beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ sources: [] }) }))); });
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
const id = "draft_00000000-0000-4000-8000-000000000001";
const initial: FirstRunProgressSnapshot = {
  schemaVersion: 2, currentStep: "channels", dismissedAt: null, connectionVerifiedAt: null,
  firstSuccessfulRunAt: null, acceptedArtifactAt: null, activatedAt: null, revision: 0,
  draftTaskId: null, draftTask: null,
  evidence: { connectedProvider: false, successfulRun: false, acceptedDeliverable: false },
};
const reviewDraft: OnboardingDraft = { ...EMPTY_ONBOARDING_DRAFT, version: 1, currentStep: "review", goal: "Prepare a grounded reply", audience: "A customer", acceptance: "Only supported facts; no sending", employeeTemplateId: "research", employeeTemplateVersion: 1, completedSteps: ["goal", "audience", "acceptance", "employee"] };

function harness(options: { draft?: OnboardingDraft; configure?: boolean; progressPending?: boolean; fail?: (update: FirstRunProgressUpdate) => Promise<void> } = {}) {
  let server = { ...initial, ...(options.draft ? { draftTaskId: id, draftTask: options.draft } : {}) };
  const resume = vi.fn(async () => {}), refresh = vi.fn(async () => {}), dismiss = vi.fn(async () => {});
  const close = vi.fn(), navigate = vi.fn(), useDraft = vi.fn(), legacy = vi.fn(), configure = vi.fn();
  const updates: FirstRunProgressUpdate[] = [];
  function Harness({ account = "owner-a" }: { account?: string }) {
    const [progress, setProgress] = useState<FirstRunProgressSnapshot | null>(options.progressPending ? null : server);
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
    return <ConversationalOnboarding progress={progress} onUpdate={update} onResume={resume} onRefresh={refresh} onDismiss={dismiss} onClose={close} onNavigate={navigate} onLegacyGuide={legacy} onUseDraft={useDraft} onConfigureEmployee={options.configure === false ? undefined : configure} draftScope={account} />;
  }
  return { Harness, updates, resume, refresh, dismiss, close, navigate, useDraft, legacy, configure, get server() { return server; } };
}

const send = async (label: string, text: string) => {
  fireEvent.change(screen.getByRole("textbox", { name: `Your answer: ${label}` }), { target: { value: text } });
  fireEvent.keyDown(screen.getByRole("textbox", { name: `Your answer: ${label}` }), { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(screen.queryByText("Saving your setup…")).toBeNull());
};

describe("conversational first task setup", () => {
  it("opens with core-area choices and enters the draft flow without saving or starting work", async () => {
    const h = harness();
    render(<h.Harness />);
    expect(screen.getByRole("heading", { name: "What would you like to do first?" })).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Choose where to begin" })).getAllByRole("button")).toHaveLength(4);
    expect(screen.getByText(/Choosing does not connect an app, configure an employee, start work, or grant approval/)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Start a coding task/ }));
    const composer = await screen.findByRole("textbox", { name: "Your answer: Goal" });
    expect(document.activeElement).toBe(composer);
    expect(screen.getByRole("button", { name: "A code change ready for review" })).toBeTruthy();
    expect(h.updates).toHaveLength(0);
    expect(h.dismiss).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.configure).not.toHaveBeenCalled();
    expect(h.useDraft).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "A code change ready for review" }));
    await screen.findByRole("textbox", { name: "Your answer: Audience" });
    expect(h.updates).toEqual([{ action: "save-draft", draftTask: { goal: "A code change ready for review", currentStep: "audience", completedSteps: ["goal"], skippedSteps: [] } }]);
  });

  it.each([
    ["Connect an app", "integrations"],
    ["Set up an employee", "configure"],
    ["Explore team", "team"],
    ["Explore automations", "automations"],
  ])("saves dismissal before opening the existing interface for %s", async (label, destination) => {
    const h = harness();
    let finish: (() => void) | undefined;
    h.dismiss.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<h.Harness />);
    if (label.startsWith("Explore")) {
      fireEvent.click(screen.getByRole("button", { name: /^Explore team and automation/ }));
      expect(h.dismiss).not.toHaveBeenCalled();
      expect(h.updates).toHaveLength(0);
      fireEvent.click(within(screen.getByRole("group", { name: "Explore Shiba" })).getByRole("button", { name: label }));
    } else {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}`) }));
    }
    expect(h.dismiss).toHaveBeenCalledOnce();
    expect(h.close).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.configure).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^Start a coding task/ }).hasAttribute("disabled")).toBe(true);
    await act(async () => { finish?.(); });
    expect(h.close).toHaveBeenCalledOnce();
    if (destination === "configure") {
      expect(h.configure).toHaveBeenCalledExactlyOnceWith(null);
      expect(h.navigate).not.toHaveBeenCalled();
    } else {
      expect(h.navigate).toHaveBeenCalledExactlyOnceWith(destination);
      expect(h.configure).not.toHaveBeenCalled();
    }
    expect(h.updates).toHaveLength(0);
    expect(h.useDraft).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(h.server.draftTask).toBeNull();
  });

  it("keeps the choices available when dismissal fails and permits an explicit retry", async () => {
    const h = harness();
    h.dismiss.mockRejectedValueOnce(new Error("Offline"));
    render(<h.Harness />);
    fireEvent.click(screen.getByRole("button", { name: /^Connect an app/ }));
    await screen.findByRole("alert");
    expect(h.close).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Connect an app/ }));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledExactlyOnceWith("integrations"));
    expect(h.updates).toHaveLength(0);
  });

  it("opens the employee interface when no configuration callback is supplied", async () => {
    const h = harness({ configure: false });
    render(<h.Harness />);
    fireEvent.click(screen.getByRole("button", { name: /^Set up an employee/ }));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledExactlyOnceWith("custom-agents"));
    expect(h.dismiss).toHaveBeenCalledOnce();
    expect(h.updates).toHaveLength(0);
  });

  it("keeps first-run choices usable while account progress is still loading", async () => {
    const h = harness({ progressPending: true });
    render(<h.Harness />);
    const choices = within(screen.getByRole("group", { name: "Choose where to begin" }));
    const start = choices.getByRole("button", { name: /^Start a coding task/ });
    expect((start as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(start);
    expect(await screen.findByRole("textbox", { name: "Your answer: Goal" })).toBeTruthy();
    expect(h.updates).toHaveLength(0);
    expect(h.dismiss).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it("restores unsent first-task input instead of resetting it to the choice screen", async () => {
    const h = harness();
    const view = render(<h.Harness />);
    fireEvent.click(screen.getByRole("button", { name: /^Start a coding task/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Your answer: Goal" }), { target: { value: "Fix the login layout" } });
    view.unmount();
    const resumed = render(<h.Harness />);
    expect((screen.getByRole("textbox", { name: "Your answer: Goal" }) as HTMLTextAreaElement).value).toBe("Fix the login layout");
    expect(screen.queryByRole("heading", { name: "What would you like to do first?" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Your answer: Goal" }), { target: { value: "" } });
    expect(screen.getByRole("textbox", { name: "Your answer: Goal" })).toBeTruthy();
    resumed.rerender(<h.Harness account="owner-b" />);
    expect(screen.getByRole("heading", { name: "What would you like to do first?" })).toBeTruthy();
    expect(h.updates).toHaveLength(0);
  });

  it("resumes a saved goal and account-scoped unsent input without showing choices", () => {
    writeDraft("onboarding:owner-a:goal", "Unsent revised goal");
    const h = harness({ draft: { ...EMPTY_ONBOARDING_DRAFT, version: 1, goal: "Saved goal" } });
    render(<h.Harness />);
    expect((screen.getByRole("textbox", { name: "Your answer: Goal" }) as HTMLTextAreaElement).value).toBe("Unsent revised goal");
    expect(screen.queryByRole("region", { name: "First-run choices" })).toBeNull();
    expect(h.updates).toHaveLength(0);
  });

  it("saves chips and free answers into an honest transcript, then requires explicit draft creation", async () => {
    const h = harness();
    render(<h.Harness />);
    fireEvent.click(screen.getByRole("button", { name: /^Start a coding task/ }));
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
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("/api/memory/sources", { credentials: "same-origin", cache: "no-store" });
    fireEvent.click(screen.getByRole("button", { name: "Use first task draft in Work" }));
    expect(h.useDraft).toHaveBeenCalledWith({ draftTaskId: id, version: h.server.draftTask?.version, draftTask: h.server.draftTask });
  });

  it("retains unsent answers across remount, supports Back, and keeps account drafts separate", async () => {
    const h = harness();
    const view = render(<h.Harness />);
    fireEvent.click(screen.getByRole("button", { name: /^Start a coding task/ }));
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
    fireEvent.click(screen.getByRole("button", { name: /^Start a coding task/ }));
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

  it("makes every optional role discoverable and filters without creating or configuring an employee", async () => {
    const h = harness({ draft: { ...reviewDraft, currentStep: "employee" } });
    render(<h.Harness />);
    const roles = screen.getByRole("group", { name: "Optional employee roles" });
    expect(within(roles).getAllByRole("button")).toHaveLength(EMPLOYEE_TEMPLATES.length);
    fireEvent.change(screen.getByRole("searchbox", { name: "Find an employee role" }), { target: { value: "finance" } });
    expect(within(roles).getAllByRole("button")).toHaveLength(1);
    expect(within(roles).getByRole("button", { name: /Finance/ })).toBeTruthy();
    expect(h.updates).toHaveLength(0);
    expect(h.configure).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("searchbox", { name: "Find an employee role" }), { target: { value: "no-such-role" } });
    expect(within(roles).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText(/No matching built-in role/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Describe a custom role" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Your answer: Employee" }));
    expect(within(roles).getAllByRole("button")).toHaveLength(EMPLOYEE_TEMPLATES.length);
    expect(h.updates).toHaveLength(0);
  });

  it.each(["gtm", "hr", "finance"] as const)("saves %s as an optional template hint and leaves employee configuration explicit", async (roleId) => {
    const h = harness({ draft: { ...reviewDraft, currentStep: "employee", employeeTemplateId: null, employeeTemplateVersion: null } });
    render(<h.Harness />);
    const template = EMPLOYEE_TEMPLATES.find((item) => item.id === roleId);
    if (!template) throw new Error(`Missing ${roleId} test template`);
    fireEvent.change(screen.getByRole("searchbox", { name: "Find an employee role" }), { target: { value: template.label } });
    const choice = within(screen.getByRole("group", { name: "Optional employee roles" })).getAllByRole("button")[0];
    if (!choice) throw new Error(`Missing ${roleId} role choice`);
    fireEvent.click(choice);
    await screen.findByRole("textbox", { name: "Your answer: Context" });
    expect(h.server.draftTask).toMatchObject({ employeeTemplateId: roleId, employeeTemplateVersion: 1, employeeId: null, employeeVersion: null });
    expect(h.configure).not.toHaveBeenCalled();
    expect(h.useDraft).not.toHaveBeenCalled();
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.action).toBe("save-draft");
  });

  it("does not invent a role recommendation for an unmatched goal", () => {
    const h = harness({ draft: { ...reviewDraft, currentStep: "employee", goal: "Organize my first task", roleAnswer: "", helpAnswer: "" } });
    render(<h.Harness />);
    expect(screen.queryByText(/Suggested starting point:/)).toBeNull();
    expect(screen.getByText(/Choose the role that fits your goal/)).toBeTruthy();
  });

  it.each([
    ["Review Claude and Codex, then return", "providers"],
    ["Review connections, then return", "integrations"],
    ["Review skills, then return", "skills"],
    ["Review employee permissions, then return", "employee-tools"],
  ])("saves the setup position before opening %s without connection or permission writes", async (label, view) => {
    const h = harness({ draft: { ...reviewDraft, currentStep: "connections" } });
    let finish: (() => void) | undefined;
    h.dismiss.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<h.Harness />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(h.navigate).not.toHaveBeenCalled();
    finish?.();
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith(view));
    expect(h.updates).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("saves only ready source ids while preserving unsent facts and Memory return", async () => {
    const source = { id: `memsrc_${"1".repeat(24)}`, title: "Private facts", version: 3, sha256: "a".repeat(64), ingestion: { state: "ready" }, disabledAt: null, expiresAt: null };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ sources: [source, { ...source, id: `memsrc_${"2".repeat(24)}`, title: "Expired facts", expiresAt: 1 }, { ...source, id: `memsrc_${"3".repeat(24)}`, title: "Legacy note", ingestion: undefined, version: undefined }] }) })));
    const h = harness({ draft: { ...reviewDraft, currentStep: "context" } });
    const view = render(<h.Harness />);
    const ready = await screen.findByRole("checkbox", { name: "Private facts · v3 · ready" });
    expect((screen.getByRole("checkbox", { name: /Expired facts/ }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Legacy note/ }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Your answer: Context" }), { target: { value: "Unsent private facts" } });
    fireEvent.click(ready);
    await waitFor(() => expect((ready as HTMLInputElement).checked).toBe(true));
    expect(h.updates.at(-1)).toEqual({ action: "save-draft", draftTask: { sourceIds: [source.id] } });
    expect((screen.getByRole("textbox", { name: "Your answer: Context" }) as HTMLTextAreaElement).value).toBe("Unsent private facts");
    fireEvent.click(screen.getByRole("button", { name: "Upload or manage sources, then return" }));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith("memory"));
    view.unmount(); render(<h.Harness />);
    expect((screen.getByRole("textbox", { name: "Your answer: Context" }) as HTMLTextAreaElement).value).toBe("Unsent private facts");
    await screen.findByRole("checkbox", { name: "Private facts · v3 · ready", checked: true });
  });

  it("offers explicit employee configuration and returns to a saved employee selection", async () => {
    const h = harness({ draft: { ...reviewDraft, preparedAt: 100 } });
    render(<h.Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Configure Research employee" }));
    await waitFor(() => expect(h.configure).toHaveBeenCalledWith("research"));
    expect(h.dismiss).toHaveBeenCalledOnce();
    expect(h.updates).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Choose a saved employee" }));
    await screen.findByRole("textbox", { name: "Your answer: Employee" });
    expect(h.server.draftTask?.currentStep).toBe("employee");
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
