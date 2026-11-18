import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateText, type LanguageModel, type UIMessage } from "ai";
import { parseSuggestions, suggestChatPrompts } from "../src/chat-suggestions.js";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";

vi.mock("@cloudflare/think", () => ({ Think: class {} }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("ai", async (original) => ({ ...await original<typeof import("ai")>(), generateText: vi.fn() }));

const model = {} as LanguageModel;
const message = (id: string, role: "user" | "assistant", text: string) => ({ id, role, parts: [{ type: "text", text }] }) as UIMessage;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateText).mockResolvedValue({ text: '{"prompts":["Draft a launch email","Plan my week","Explain DNS caching"]}' } as never);
});

describe("chat suggestions", () => {
  it("suggests starters on an empty chat through the resolved chat model", async () => {
    const resolve = vi.fn(() => model);
    const response = await suggestChatPrompts([], resolve);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ suggestions: ["Draft a launch email", "Plan my week", "Explain DNS caching"] });
    expect(resolve).toHaveBeenCalledOnce();
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({ model, tools: {}, system: expect.stringContaining("start a conversation") }));
  });

  it("suggests follow-ups from the recent transcript without changing it", async () => {
    const tail = [message("1", "user", "How do I rotate a key?"), message("2", "assistant", "Create a new key, then revoke the old one.")];
    const original = JSON.stringify(tail);
    await suggestChatPrompts(tail, () => model);
    const options = vi.mocked(generateText).mock.calls[0]![0];
    expect(options.system).toContain("follow-up");
    expect(options.prompt).toContain("Person: How do I rotate a key?");
    expect(options.prompt).toContain("Shiba: Create a new key, then revoke the old one.");
    expect(JSON.stringify(tail)).toBe(original);
  });

  it("returns no suggestions when no chat provider resolves", async () => {
    const response = await suggestChatPrompts([], () => { throw new Error("AI binding is not configured"); });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ suggestions: [] });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("returns no suggestions and hides provider errors when generation fails", async () => {
    vi.mocked(generateText).mockRejectedValue(new Error("private provider detail"));
    const response = await suggestChatPrompts([], () => model);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"suggestions":[]}');
  });

  it("parses fenced JSON, trims quotes, drops duplicates and overlong prompts, and caps at three", () => {
    expect(parseSuggestions(`\`\`\`json\n{"prompts":["\u201cPlan a trip\u201d","plan a trip","${"x".repeat(141)}",42,"Summarize this","Compare options","Write tests"]}\n\`\`\``))
      .toEqual(["Plan a trip", "Summarize this", "Compare options"]);
    expect(parseSuggestions("Sure! Here are some ideas")).toEqual([]);
    expect(parseSuggestions('{"prompts":"nope"}')).toEqual([]);
  });
});

describe("orchestrator chat suggestions route", () => {
  it("answers GET on the thread agent path with the chat resolver and never writes", async () => {
    const forbidden = vi.fn(() => { throw new Error("Suggestions must not write"); });
    const resolveModel = vi.fn(() => model);
    const messages = [message("1", "user", "Hello")];
    const instance = Object.assign(Object.create(CodingOrchestrator.prototype), {
      messages, resolveModel, setState: forbidden, saveMessages: forbidden, persistMessages: forbidden, broadcast: forbidden,
      ctx: { storage: { put: forbidden, delete: forbidden, sql: { exec: forbidden } } },
      env: { AGENT_AUDIT: { prepare: forbidden }, Sandbox: { get: forbidden } },
    }) as CodingOrchestrator;
    const response = await instance.onRequest(new Request("https://example.test/agents/coding-orchestrator/user-1/chat-suggestions"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ suggestions: ["Draft a launch email", "Plan my week", "Explain DNS caching"] });
    expect(resolveModel).toHaveBeenCalledOnce();
    expect(instance.messages).toEqual(messages);
    expect(forbidden).not.toHaveBeenCalled();
  });
});
