// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentChatEmptyState } from "./AgentChatEmptyState";

afterEach(cleanup);

describe("AgentChatEmptyState", () => {
  it("shows role guidance, exact-request approval, and role examples", () => {
    const { container } = render(<AgentChatEmptyState agent={{ id: "coding-coworker", name: "Agni", role: "engineering" }} />);
    expect(screen.getByRole("heading", { level: 2, name: "Agni" })).toBeTruthy();
    expect(screen.getByText("Implement a focused change with regression checks and a handoff.")).toBeTruthy();
    expect(screen.getByText("No sandbox work starts until you approve the exact request.")).toBeTruthy();
    expect(screen.getByText("Fix a small bug and add a regression test")).toBeTruthy();
    expect(container.querySelector('.shiba-agent-mascot[data-eyes="happy"]')).toBeTruthy();
  });

  it("only offers tool policy navigation when a callback is provided", () => {
    const onOpenToolPolicy = vi.fn();
    render(<AgentChatEmptyState agent={{ id: "a", name: "A" }} onOpenToolPolicy={onOpenToolPolicy} />);
    screen.getByRole("button", { name: "Review tool policy" }).click();
    expect(onOpenToolPolicy).toHaveBeenCalledOnce();
  });
});
