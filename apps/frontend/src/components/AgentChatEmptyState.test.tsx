// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentChatEmptyState } from "./AgentChatEmptyState";

afterEach(cleanup);

describe("AgentChatEmptyState", () => {
  it("introduces the agent with its mascot and the participants-only privacy note", () => {
    const { container } = render(<AgentChatEmptyState agent={{ id: "coding-coworker", name: "Agni" }} />);
    expect(screen.getByRole("heading", { level: 2, name: "Agni" })).toBeTruthy();
    expect(screen.getByText("This is the beginning of your conversation. Messages are visible only to its participants.")).toBeTruthy();
    expect(container.querySelector(".shiba-agent-mascot")?.getAttribute("data-eyes")).toBe("happy");
    expect(container.querySelector(".shiba-agent-mascot")?.getAttribute("data-shape")).toBe("pointed");
  });
});
