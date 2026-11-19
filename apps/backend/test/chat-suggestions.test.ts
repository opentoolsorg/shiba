import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateText, type LanguageModel, type UIMessage } from "ai";
import { getAgentByName } from "agents/routing";
import {
  CHAT_SUGGESTION_LIMIT, CHAT_SUGGESTION_WINDOW_MS, chatSuggestionOwner, isSameOriginRequest, parseSuggestions,
  resetChatSuggestionState, suggestChatPrompts,
} from "../src/chat-suggestions.js";
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
const suggestions = ["Draft a launch email", "Plan my week", "Explain DNS caching"];
const allow = () => Promise.resolve(true);
const originHeaders = { Origin: "https://shiba.test", "Content-Type": "application/json" };
const suggest = (tail: UIMessage[], extra: { owner?: string; reserve?: () => Promise<boolean>; now?: number } = {}) =>
  suggestChatPrompts({ tail, model: () => model, owner: extra.owner ?? "owner", reserve: extra.reserve ?? allow, now: extra.now });

function orchestrator(overrides: Record<string, unknown> = {}) {
  const forbidden = vi.fn(() => { throw new Error("Chat suggestions must not write runs"); });
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype), {
    name: "owner", messages: [], resolveModel: vi.fn(() => model), state: {},
    setState: vi.fn((next: unknown) => { (instance as unknown as { state: unknown }).state = next; }),
    saveMessages: forbidden, persistMessages: forbidden, broadcast: forbidden,
    ctx: { storage: { put: forbidden, delete: forbidden, sql: { exec: forbidden } } },
    env: { AGENT_AUDIT: { prepare: forbidden }, Sandbox: { get: forbidden }, CodingOrchestrator: { idFromName: (name: string) => name } },
    ...overrides,
  }) as CodingOrchestrator;
  return { instance, forbidden };
}

const post = (path = "/agents/coding-orchestrator/owner/chat-suggestions", headers: Record<string, string> = originHeaders, body = "{}") =>
  new Request(`https://shiba.test${path}`, { method: "POST", headers, body });

beforeEach(() => {
  vi.clearAllMocks();
  resetChatSuggestionState();
  say(`{"prompts":${JSON.stringify(suggestions)}}`);
});

