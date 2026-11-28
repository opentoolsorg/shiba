// @vitest-environment happy-dom
import type { OnboardingStatus, OnboardingStepStatus } from "@shiba/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingNudgeBanner } from "./OnboardingNudgeBanner";

afterEach(cleanup);

const nextStep: OnboardingStepStatus = {
  id: "provider", label: "Connect a provider", complete: false,
  target: { kind: "view", view: "providers" },
};
const lastStep: OnboardingStepStatus = {
  id: "accept-deliverable", label: "Accept a deliverable", complete: false,
  target: { kind: "view", view: "threads" },
};
const status: OnboardingStatus = { complete: false, nextStep, remaining: [nextStep, lastStep], steps: [nextStep, lastStep] };

describe("OnboardingNudgeBanner", () => {
  it("lists remaining required steps and resumes the exact next step", () => {
    const onResume = vi.fn();
    render(<OnboardingNudgeBanner status={status} onResume={onResume} onDismiss={() => {}} />);
    expect(screen.getByRole("heading", { name: "Finish setup — 2 steps left" })).toBeTruthy();
    const list = screen.getByRole("list", { name: "Remaining setup steps" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Connect a provider", "Accept a deliverable"]);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onResume).toHaveBeenCalledExactlyOnceWith(nextStep);
  });

  it("hides on dismissal and notifies its parent", () => {
    const onDismiss = vi.fn();
    render(<OnboardingNudgeBanner status={status} onResume={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(screen.queryByRole("region", { name: "Setup reminder" })).toBeNull();
  });

  it("renders nothing after activation", () => {
    render(<OnboardingNudgeBanner status={{ ...status, complete: true, nextStep: null, remaining: [] }} onResume={() => {}} onDismiss={() => {}} />);
    expect(screen.queryByRole("region", { name: "Setup reminder" })).toBeNull();
  });
});
