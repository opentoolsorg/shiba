import { describe, expect, it, vi } from "vitest";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import { generateText } from "ai";

vi.mock("@cloudflare/think", () => ({ Think: class {} }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("ai", async (original) => ({ ...await original<typeof import("ai")>(), generateText: vi.fn(async () => ({ text: "Just testing." })) }));

describe("orchestrator side question", () => {
  it("uses the chat resolver without persisting, broadcasting or starting a harness", async () => {
    const forbidden = vi.fn(() => { throw new Error("Side questions must not write"); });
    const model = {};
    const resolveModel = vi.fn(() => model);
    const messages = [{ id: "one", role: "user", parts: [{ type: "text", text: "Current work" }] }];
    const instance = Object.assign(Object.create(CodingOrchestrator.prototype), {
      messages, resolveModel, setState: forbidden, saveMessages: forbidden, persistMessages: forbidden, broadcast: forbidden,
      ctx: { storage: { put: forbidden, delete: forbidden, sql: { exec: forbidden } } },
      env: { AGENT_AUDIT: { prepare: forbidden }, Sandbox: { get: forbidden } },
    }) as CodingOrchestrator;
    const response = await instance.onRequest(new Request("https://internal/internal/side-question", { method: "POST", body: JSON.stringify({ question: "Progress?", threadId: "thread", instructions: "You are Scout." }) }));
    expect(response.status).toBe(200);
    expect(resolveModel).toHaveBeenCalledOnce();
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({ model, system: "You are Scout.", tools: {}, messages: [{ role: "user", content: "Current work" }, { role: "user", content: "Progress?" }] }));
    expect(instance.messages).toEqual(messages);
    expect(forbidden).not.toHaveBeenCalled();
  });
});