describe("chat suggestions", () => {
  it("suggests starters on an empty chat through the resolved chat model", async () => {
    const resolve = vi.fn(() => model);
    const response = await suggestChatPrompts({ tail: [], model: resolve, owner: "owner", reserve: allow });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ suggestions });
    expect(resolve).toHaveBeenCalledOnce();
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({ model, tools: {}, maxRetries: 0, system: expect.stringContaining("start a conversation") }));
  });

  it("suggests follow-ups from the recent transcript without changing it", async () => {
    const tail = [message("1", "user", "How do I rotate a key?"), message("2", "assistant", "Create a new key, then revoke the old one.")];
    const original = JSON.stringify(tail);
    await suggest(tail);
    const options = vi.mocked(generateText).mock.calls[0]![0];
    expect(options.system).toContain("follow-up");
    expect(options.prompt).toContain("Person: How do I rotate a key?");
    expect(options.prompt).toContain("Shiba: Create a new key, then revoke the old one.");
    expect(JSON.stringify(tail)).toBe(original);
  });

  it("reuses the answer for the same transcript instead of paying twice", async () => {
    await suggest([message("1", "user", "Hi")], { now: 1_000 });
    await suggest([message("1", "user", "Hi")], { now: 2_000 });
    expect(generateText).toHaveBeenCalledOnce();
    await suggest([message("2", "user", "Different")], { now: 3_000 });
    expect(generateText).toHaveBeenCalledTimes(2);
    await suggest([message("1", "user", "Hi")], { owner: "someone-else", now: 4_000 });
    expect(generateText).toHaveBeenCalledTimes(3);
  });

  it("shares one generation when the same transcript is asked twice at once", async () => {
    let release = () => {};
    vi.mocked(generateText).mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ text: `{"prompts":${JSON.stringify(suggestions)}}` } as never);
    }));
    const tail = [message("1", "user", "Cold cache")];
    const first = suggest(tail);
    const second = suggest(tail);
    await vi.waitFor(() => expect(generateText).toHaveBeenCalled());
    release();
    expect(await (await first).json()).toEqual({ suggestions });
    expect(await (await second).json()).toEqual({ suggestions });
    expect(generateText).toHaveBeenCalledOnce();
  });

  it("asks the account's quota before generating and stays quiet when it refuses", async () => {
    const reserve = vi.fn(async () => false);
    const response = await suggest([message("1", "user", "Hi")], { reserve });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ suggestions: [] });
    expect(reserve).toHaveBeenCalledOnce();
    expect(generateText).not.toHaveBeenCalled();
  });

  it("returns no suggestions when no chat provider resolves", async () => {
    const response = await suggestChatPrompts({ tail: [], model: () => { throw new Error("AI binding is not configured"); }, owner: "owner", reserve: allow });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ suggestions: [] });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("returns no suggestions and hides provider errors when generation fails", async () => {
    vi.mocked(generateText).mockRejectedValue(new Error("private provider detail"));
    const response = await suggest([], { now: 1 });
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
    ["a matching host on another scheme", { Origin: "http://shiba.test" }, false],
    ["a matching host on another port", { Origin: "https://shiba.test:8443" }, false],
    ["the literal null origin", { Origin: "null" }, false],
    ["a request with no origin", {}, false],
    ["a malformed origin", { Origin: "not a url" }, false],
  ])("treats %s as %s", (_label, headers, allowed) => {
    const request = new Request("https://shiba.test/agents/coding-orchestrator/owner/chat-suggestions", { method: "POST", headers, body: "{}" });
    expect(isSameOriginRequest(request)).toBe(allowed);
  });

  it("resolves dashboard threads to their account and refuses every other lane", () => {
    expect(chatSuggestionOwner("web:owner:11111111-1111-4111-8111-111111111111")).toBe("owner");
    expect(chatSuggestionOwner("owner")).toBe("owner");
    expect(chatSuggestionOwner("den:abc")).toBeNull();
    expect(chatSuggestionOwner("captain:abc")).toBeNull();
    expect(chatSuggestionOwner("slack:T1:C1:1.2")).toBeNull();
    expect(chatSuggestionOwner("default")).toBeNull();
    expect(chatSuggestionOwner("web:owner")).toBeNull();
  });
});

