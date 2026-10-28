// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useAgentThreadDefaults } from "./agent-threads";
import type { CustomAgentWire } from "./components/CustomAgentsView";

afterEach(cleanup);
const reviewer: CustomAgentWire = { id: "reviewer", slug: "reviewer", version: 1, config: { name: "Reviewer", instructions: "Review", harness: "codex", codingModel: "openai/model", defaultRepoUrl: "https://github.com/example/a" } };
const builder: CustomAgentWire = { id: "builder", slug: "builder", version: 1, config: { name: "Builder", instructions: "Build", harness: "opencode", connectionId: "builder-connection", defaultRepoUrl: "https://github.com/example/b" } };

describe("bot defaults belong to their thread", () => {
  it("restores A's full profile after visiting B without inheriting B's repository or connection", () => {
    const onProfile = vi.fn();
    const { rerender } = renderHook(({ sessionId, agentId, agents }) => useAgentThreadDefaults(sessionId, agentId, agents, onProfile), {
      initialProps: { sessionId: "thread-a", agentId: "reviewer", agents: [reviewer, builder] },
    });
    rerender({ sessionId: "thread-b", agentId: "builder", agents: [reviewer, builder] });
    rerender({ sessionId: "thread-a", agentId: "reviewer", agents: [reviewer, builder] });
    expect(onProfile.mock.calls.map(([profile]) => profile.config)).toEqual([reviewer.config, builder.config, reviewer.config]);
  });

  it("restores a profile when the bot directory arrives after its session registry", () => {
    const onProfile = vi.fn();
    const { rerender } = renderHook(({ agents }) => useAgentThreadDefaults("thread-a", "reviewer", agents, onProfile), { initialProps: { agents: [] as CustomAgentWire[] } });
    expect(onProfile).not.toHaveBeenCalled();
    rerender({ agents: [reviewer] });
    expect(onProfile).toHaveBeenCalledWith(reviewer);
  });

  it("does not overwrite user edits on an unchanged directory refresh", () => {
    const onProfile = vi.fn();
    const { rerender } = renderHook(({ agents }) => useAgentThreadDefaults("thread-a", "reviewer", agents, onProfile), { initialProps: { agents: [reviewer] } });
    rerender({ agents: [{ ...reviewer }] });
    expect(onProfile).toHaveBeenCalledOnce();
    rerender({ agents: [{ ...reviewer, version: 2 }] });
    expect(onProfile).toHaveBeenCalledTimes(2);
  });
});
