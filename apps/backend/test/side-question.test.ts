import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateText, type LanguageModel, type UIMessage } from "ai";
import { getAgentByName } from "agents/routing";
import { answerSideQuestion, sideQuestionSchema } from "../src/side-question.js";
import { handleSideQuestion } from "../src/side-question-routes.js";
import { isAuthorizedRequest } from "../src/request-auth.js";
import { getCustomAgentById } from "../src/custom-agents-store.js";
import type { Env } from "../src/env.js";

vi.mock("ai", () => ({ generateText: vi.fn() }));
vi.mock("agents/routing", () => ({ getAgentByName: vi.fn() }));
vi.mock("../src/request-auth.js", () => ({ isAuthorizedRequest: vi.fn(async () => true), resolveUserId: async () => "owner" }));
vi.mock("../src/custom-agents-store.js", () => ({ getCustomAgentById: vi.fn(async () => ({ config: { instructions: "You are Scout." } })) }));

const threadId = "11111111-1111-4111-8111-111111111111";
const env = { CodingOrchestrator: {} } as Env;
const input = { question: "Progress?", threadId, earlier: [] };
const model = {} as LanguageModel;
const send = (body: unknown = input, headers = {}) => handleSideQuestion(new Request("http://localhost/api/employees/scout/side-question", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }), env);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAuthorizedRequest).mockResolvedValue(true);
  vi.mocked(generateText).mockResolvedValue({ text: "Working on tests." } as never);
});

describe("stateless side questions", () => {
  it("uses the resolved chat model, profile, last 25 messages and earlier answers without changing the thread", async () => {
    const tail = Array.from({ length: 30 }, (_, i) => ({ id: String(i), role: "user", parts: [{ type: "text", text: String(i) }] })) as UIMessage[];
    const original = JSON.stringify(tail);
    const resolve = vi.fn(() => model);
    const response = await answerSideQuestion({ ...input, earlier: [{ question: "Earlier?", answer: "Yes." }] }, "You are Scout.", tail, resolve);
    expect(await response.json()).toEqual({ answer: "Working on tests." });
    expect(resolve).toHaveBeenCalledOnce();
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({ model, system: "You are Scout.", tools: {}, messages: expect.arrayContaining([{ role: "user", content: "5" }, { role: "assistant", content: "Yes." }, { role: "user", content: "Progress?" }]) }));
    const options = vi.mocked(generateText).mock.calls[0]![0];
    expect(options.messages).toHaveLength(28);
    expect(JSON.stringify(tail)).toBe(original);
    expect(getAgentByName).not.toHaveBeenCalled();
    expect(getCustomAgentById).not.toHaveBeenCalled();
  });
  it("answers with empty thread context", async () => {
    expect((await answerSideQuestion(input, "", [], () => model)).status).toBe(200);
    expect(vi.mocked(generateText).mock.calls[0]![0].messages).toEqual([{ role: "user", content: "Progress?" }]);
  });
  it.each([{ statusCode: 429 }, { statusCode: 529 }, { lastError: { statusCode: 429 } }, { message: "rate limit exceeded" }, { message: "overloaded" }, { message: "concurrency limit" }])("maps provider busy errors to readable 409: %j", async (error) => {
    vi.mocked(generateText).mockRejectedValue(error);
    const response = await answerSideQuestion(input, "Scout", [], () => model);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: expect.stringContaining("Please try again") });
  });
  it("hides other provider errors", async () => {
    vi.mocked(generateText).mockRejectedValue(new Error("private provider detail"));
    const response = await answerSideQuestion(input, "Scout", [], () => model);
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("private provider detail");
  });
  it("rejects more than 20 earlier pairs and invalid questions", () => {
    const pair = { question: "q", answer: "a" };
    expect(sideQuestionSchema.safeParse({ ...input, earlier: Array(20).fill(pair) }).success).toBe(true);
    for (const bad of [{ ...input, earlier: Array(21).fill(pair) }, { ...input, question: " " }, { ...input, question: "x".repeat(4001) }]) expect(sideQuestionSchema.safeParse(bad).success).toBe(false);
  });
});

describe("side-question ownership", () => {
  function registry(overrides = {}) {
    const read = vi.fn(async () => Response.json({ session: { id: threadId, userId: "owner", metadata: { customAgentId: "scout" }, ...overrides } }));
    const infer = vi.fn(async (_request: Request) => Response.json({ answer: "Answer" }));
    vi.mocked(getAgentByName).mockImplementation(async (_namespace, name) => ({ fetch: name === "owner" ? read : infer }) as never);
    return { read, infer };
  }
  it("only reads registry/profile and forwards to the owned thread's stateless endpoint", async () => {
    const { read, infer } = registry();
    expect((await send())?.status).toBe(200);
    expect(read).toHaveBeenCalledWith(`https://internal/internal/web-sessions/${threadId}`);
    expect(infer).toHaveBeenCalledOnce();
    expect(getCustomAgentById).toHaveBeenCalledWith(env, "self-hosted", "scout", {});
    const request = infer.mock.calls[0]![0] as unknown as Request;
    expect(new URL(request.url).pathname).toBe("/internal/side-question");
    expect(await request.json()).toEqual({ ...input, instructions: "You are Scout." });
  });
  it("requires authentication before accessing storage", async () => {
    vi.mocked(isAuthorizedRequest).mockResolvedValue(false);
    expect((await send())?.status).toBe(401);
    expect(getAgentByName).not.toHaveBeenCalled();
  });
  it.each([{ userId: "other" }, { id: "wrong" }, { metadata: { customAgentId: "other" } }, { metadata: { customAgentId: "scout", teamWorkspaceId: "team" } }])("rejects inaccessible threads %j", async (overrides) => {
    const { infer } = registry(overrides);
    expect((await send())?.status).toBe(404);
    expect(infer).not.toHaveBeenCalled();
  });
  it("rejects API credentials and workspace selectors", async () => {
    for (const headers of [{ authorization: "Bearer token" }, { "X-Shiba-Workspace": "team" }]) expect((await send(input, headers))?.status).toBe(403);
    expect(getAgentByName).not.toHaveBeenCalled();
  });
  it("rejects invalid input before reading storage", async () => {
    expect((await send({ ...input, earlier: Array(21).fill({ question: "q", answer: "a" }) }))?.status).toBe(400);
    expect(getAgentByName).not.toHaveBeenCalled();
  });
  it("reads the profile without any D1 writes", async () => {
    const actual = await vi.importActual<typeof import("../src/custom-agents-store.js")>("../src/custom-agents-store.js");
    const run = vi.fn(() => { throw new Error("Unexpected write"); });
    const first = vi.fn(async () => ({ id: "scout", org_id: "self-hosted", slug: "scout", version: 1, config_json: JSON.stringify({ instructions: "Scout" }), created_at: 1, updated_at: 1 }));
    const prepare = vi.fn(() => ({ bind: () => ({ first, run }), run }));
    const profile = await actual.getCustomAgentById({ AGENT_AUDIT: { prepare } } as unknown as Env, "self-hosted", "scout", {});
    expect(profile?.config.instructions).toBe("Scout");
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith(expect.stringMatching(/^SELECT /));
    expect(run).not.toHaveBeenCalled();
  });
});
