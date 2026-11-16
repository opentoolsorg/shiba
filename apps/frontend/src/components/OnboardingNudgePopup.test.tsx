// @vitest-environment happy-dom
import type { OnboardingStatus, OnboardingStepStatus } from "@shiba/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingNudgePopup } from "./OnboardingNudgePopup";

afterEach(cleanup);

const nextStep: OnboardingStepStatus = {
  id: "goal", label: "Describe your goal", complete: false,
  target: { kind: "setup", outcomeStep: "goal" },
};
const status: OnboardingStatus = { complete: false, nextStep, remaining: [nextStep], steps: [nextStep] };

describe("OnboardingNudgePopup", () => {
  it("names the dialog and remaining work, and resumes the next step", () => {
    const onResume = vi.fn();
    render(<OnboardingNudgePopup open status={status} onResume={onResume} onDismiss={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "Your first task is waiting" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByRole("listitem").textContent).toBe("Describe your goal");
    fireEvent.click(screen.getByRole("button", { name: "Continue setup" }));
    expect(onResume).toHaveBeenCalledExactlyOnceWith(nextStep);
  });

  it("closes with Not now or Escape", () => {
    const onDismiss = vi.fn();
    render(<OnboardingNudgePopup open status={status} onResume={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onDismiss).toHaveBeenCalledOnce();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("keeps keyboard focus inside and restores it on close", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const view = render(<OnboardingNudgePopup open status={status} onResume={() => {}} onDismiss={() => {}} />);
    const notNow = screen.getByRole("button", { name: "Not now" });
    const resume = screen.getByRole("button", { name: "Continue setup" });
    expect(document.activeElement).toBe(notNow);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(resume);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(notNow);
    view.rerender(<OnboardingNudgePopup open={false} status={status} onResume={() => {}} onDismiss={() => {}} />);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("renders nothing when closed or complete", () => {
    const view = render(<OnboardingNudgePopup open={false} status={status} onResume={() => {}} onDismiss={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(<OnboardingNudgePopup open status={{ ...status, complete: true, nextStep: null, remaining: [] }} onResume={() => {}} onDismiss={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
