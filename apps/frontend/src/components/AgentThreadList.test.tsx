// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebThread } from "../agent-threads";
import { AgentThreadList, agentRunState, threadRunState } from "./AgentThreadList";

afterEach(cleanup);

const thread = (id: string, name: string, metadata?: Record<string, unknown>): WebThread => ({
  id,
  name,
  agentName: "web:user",
  updatedAt: Date.now() - 120_000,
  metadata,
});

describe("threadRunState", () => {
  it("prefers live caller state over persisted metadata", () => {
    expect(threadRunState(thread("a", "A", { status: "running" }))).toBe("working");
    expect(threadRunState(thread("a", "A", { status: "waiting-approval" }))).toBe("waiting");
    expect(threadRunState(thread("a", "A"))).toBe("idle");
    expect(threadRunState(thread("a", "A"), { a: "waiting" })).toBe("waiting");
  });

  it("rolls threads up to the busiest agent state", () => {
    expect(agentRunState([thread("a", "A"), thread("b", "B", { status: "waiting" })])).toBe(
      "waiting",
    );
    expect(agentRunState([thread("a", "A", { status: "waiting" })], { b: "working" })).toBe(
      "waiting",
    );
    expect(agentRunState([thread("a", "A"), thread("b", "B")], { b: "working" })).toBe("working");
    expect(agentRunState([])).toBe("idle");
  });
});

describe("AgentThreadList", () => {
  it("renders titles with last activity or running state and selects a thread", () => {
    const onSelect = vi.fn();
    render(
      <AgentThreadList
        agentName="Research Partner"
        threads={[
          thread("t1", "Competitor analysis"),
          thread("t2", ""),
          thread("t3", "Draft brief"),
        ]}
        activeId="t3"
        threadStates={{ t3: "working" }}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByRole("group", { name: "Research Partner threads" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Competitor analysis/ }).textContent).toContain(
      "2m ago",
    );
    expect(screen.getByRole("button", { name: /Untitled thread/ })).toBeTruthy();
    const active = screen.getByRole("button", { name: /Draft brief/ });
    expect(active.getAttribute("aria-current")).toBe("page");
    expect(active.textContent).toContain("Working");

    fireEvent.click(screen.getByRole("button", { name: /Competitor analysis/ }));
    expect(onSelect).toHaveBeenCalledWith("t1");
  });

  it("shows a real empty state", () => {
    render(<AgentThreadList agentName="Shiba" threads={[]} onSelect={vi.fn()} />);
    expect(screen.getByText("No threads yet")).toBeTruthy();
  });
});
