// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OnboardingJourney, type OnboardingJourneyProps } from "./OnboardingJourney";
import { deriveJourney, type JourneyInput } from "../onboarding-journey";

afterEach(cleanup);

function journey(overrides: Partial<JourneyInput> = {}) {
  return deriveJourney({
    workspaceReady: true,
    providerReady: false,
    employeeReady: false,
    taskPrepared: false,
    run: "none",
    activated: false,
    dismissed: false,
    ...overrides,
  });
}

function props(overrides: Partial<OnboardingJourneyProps> = {}): OnboardingJourneyProps {
  const status = overrides.status ?? journey();
  return {
    status,
    stage: status.current ?? "workspace",
    onSelectStage: vi.fn(),
    onSkip: vi.fn(),
    workspace: {
      personalReady: true,
      workspaces: [],
      selectedId: null,
      canCreate: true,
      onSelect: vi.fn(),
      onCreate: vi.fn(async () => {}),
    },
    provider: { ready: false, label: null, findings: [], onOpenProviders: vi.fn() },
    employees: [],
    selectedEmployeeId: null,
    onSelectEmployee: vi.fn(async () => {}),
    onCreateEmployee: vi.fn(),
    approvals: [],
    decisions: {},
    onDecideApproval: vi.fn(),
    onOpenApprovals: vi.fn(),
    draftPrepared: false,
    onSendForApproval: vi.fn(),
    onOpenDraft: vi.fn(),
    run: null,
    onOpenRun: vi.fn(),
    onOpenReview: vi.fn(),
    taskStage: <div>task stage</div>,
    ...overrides,
  };
}

describe("OnboardingJourney", () => {
  it("shows the position in the flow and never lets a frame approve on its own", () => {
    render(<OnboardingJourney {...props()} />);
    expect(screen.getByText("Getting started · Step 2 of 6")).toBeTruthy();
    const steps = screen.getByRole("navigation", { name: "Onboarding steps" });
    expect(steps.querySelector('[aria-current="step"]')?.textContent).toContain("Connect a provider");
    expect(screen.queryByRole("button", { name: "Approve and start" })).toBeNull();
  });

  it("marks a satisfied stage done and hands provider work to the Providers surface", () => {
    const onOpenProviders = vi.fn();
    render(
      <OnboardingJourney
        {...props({
          status: journey(),
          provider: { ready: false, label: null, findings: [{ severity: "error", message: "No model route is ready.", fix: "Connect a provider in Providers." }], onOpenProviders },
        })}
      />,
    );
    expect(screen.getByLabelText("Choose a workspace: Workspace ready")).toBeTruthy();
    expect(screen.getByText("No model route is ready. Connect a provider in Providers.")).toBeTruthy();
    expect(screen.getByText(/Onboarding never asks for or stores a provider credential/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Open Providers" })[0]!);
    expect(onOpenProviders).toHaveBeenCalled();
  });

  it("creates a shared workspace without granting anything else", async () => {
    const onCreate = vi.fn(async () => {});
    render(<OnboardingJourney {...props({ stage: "workspace", workspace: { ...props().workspace, onCreate } })} />);
    fireEvent.change(screen.getByLabelText("Shared workspace name"), { target: { value: "Acme studio" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("Acme studio"));
  });

  it("saves the employee the person picks", async () => {
    const onSelectEmployee = vi.fn(async () => {});
    const status = journey();
    render(
      <OnboardingJourney
        {...props({
          status,
          stage: "employee",
          employees: [{ id: "employee_1", version: 3, name: "Scout", slug: "scout" }],
          onSelectEmployee,
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Scout/ }));
    await waitFor(() => expect(onSelectEmployee).toHaveBeenCalledWith(expect.objectContaining({ id: "employee_1", version: 3 })));
  });

  it("forwards the person's approval decision, and only theirs", () => {
    const onDecideApproval = vi.fn();
    const approval = { approvalId: "approval_1", task: "Draft the brief", repoUrl: "https://github.com/opentoolsorg/shiba", threadKey: "thread" };
    render(
      <OnboardingJourney
        {...props({ status: journey({ taskPrepared: true }), stage: "approval", approvals: [approval], onDecideApproval })}
      />,
    );
    expect(onDecideApproval).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve and start" }));
    expect(onDecideApproval).toHaveBeenCalledWith(expect.objectContaining({ approvalId: "approval_1" }), true);
  });

  it("shows the run's result and files, and reports a failure as one", () => {
    const { rerender } = render(
      <OnboardingJourney
        {...props({
          status: journey({ providerReady: true, employeeReady: true, taskPrepared: true, run: "completed" }),
          stage: "result",
          run: { runId: "run_1", status: "completed", summary: "Brief written", deliverables: [{ path: "reports/brief.md", bytes: 42 }] },
        })}
      />,
    );
    expect(screen.getByText("Brief written")).toBeTruthy();
    expect(screen.getByText("reports/brief.md · 42 B")).toBeTruthy();
    expect(screen.getByText(/Getting started/).textContent).toBe("Getting started · Done");

    rerender(
      <OnboardingJourney
        {...props({
          status: journey({ providerReady: true, employeeReady: true, taskPrepared: true, run: "failed" }),
          stage: "result",
          run: { runId: "run_2", status: "error", error: "Harness exited 1" },
        })}
      />,
    );
    expect(screen.getByText("Harness exited 1")).toBeTruthy();
    expect(screen.queryByText("Brief written")).toBeNull();
  });

  it("renders the saved task draft inside the flow for the task stage", () => {
    render(<OnboardingJourney {...props({ status: journey(), stage: "task" })} />);
    expect(screen.getByText("task stage")).toBeTruthy();
  });
});
