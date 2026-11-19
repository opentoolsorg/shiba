import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateText, type LanguageModel, type UIMessage } from "ai";
import { getAgentByName } from "agents/routing";
import { isSameOriginRequest, parseSuggestions, resetChatSuggestionLimits, suggestChatPrompts } from "../src/chat-suggestions.js";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import { handlers } from "../src/routes/handlers.js";
import type { RequestContext } from "../src/routes/context.js";
import type { Env } from "../src/env.js";

vi.mock("@cloudflare/think", () => ({ Think: class { onRequest() { return Response.json({ error: "Not found." }, { status: 404 }); } } }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("agents/routing", () => ({ getAgentByName: vi.fn() }));
vi.mock("ai", async (original) => ({ ...await original<typeof import("ai")>(), generateText: vi.fn() }));

const model = {} as LanguageModel;
const message = (id: string, role: "user" | "assistant", text: string) => ({ id, role, parts: [{ type: "text", text }] }) as UIMessage;
const say = (text: string) => vi.mocked(generateText).mockResolvedValue({ text } as never);
const originHeaders = { Origin: "https://shiba.test", "Content-Type": "application/json" };

function orchestrator(overrides: Record<string, unknown> = {}) {
  const forbidden = vi.fn(() => { throw new Error("Chat suggestions must not write"); });
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype), {
    name: "owner", messages: [], resolveModel: vi.fn(() => model),
    setState: forbidden, saveMessages: forbidden, persistMessages: forbidden, broadcast: forbidden,
    ctx: { storage: { put: forbidden, delete: forbidden, sql: { exec: forbidden } } },
    env: { AGENT_AUDIT: { prepare: forbidden }, Sandbox: { get: forbidden } },
    ...overrides,
  }) as CodingOrchestrator;
  return { instance, forbidden };
}

const post = (body = "{}", headers: Record<string, string> = originHeaders) =>
  new Request("https://shiba.test/agents/coding-orchestrator/owner/chat-suggestions", { method: "POST", headers, body });

beforeEach(() => {
  vi.clearAllMocks();
  resetChatSuggestionLimits();
  say('{"prompts":["Draft a launch email","Plan my week","Explain DNS caching"]}');
});

describe("chat suggestions", () => {
  it("suggests starters on an empty chat through the resolved chat model", async () => {
    const resolve = vi.fn(() => model);
    const response = await suggestChatPrompts([], resolve, "owner");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ suggestions: ["Draft a launch email", "Plan my week", "Explain DNS caching"] });
    expect(resolve).toHaveBeenCalledOnce();
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({ model, tools: {}, system: expect.stringContaining("start a conversation") }));
  });

  it("suggests follow-ups from the recent transcript without changing it", async () => {
    const tail = [message("1", "user", "How do I rotate a key?"), message("2", "assistant", "Create a new key, then revoke the old one.")];
    const original = JSON.stringify(tail);
    await suggestChatPrompts(tail, () => model, "owner");
    const options = vi.mocked(generateText).mock.calls[0]![0];
    expect(options.system).toContain("follow-up");
    expect(options.prompt).toContain("Person: How do I rotate a key?");
    expect(options.prompt).toContain("Shiba: Create a new key, then revoke the old one.");
    expect(JSON.stringify(tail)).toBe(original);
  });

  it("reuses the answer for the same transcript instead of paying twice", async () => {
    const tail = [message("1", "user", "Hi")];
    expect(await (await suggestChatPrompts(tail, () => model, "owner", 1_000)).json()).toEqual({ suggestions: ["Draft a launch email", "Plan my week", "Explain DNS caching"] });
    expect(await (await suggestChatPrompts(tail, () => model, "owner", 2_000)).json()).toEqual({ suggestions: ["Draft a launch email", "Plan my week", "Explain DNS caching"] });
    expect(generateText).toHaveBeenCalledOnce();
    await suggestChatPrompts([message("2", "user", "Different")], () => model, "owner", 3_000);
    expect(generateText).toHaveBeenCalledTimes(2);
    await suggestChatPrompts(tail, () => model, "someone-else", 4_000);
    expect(generateText).toHaveBeenCalledTimes(3);
  });

  it("stops spending after the hourly cap for one owner and leaves other owners alone", async () => {
    for (let index = 0; index < 30; index += 1) await suggestChatPrompts([message(String(index), "user", `Question ${index}`)], () => model, "owner", 1_000 + index);
    expect(generateText).toHaveBeenCalledTimes(30);
    const capped = await suggestChatPrompts([message("last", "user", "One more")], () => model, "owner", 2_000);
    expect(capped.status).toBe(200);
    expect(await capped.json()).toEqual({ suggestions: [] });
    expect(generateText).toHaveBeenCalledTimes(30);
    await suggestChatPrompts([message("other", "user", "One more")], () => model, "someone-else", 2_000);
    expect(generateText).toHaveBeenCalledTimes(31);
    await suggestChatPrompts([message("window", "user", "One more")], () => model, "owner", 1_000 + 60 * 60_000);
    expect(generateText).toHaveBeenCalledTimes(32);
  });

  it("returns no suggestions when no chat provider resolves", async () => {
    const response = await suggestChatPrompts([], () => { throw new Error("AI binding is not configured"); }, "owner");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ suggestions: [] });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("returns no suggestions and hides provider errors when generation fails", async () => {
    vi.mocked(generateText).mockRejectedValue(new Error("private provider detail"));
    const response = await suggestChatPrompts([], () => model, "owner");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"suggestions":[]}');
  });

  it("parses fenced JSON, trims quotes, drops duplicates and overlong prompts, and caps at three", () => {
    expect(parseSuggestions(`\`\`\`json\n{"prompts":["\u201cPlan a trip\u201d","plan a trip","${"x".repeat(141)}",42,"Summarize this","Compare options","Write tests"]}\n\`\`\``))
      .toEqual(["Plan a trip", "Summarize this", "Compare options"]);
    expect(parseSuggestions("Sure! Here are some ideas")).toEqual([]);
    expect(parseSuggestions('{"prompts":"nope"}')).toEqual([]);
  });

  it.each([
    ["a same-origin page", originHeaders, true],
    ["a same-origin fetch without a site hint", { Origin: "https://shiba.test" }, true],
    ["a cross-site page", { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }, false],
    ["a cross-site site hint with a matching origin", { Origin: "https://shiba.test", "Sec-Fetch-Site": "cross-site" }, false],
    ["a request with no origin", {}, false],
    ["a malformed origin", { Origin: "not a url" }, false],
  ])("treats %s as %s", (_label, headers, allowed) => {
    const request = new Request("https://shiba.test/agents/coding-orchestrator/owner/chat-suggestions", { method: "POST", headers, body: "{}" });
    expect(isSameOriginRequest(request)).toBe(allowed);
  });
});

