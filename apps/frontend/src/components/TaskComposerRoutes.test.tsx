// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskComposer, type TaskComposerProps } from "./TaskComposer";

afterEach(cleanup);

function props(overrides: Partial<TaskComposerProps> = {}): TaskComposerProps {
  return { task: "Prepare the requested files", repoUrl: "https://github.com/example/project", baseBranch: "main", publishPullRequest: false,
    harness: "claude-code", busy: false, isSubmitting: false, clearing: false,
    routing: { codingModel: "", connectionId: "", onCodingModelChange: vi.fn(), onConnectionChange: vi.fn(), reasoningEffort: "", onReasoningEffortChange: vi.fn() },
    onRepoUrlChange: vi.fn(), onTaskChange: vi.fn(), onBaseBranchChange: vi.fn(), onPublishPullRequestChange: vi.fn(), onHarnessChange: vi.fn(), onSubmit: vi.fn(), onClear: vi.fn(), ...overrides };
}

it("offers Codex API and ChatGPT routes separately without changing a selected route", () => {
  const input = props();
  render(<TaskComposer {...input} />);
  fireEvent.click(screen.getByRole("button", { name: "Thread configuration" }));
  expect(screen.getByRole("menuitemradio", { name: /Codex \(API credential\)/ })).toBeTruthy();
  expect(screen.getByRole("menuitemradio", { name: /Codex \(ChatGPT plan\)/ })).toBeTruthy();
  expect(screen.queryByRole("menuitemradio", { name: /claude-subscription/ })).toBeNull();
  expect(input.onHarnessChange).not.toHaveBeenCalled();
  expect(input.routing.onConnectionChange).not.toHaveBeenCalled();
  expect(input.onSubmit).not.toHaveBeenCalled();
});

it("shows the actual task selection and scope instead of an organization default account", () => {
  render(<TaskComposer {...props({ harness: "codex-subscription", routing: { ...props().routing, codingModel: "openai/example", connectionId: "plan", connections: [{ id: "plan", label: "My plan", status: "ready", service: "openai-subscription" }] } })} />);
  const route = screen.getByLabelText("Selected execution route");
  expect(route.textContent).toContain("Cloud sandbox · codex-subscription · Repository work");
  expect(route.textContent).toContain("openai/example");
  expect(route.textContent).toContain("Signed-in user's ChatGPT connection");
  expect(route.textContent).toContain("ChatGPT plan; requires an attributed human initiator");
});

it("queues explicit local artifacts with an online computer without switching to cloud", () => {
  const input = props({ repoUrl: "", executionTargetKind: "artifact-workspace", runTarget: "local", artifactDeliverables: "reports/brief.md", localRunAvailable: true, targetMachineId: "paired", onRunTargetChange: vi.fn() });
  render(<TaskComposer {...input} />);
  expect(screen.getByText(/Only approved paths are exported/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Send task" }).hasAttribute("disabled")).toBe(false);
  fireEvent.submit(screen.getByRole("form", { name: "Task composer" }));
  expect(input.onSubmit).toHaveBeenCalledOnce();
  expect(input.onRunTargetChange).not.toHaveBeenCalled();
});

it("blocks a revoked selected connection on rerender and preserves all explicit selections", () => {
  const input = props({ routing: { ...props().routing, connectionId: "chosen", connections: [{ id: "chosen", label: "My account", status: "ready", service: "anthropic" }] } });
  const { rerender } = render(<TaskComposer {...input} />);
  expect(screen.getByRole("button", { name: "Send task" }).hasAttribute("disabled")).toBe(false);
  rerender(<TaskComposer {...input} routing={{ ...input.routing, connections: [] }} />);
  expect(screen.getByRole("button", { name: "Send task" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText(/selected model connection is unavailable/)).toBeTruthy();
  fireEvent.submit(screen.getByRole("form", { name: "Task composer" }));
  expect(input.onSubmit).not.toHaveBeenCalled();
  expect(input.onHarnessChange).not.toHaveBeenCalled();
  expect(input.routing.onConnectionChange).not.toHaveBeenCalled();
});
