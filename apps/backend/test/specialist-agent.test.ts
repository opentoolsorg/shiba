import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import { ExplorerAgent } from "../src/agents/specialists/explorer-agent.js";
import { ReviewerAgent } from "../src/agents/specialists/reviewer-agent.js";
import { sealSpecialistDispatch, specialistObservationSchema, SPECIALIST_TIMEOUT_MS } from "../src/agents/specialists/contract.js";

const mocks = vi.hoisted(() => ({ generate: vi.fn(), factory: vi.fn(), model: vi.fn() }));
vi.mock("ai", async (importOriginal) => ({ ...await importOriginal<typeof import("ai")>(), generateText: mocks.generate }));
vi.mock("workers-ai-provider", () => ({ createWorkersAI: mocks.factory }));

const ENV = { INTERNAL_SIGNING_KEY: "test-key", AI: {}, ORCHESTRATOR_MODEL: "test-model" };
const MOCK_ENV = { INTERNAL_SIGNING_KEY: ENV.INTERNAL_SIGNING_KEY, SHIBA_VERIFY_STANDIN: "1", GITHUB_API_BASE: "http://127.0.0.1:8799" };
const PARENT = [{ className: "CodingOrchestrator", name: "owner" }];
const observation = { agent: "explorer", status: "completed", summary: "Found a.", report: "a.ts declares a.", findings: [] };

beforeEach(() => {
  mocks.generate.mockReset();
  mocks.generate.mockResolvedValue({ output: observation });
  mocks.factory.mockReset().mockReturnValue(mocks.model);
  mocks.model.mockReset().mockReturnValue({});
});

function agentWith<T extends ExplorerAgent | ReviewerAgent>(prototype: T, role: "explorer" | "reviewer", messages: UIMessage[], env: Record<string, unknown> = ENV, parentPath = PARENT): T {
  const agent: T = Object.create(prototype);
  Object.defineProperties(agent, {
    env: { value: env }, parentPath: { value: parentPath }, messages: { value: messages }, specialistRole: { value: role },
  });
  return agent;
}

function streamedObservation(stream: string) {
  const text = stream.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)))
    .filter((event) => event.type === "text-delta").map((event) => event.delta).join("");
  return specialistObservationSchema.parse(JSON.parse(text));
}