describe("orchestrator chat suggestions route", () => {
  it("accepts only a same-origin POST on the exact canonical path", async () => {
    const { instance, forbidden } = orchestrator({ messages: [message("1", "user", "Hello")] });
    const response = await instance.onRequest(post());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ suggestions });
    expect(instance.messages).toEqual([message("1", "user", "Hello")]);
    expect(forbidden).not.toHaveBeenCalled();

    expect((await instance.onRequest(new Request("https://shiba.test/agents/coding-orchestrator/owner/chat-suggestions"))).status).toBe(405);
    const crossSite = await instance.onRequest(post("/agents/coding-orchestrator/owner/chat-suggestions", { Origin: "https://evil.example" }));
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toEqual({ error: "Cross-site request refused." });
    expect((await instance.onRequest(post("/agents/coding-orchestrator/someone-else/chat-suggestions"))).status).toBe(404);
    expect((await instance.onRequest(post("/agents/coding-orchestrator/owner/chat-suggestions/"))).status).toBe(404);
  });

  it("never calls the model once the session is deleted", async () => {
    const { instance } = orchestrator({ state: { sessionDeletedAt: 1 } });
    expect((await instance.onRequest(post())).status).toBe(410);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("counts every web thread of one account against that account's durable quota", async () => {
    const state: Record<string, unknown> = {};
    const setState = vi.fn((next: unknown) => { Object.assign(state, next); });
    const base = orchestrator({ name: "owner", state, setState, messages: [] }).instance;
    for (let index = 0; index < CHAT_SUGGESTION_LIMIT; index += 1) {
      expect(await base.onRequest(new Request("https://internal/internal/chat-suggestion-quota", { method: "POST" })).then((r) => r.json())).toEqual({ allowed: true });
    }
    expect(await base.onRequest(new Request("https://internal/internal/chat-suggestion-quota", { method: "POST" })).then((r) => r.json())).toEqual({ allowed: false });
    expect((state as { chatSuggestionQuota: { count: number; start: number } }).chatSuggestionQuota.count).toBe(CHAT_SUGGESTION_LIMIT);
        const expired = orchestrator({ state: { chatSuggestionQuota: { start: Date.now() - CHAT_SUGGESTION_WINDOW_MS - 1, count: CHAT_SUGGESTION_LIMIT } }, setState: () => {} }).instance;
    expect(await expired.onRequest(new Request("https://internal/internal/chat-suggestion-quota", { method: "POST" })).then((r) => r.json())).toEqual({ allowed: true });
  });

  it("reserves a named thread's spend on its account's base session", async () => {
    const fetchBase = vi.fn(async () => Response.json({ allowed: false }));
    vi.mocked(getAgentByName).mockResolvedValue({ fetch: fetchBase } as never);
    const { instance } = orchestrator({ name: "web:owner:11111111-1111-4111-8111-111111111111", messages: [message("1", "user", "Hi")] });
    const response = await instance.onRequest(post("/agents/coding-orchestrator/web%3Aowner%3A11111111-1111-4111-8111-111111111111/chat-suggestions"));
    expect(await response.json()).toEqual({ suggestions: [] });
    expect(getAgentByName).toHaveBeenCalledWith(expect.anything(), "owner");
    expect(fetchBase).toHaveBeenCalledWith("https://internal/internal/chat-suggestion-quota", { method: "POST" });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("refuses a lane that is not the dashboard before touching quota or the model", async () => {
    const setState = vi.fn();
    const { instance } = orchestrator({ name: "den:abc", state: {}, setState });
    const response = await instance.onRequest(post("/agents/coding-orchestrator/den%3Aabc/chat-suggestions"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Chat suggestions are unavailable on this surface." });
    expect(setState).not.toHaveBeenCalled();
    expect(getAgentByName).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  it("bounds spend across isolates even though reuse stays inside one", async () => {
    const state: Record<string, unknown> = {};
    const first = orchestrator({ name: "owner", state, setState: (next: unknown) => Object.assign(state, next) }).instance;
    const second = orchestrator({ name: "owner", state, setState: (next: unknown) => Object.assign(state, next) }).instance;
    const ask = async (target: CodingOrchestrator, turn: string) => {
      (target as unknown as { messages: UIMessage[] }).messages = [message(turn, "user", `Turn ${turn}`)];
      return target.onRequest(post());
    };
    for (let index = 0; index < CHAT_SUGGESTION_LIMIT; index += 1) {
      await ask(index % 2 ? first : second, String(index));
    }
    expect(generateText).toHaveBeenCalledTimes(CHAT_SUGGESTION_LIMIT);
    await ask(second, "over");
    expect(generateText).toHaveBeenCalledTimes(CHAT_SUGGESTION_LIMIT);
  });

  it("serves the caller's own thread through the Worker and refuses another owner", async () => {
    const fetchThread = vi.fn(async (request: Request) => Response.json({ forwarded: new URL(request.url).pathname, method: request.method, suggestions: [] }));
    vi.mocked(getAgentByName).mockResolvedValue({ fetch: fetchThread } as never);
    const env = { CodingOrchestrator: {} } as Env;
    const context = (path: string, user: string, init: RequestInit = {}): RequestContext => {
      const request = new Request(`https://shiba.test${path}`, init);
      return { request, env, url: new URL(request.url), identity: async () => user };
    };
    const own = await handlers.agents(context("/agents/coding-orchestrator/owner/chat-suggestions", "owner", { method: "POST", headers: originHeaders, body: "{}" }));
    expect(own?.status).toBe(200);
    expect(await own?.json()).toEqual({ forwarded: "/agents/coding-orchestrator/owner/chat-suggestions", method: "POST", suggestions: [] });
    expect(fetchThread).toHaveBeenCalledOnce();

    const foreign = await handlers.agents(context("/agents/coding-orchestrator/someone-else/chat-suggestions", "owner", { method: "POST", headers: originHeaders, body: "{}" }));
    expect(foreign?.status).toBe(403);
    expect(fetchThread).toHaveBeenCalledOnce();
  });
});