describe("orchestrator chat suggestions route", () => {
  it("accepts only a same-origin POST on the exact canonical path", async () => {
    const { instance, forbidden } = orchestrator({ messages: [message("1", "user", "Hello")] });
    const response = await instance.onRequest(post());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ suggestions: ["Draft a launch email", "Plan my week", "Explain DNS caching"] });
    expect(instance.messages).toEqual([message("1", "user", "Hello")]);
    expect(forbidden).not.toHaveBeenCalled();

    const get = await instance.onRequest(new Request("https://shiba.test/agents/coding-orchestrator/owner/chat-suggestions"));
    expect(get.status).toBe(405);
    expect(get.headers.get("Allow")).toBe("POST");

    const crossSite = await instance.onRequest(post("{}", { Origin: "https://evil.example" }));
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toEqual({ error: "Cross-site request refused." });

    const otherPath = await instance.onRequest(new Request("https://shiba.test/agents/coding-orchestrator/someone-else/chat-suggestions", { method: "POST", headers: originHeaders, body: "{}" }));
    expect(otherPath.status).not.toBe(200);
  });

  it("never calls the model once the session is deleted", async () => {
    const { instance } = orchestrator({ state: { sessionDeletedAt: 1 } });
    const response = await instance.onRequest(post());
    expect(response.status).toBe(410);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("serves the caller's own thread through the Worker and refuses another owner", async () => {
    const fetchThread = vi.fn(async (request: Request) => Response.json({ forwarded: new URL(request.url).pathname, suggestions: [] }));
    vi.mocked(getAgentByName).mockResolvedValue({ fetch: fetchThread } as never);
    const env = { CodingOrchestrator: {} } as Env;
    const context = (path: string, user: string): RequestContext => {
      const request = new Request(`https://shiba.test${path}`);
      return { request, env, url: new URL(request.url), identity: async () => user };
    };
    const own = await handlers.agents(context("/agents/coding-orchestrator/owner/chat-suggestions", "owner"));
    expect(own?.status).toBe(200);
    expect(await own?.json()).toEqual({ forwarded: "/agents/coding-orchestrator/owner/chat-suggestions", suggestions: [] });
    expect(fetchThread).toHaveBeenCalledOnce();

    const foreign = await handlers.agents(context("/agents/coding-orchestrator/someone-else/chat-suggestions", "owner"));
    expect(foreign?.status).toBe(403);
    expect(fetchThread).toHaveBeenCalledOnce();
  });
});
