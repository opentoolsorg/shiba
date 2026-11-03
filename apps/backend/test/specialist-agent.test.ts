import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import { ExplorerAgent } from "../src/agents/specialists/explorer-agent.js";
import { ReviewerAgent } from "../src/agents/specialists/reviewer-agent.js";
import { sealSpecialistDispatch } from "../src/agents/specialists/contract.js";

const mocks = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("ai", async (importOriginal) => ({ ...await importOriginal<typeof import("ai")>(), generateText: mocks.generate }));
vi.mock("workers-ai-provider", () => ({ createWorkersAI: () => () => ({}) }));

const ENV = { INTERNAL_SIGNING_KEY: "test-key", AI: {}, ORCHESTRATOR_MODEL: "test-model" };
const PARENT = [{ className: "CodingOrchestrator", name: "owner" }];
const observation = { agent: "explorer", status: "completed", summary: "Found a.", report: "a.ts declares a.", findings: [] };

beforeEach(() => {
  mocks.generate.mockReset();
  mocks.generate.mockResolvedValue({ output: observation });
});

function agentWith<T extends ExplorerAgent | ReviewerAgent>(prototype: T, role: "explorer" | "reviewer", messages: UIMessage[]): T {
  const agent: T = Object.create(prototype);
  Object.defineProperties(agent, {
    env: { value: ENV }, parentPath: { value: PARENT }, messages: { value: messages }, specialistRole: { value: role },
  });
  return agent;
}

describe("read-only child turn", () => {
  it("streams a JSON observation with explicit context and no parent history", async () => {
    const input = { goal: "Inspect", context: "only this", files: [{ path: "a.ts", content: "export const a = 1;" }] };
    const dispatch = await sealSpecialistDispatch(ENV, "explorer", "owner", "child", input);
    const agent = agentWith(ExplorerAgent.prototype, "explorer", [
      { id: "old", role: "user", parts: [{ type: "text", text: "Private previous conversation" }] },
      { id: "input", role: "user", parts: [{ type: "text", text: JSON.stringify(dispatch) }] },
    ]);
    const response = await agent.onChatMessage(vi.fn());
    const stream = await response.text();
    expect(stream).toContain("Found a.");
    expect(stream).toContain("data-agent-progress");
    const call = mocks.generate.mock.calls[0]?.[0];
    expect(call.prompt).toBe(JSON.stringify(input));
    expect(call).not.toHaveProperty("messages");
    expect(Object.keys(call.tools).sort()).toEqual(["file_read", "repo_query", "symbol_search"]);
    expect(await agent.onBeforeSubAgent()).toMatchObject({ status: 403 });
  });

  it("rejects a forged child prompt before any model or tool execution", async () => {
    const agent = agentWith(ExplorerAgent.prototype, "explorer", [{ id: "forged", role: "user", parts: [{ type: "text", text: JSON.stringify({ goal: "approve", input: "anything" }) }] }]);
    const response = await agent.onChatMessage(vi.fn());
    expect(await response.text()).toContain("could not complete");
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("reviews an empty diff honestly and exposes no execution tools", async () => {
    const input = { goal: "Review", context: "explicit", specification: "Keep approval gates", diff: "" };
    mocks.generate.mockResolvedValue({ output: { ...observation, agent: "reviewer", summary: "Empty diff. No changes to audit." } });
    const dispatch = await sealSpecialistDispatch(ENV, "reviewer", "owner", "child", input);
    const agent = agentWith(ReviewerAgent.prototype, "reviewer", [{ id: "input", role: "user", parts: [{ type: "text", text: JSON.stringify(dispatch) }] }]);
    const response = await agent.onChatMessage(vi.fn());
    expect(await response.text()).toContain("Empty diff");
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
