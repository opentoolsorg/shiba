import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import type { OrchestratorState } from "../src/agents/orchestrator.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@cloudflare/think", () => ({ Think: class {
  onStart() {}
  getTools() { return {}; }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

type Delegate = {
  needsApproval: (input: unknown, options: { toolCallId: string }) => Promise<boolean>;
  execute: (input: unknown, options?: unknown) => Promise<unknown>;
};

const LLM = { repoUrl: "https://github.com/o/b", task: "llm task", baseBranch: "main", publishPullRequest: false };

function agent(messages: unknown[] = []) {
  return Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: { ...productionEnvStubs(), Sandbox: {}, GITHUB_TOKEN: "t" },
    state: { runs: [] } as OrchestratorState,
    messages,
    setState(state: OrchestratorState) { setStateLikeProduction(this, state); },
  });
}

const user = (shibaTask?: unknown) => ({
  id: crypto.randomUUID(),
  role: "user",
  parts: [{ type: "text", text: "go" }],
  ...(shibaTask !== undefined ? { metadata: { shibaTask } } : {}),
});

async function gate(instance: CodingOrchestrator, input: unknown = LLM, id = "call-1") {
  const delegate = instance.getTools()["delegate_coding_task"] as unknown as Delegate;
  const needs = await delegate.needsApproval(input, { toolCallId: id });
  return { needs, delegate, record: instance.state.pendingApprovals?.find((a) => a.approvalId === id) };
}

beforeEach(() => vi.resetAllMocks());

describe("chat gate composer pin", () => {
  it("pins the composer's repo and branch over the LLM's input", async () => {
    const { record } = await gate(agent([user({ repoUrl: "https://github.com/o/a", baseBranch: "dev" })]));
    expect(record?.repoUrl).toBe("https://github.com/o/a");
    expect(record?.baseBranch).toBe("dev");
    expect(record?.task).toBe("llm task");
  });

  it("never takes runtime, role, authAccount or testCommand from metadata", async () => {
    const { record } = await gate(agent([user({
      repoUrl: "https://github.com/o/a", runtime: "local", role: "fixer", authAccount: "evil", testCommand: ["rm"],
    })]));
    expect(record?.repoUrl).toBe("https://github.com/o/a");
    expect(record).not.toHaveProperty("runtime");
    expect(record).not.toHaveProperty("role");
    expect(record).not.toHaveProperty("authAccount");
    expect(record).not.toHaveProperty("testCommand");
  });

  it.each([["invalid", user({ repoUrl: 42 })], ["absent", user()]])(
    "%s metadata leaves the LLM input as-is", async (_label, message) => {
      const { record } = await gate(agent([message]));
      expect(record).toMatchObject(LLM);
    });

  it("drops only the bad or empty fields and keeps the rest of the pin", async () => {
    const { record } = await gate(agent([user({
      repoUrl: "https://github.com/o/a", baseBranch: 42, task: "", harness: "not-a-harness", codingModel: "",
    })]));
    expect(record?.repoUrl).toBe("https://github.com/o/a");
    expect(record?.baseBranch).toBe("main");
    expect(record?.task).toBe("llm task");
  });

  it("keeps the gate closed: needsApproval is true and execute refuses before approval", async () => {
    const { needs, delegate } = await gate(agent([user({ repoUrl: "https://github.com/o/a" })]));
    expect(needs).toBe(true);
    await expect(delegate.execute(LLM, { toolCallId: "call-1" })).resolves.toBe("Run is not approved to execute.");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("only the last user message's pin counts", async () => {
    const { record } = await gate(agent([
      user({ repoUrl: "https://github.com/o/a", baseBranch: "dev" }),
      { id: "a1", role: "assistant", parts: [] },
      user(),
    ]));
    expect(record).toMatchObject(LLM);
  });
});

describe("liveness ping", () => {
  it("onStart registers the JSON ping/pong auto-response", async () => {
    class Pair { constructor(public request: string, public response: string) {} }
    vi.stubGlobal("WebSocketRequestResponsePair", Pair);
    const setWebSocketAutoResponse = vi.fn();
    const instance = Object.assign(agent(), { ctx: { setWebSocketAutoResponse } });
    try {
      await instance.onStart();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(setWebSocketAutoResponse).toHaveBeenCalledWith(
      new Pair('{"type":"shiba:ping"}', '{"type":"shiba:pong"}'),
    );
  });
});