function specialistInput(role: "explorer" | "reviewer") {
  return role === "explorer"
    ? { goal: "Inspect", context: "explicit", files: [{ path: "a.ts", content: "export const a = 1;" }] }
    : { goal: "Review", context: "explicit", specification: "Keep approval gates", diff: "+export const a = 1;" };
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
    expect(mocks.factory).not.toHaveBeenCalled();
  });

  it("reviews an empty diff honestly and exposes no execution tools", async () => {
    const input = { goal: "Review", context: "explicit", specification: "Keep approval gates", diff: "" };
    mocks.generate.mockResolvedValue({ output: { ...observation, agent: "reviewer", summary: "Empty diff. No changes to audit." } });
    const dispatch = await sealSpecialistDispatch(ENV, "reviewer", "owner", "child", input);
    const agent = agentWith(ReviewerAgent.prototype, "reviewer", [{ id: "input", role: "user", parts: [{ type: "text", text: JSON.stringify(dispatch) }] }]);
    const response = await agent.onChatMessage(vi.fn());
    expect(await response.text()).toContain("Empty diff");
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.factory).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it.each(["explorer", "reviewer"] as const)("returns an explicit synthetic %s observation without an AI binding or model construction", async (role) => {
    const dispatch = await sealSpecialistDispatch(MOCK_ENV, role, "owner", "child", specialistInput(role));
    const prototype = role === "explorer" ? ExplorerAgent.prototype : ReviewerAgent.prototype;
    const agent = agentWith(prototype, role, [{ id: "input", role: "user", parts: [{ type: "text", text: JSON.stringify(dispatch) }] }], MOCK_ENV);
    const response = await agent.onChatMessage(vi.fn());
    const result = streamedObservation(await response.text());
    expect(result).toMatchObject({ agent: role, status: "completed", findings: [] });
    expect(result.summary).toContain(`synthetic ${role}`);
    expect(result.report).toContain("No supplied code was audited");
    expect(result.report).toContain("no tests were run");
    expect(mocks.factory).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(await agent.onBeforeSubAgent()).toMatchObject({ status: 403 });
  });

  it.each(["forged", "expired", "nested", "wrong-parent"])("rejects %s mock dispatch before producing an observation or constructing a model", async (failure) => {
    const dispatch = await sealSpecialistDispatch(MOCK_ENV, "explorer", "owner", "child", specialistInput("explorer"),
      failure === "expired" ? Date.now() - SPECIALIST_TIMEOUT_MS - 1 : Date.now());
    if (failure === "forged") dispatch.input = { ...specialistInput("explorer"), goal: "Changed after signing" };
    const parentPath = failure === "nested" ? [...PARENT, { className: "ExplorerAgent", name: "child" }]
      : failure === "wrong-parent" ? [{ className: "CodingOrchestrator", name: "someone-else" }] : PARENT;
    const agent = agentWith(ExplorerAgent.prototype, "explorer", [{ id: "input", role: "user", parts: [{ type: "text", text: JSON.stringify(dispatch) }] }], MOCK_ENV, parentPath);
    const response = await agent.onChatMessage(vi.fn());
    const stream = await response.text();
    expect(stream).toContain("could not complete");
    expect(stream).not.toContain('"type":"text-delta"');
    expect(mocks.factory).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("honors cancellation before a synthetic observation", async () => {
    const dispatch = await sealSpecialistDispatch(MOCK_ENV, "explorer", "owner", "child", specialistInput("explorer"));
    const agent = agentWith(ExplorerAgent.prototype, "explorer", [{ id: "input", role: "user", parts: [{ type: "text", text: JSON.stringify(dispatch) }] }], MOCK_ENV);
    const controller = new AbortController();
    controller.abort();
    const response = await agent.onChatMessage(vi.fn(), { requestId: "cancelled-fixture", abortSignal: controller.signal });
    expect(await response.text()).toContain("could not complete");
    expect(mocks.factory).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it.each([undefined, "https://api.github.com", "https://127.0.0.1:8799", "http://127.0.0.1.evil.example:8799"])("does not use the mock response for flag-only or non-loopback GitHub %s", async (base) => {
    const env = { ...ENV, SHIBA_VERIFY_STANDIN: "1", GITHUB_API_BASE: base };
    const dispatch = await sealSpecialistDispatch(env, "explorer", "owner", "child", specialistInput("explorer"));
    const agent = agentWith(ExplorerAgent.prototype, "explorer", [{ id: "input", role: "user", parts: [{ type: "text", text: JSON.stringify(dispatch) }] }], env);
    const response = await agent.onChatMessage(vi.fn());
    expect(streamedObservation(await response.text()).summary).toBe(observation.summary);
    expect(mocks.factory).toHaveBeenCalledOnce();
    expect(mocks.model).toHaveBeenCalledOnce();
    expect(mocks.generate).toHaveBeenCalledOnce();
  });

  it("requires the explicit stand-in flag even with loopback GitHub", async () => {
    const env = { ...ENV, GITHUB_API_BASE: MOCK_ENV.GITHUB_API_BASE };
    const dispatch = await sealSpecialistDispatch(env, "explorer", "owner", "child", specialistInput("explorer"));
    const agent = agentWith(ExplorerAgent.prototype, "explorer", [{ id: "input", role: "user", parts: [{ type: "text", text: JSON.stringify(dispatch) }] }], env);
    const response = await agent.onChatMessage(vi.fn());
    expect(streamedObservation(await response.text()).summary).toBe(observation.summary);
    expect(mocks.factory).toHaveBeenCalledOnce();
    expect(mocks.generate).toHaveBeenCalledOnce();
  });
});
