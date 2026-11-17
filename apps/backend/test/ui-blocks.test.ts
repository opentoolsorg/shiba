import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import type { McpToolHandler, ToolCallContext, ToolRegistry } from "../src/mcp-gateway.js";
import { answerUiBlock, createUiBlock, getUiBlock, listUiBlocks } from "../src/ui-block-store.js";
import { handleUiBlocks } from "../src/ui-block-routes.js";
import { isAuthorizedRequest } from "../src/request-auth.js";
import { registerAskUiTool, type AskUiDependencies } from "../src/tools/ask-ui.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

vi.mock("../src/request-auth.js", () => ({ isAuthorizedRequest: vi.fn(async () => true) }));
vi.mock("../src/runs-routes.js", () => ({ resolveRunStoreTarget: async () => ({ userId: "owner" }) }));

const block = { version: 1, id: "question", type: "quick_replies", prompt: "Next?", options: [{ id: "keep", label: "Keep" }, { id: "delete", label: "Delete", danger: true }] };
const answer = { blockId: block.id, optionIds: ["keep"] };
const close: (() => void)[] = [];
afterEach(() => { close.splice(0).forEach((fn) => fn()); vi.clearAllMocks(); });

function fixture() {
  const { database, sqlite } = customAgentD1({ bare: true });
  sqlite.exec(readFileSync(new URL("../migrations/0061_ui_block_questions.sql", import.meta.url), "utf8"));
  close.push(() => sqlite.close());
  const fetch = vi.fn(async () => Response.json({ ok: true }));
  const env = { AGENT_AUDIT: database, CodingOrchestrator: { getByName: () => ({ fetch }) }, WorkspaceEvents: { getByName: () => ({ fetch }) } } as unknown as Env;
  return { env, sqlite, fetch };
}

function tool(env: Env, deps: AskUiDependencies = {}) {
  let handler: McpToolHandler | undefined;
  const registerTool = vi.fn((_name, _scope, fn: McpToolHandler) => { handler = fn; });
  registerAskUiTool({ registerTool } as unknown as ToolRegistry, env, deps);
  const context = { env, principal: { principal: "agent", scopes: ["api:write"], created: 0, revoked: false } } as ToolCallContext;
  return { call: async (args: Record<string, unknown> = block) => handler!(args, context), registerTool };
}

describe("UI block store", () => {
  it("lists unsupported stored blocks with their fallback without hiding supported questions", async () => {
    const { env, sqlite } = fixture();
    await createUiBlock(env, "owner", "thread:ui-task:first", block);
    await createUiBlock(env, "owner", "thread:ui-task:second", block);
    sqlite.prepare("UPDATE ui_block_questions SET block_json=? WHERE run_id=?").run(JSON.stringify({ ...block, version: 99, type: "future" }), "thread:ui-task:first");
    const listed = await handleUiBlocks(new Request("https://example.test/api/runs/thread/ui-blocks"), env);
    expect(listed?.status).toBe(200);
    const body = await listed!.json() as { questions: { runId: string; block: unknown; fallbackText: string }[] };
    expect(body.questions).toHaveLength(2);
    expect(body.questions.find((question) => question.runId === "thread:ui-task:first")).toMatchObject({ block: null, fallbackText: expect.stringContaining("Next?") });
    expect(body.questions.find((question) => question.runId === "thread:ui-task:second")?.block).toEqual(block);
    const response = await handleUiBlocks(new Request("https://example.test/api/runs/thread%3Aui-task%3Afirst/ui-blocks/question/answer", { method: "POST", headers: { Origin: "https://example.test", "Content-Type": "application/json" }, body: JSON.stringify(answer) }), env);
    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({ error: "unsupported_block" });
  });
  it("creates once, replays identical blocks, and isolates owner/run scopes", async () => {
    const { env, sqlite } = fixture();
    expect((await createUiBlock(env, "owner", "run", block)).created).toBe(true);
    expect((await createUiBlock(env, "owner", "run", { ...block })).created).toBe(false);
    expect(sqlite.prepare("SELECT count(*) AS n FROM ui_block_questions").get()).toEqual({ n: 1 });
    expect(await getUiBlock(env, "other", "run", block.id)).toBeNull();
    expect(await getUiBlock(env, "owner", "other", block.id)).toBeNull();
    expect(await listUiBlocks(env, "owner", "run")).toHaveLength(1);
    expect(await listUiBlocks(env, "owner", "empty")).toEqual([]);
    await expect(createUiBlock(env, "owner", "run", { ...block, id: "other" })).rejects.toMatchObject({ status: 409 });
    await expect(createUiBlock(env, "owner", "run", { ...block, prompt: "Changed" })).rejects.toMatchObject({ status: 409 });
    await expect(createUiBlock(env, "owner", "run", { ...block, prompt: "<b>Bad</b>" })).rejects.toMatchObject({ status: 400 });
  });

  it("validates, answers conditionally, and never overwrites the first answer", async () => {
    const { env } = fixture();
    await createUiBlock(env, "owner", "run", block, 10);
    await expect(answerUiBlock(env, "owner", "run", block.id, { blockId: block.id, optionIds: ["delete"] }, "web")).rejects.toMatchObject({ status: 400, errors: ["danger_requires_confirm"] });
    const result = await answerUiBlock(env, "owner", "run", block.id, answer, "web", 20);
    expect(result.receipt).toMatchObject({ kind: "ui_block.answered", answer, answeredVia: "web", at: 20 });
    await expect(answerUiBlock(env, "owner", "run", block.id, answer, "slack")).rejects.toMatchObject({ status: 409 });
    expect(await getUiBlock(env, "owner", "run", block.id)).toMatchObject({ status: "answered", answer, answeredVia: "web" });
    expect(await listUiBlocks(env, "owner", "run")).toEqual([]);
    expect(await listUiBlocks(env, "owner", "run", true)).toHaveLength(1);
    expect((await createUiBlock(env, "owner", "run", block)).question.status).toBe("answered");
    await createUiBlock(env, "owner", "run", { ...block, id: "next" });
    expect(await listUiBlocks(env, "owner", "run", true)).toHaveLength(2);
    await expect(answerUiBlock(env, "other", "run", block.id, answer, "web")).rejects.toMatchObject({ status: 404 });
  });

  it("the conditional write rejects a racing second answer", async () => {
    const { env } = fixture();
    await createUiBlock(env, "owner", "run", block);
    const outcomes = await Promise.allSettled([answerUiBlock(env, "owner", "run", block.id, answer, "web"), answerUiBlock(env, "owner", "run", block.id, answer, "slack")]);
    expect(outcomes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { status: 409 } });
  });
});

describe("ask_ui tool", () => {
  it("fails closed without trusted run context and reports schema errors", async () => {
    const { env, sqlite } = fixture();
    const { call } = tool(env);
    expect(await call()).toMatchObject({ isError: true, structuredContent: { error: "ask_ui_requires_run" } });
    expect(await call({ ...block, prompt: "<script>" })).toMatchObject({ isError: true, structuredContent: { error: "invalid_ui_block", errors: expect.any(Array) } });
    expect(sqlite.prepare("SELECT count(*) AS n FROM ui_block_questions").get()).toEqual({ n: 0 });
  });

  it("returns pending, then polls the same question to an answer without duplicates", async () => {
    const { env, sqlite, fetch } = fixture();
    const resolveRunContext = () => ({ ownerId: "owner", runId: "run", workspaceId: "workspace" });
    const first = tool(env, { resolveRunContext, waitMs: 0 });
    expect(await first.call()).toMatchObject({ structuredContent: { status: "pending", blockId: block.id, instruction: expect.stringContaining("do not proceed") } });
    const next = tool(env, { resolveRunContext, waitMs: 10, pollMs: 10, sleep: async () => { await answerUiBlock(env, "owner", "run", block.id, answer, "web"); } });
    expect(await next.call()).toMatchObject({ structuredContent: { status: "answered", answer } });
    expect(await next.call()).toMatchObject({ structuredContent: { status: "answered", answer } });
    expect(sqlite.prepare("SELECT count(*) AS n FROM ui_block_questions").get()).toEqual({ n: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = fetch.mock.calls[0] as unknown as [Request];
    expect(await request[0].json()).toMatchObject({ kind: "ui_block.asked", audience: { userIds: ["owner"] } });
  });

  it("bounds waiting and handles cancelled questions and unavailable storage", async () => {
    const { env, sqlite } = fixture();
    let time = 0;
    const sleep = vi.fn(async (ms: number) => { time += ms; });
    const resolveRunContext = () => ({ ownerId: "owner", runId: "run" });
    expect(await tool(env, { resolveRunContext, waitMs: 20, pollMs: 10, now: () => time, sleep }).call()).toMatchObject({ structuredContent: { status: "pending" } });
    expect(sleep).toHaveBeenCalledTimes(2);
    sqlite.exec("UPDATE ui_block_questions SET status='cancelled'");
    expect(await tool(env, { resolveRunContext }).call()).toMatchObject({ isError: true, structuredContent: { error: "question_cancelled" } });
    expect(await tool({} as Env, { resolveRunContext }).call()).toMatchObject({ isError: true });
  });
});

function request(path = "question/answer", body: unknown = answer, origin = "https://shiba.test") {
  return new Request(`https://shiba.test/api/runs/run/ui-blocks/${path}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("UI block routes", () => {
  it("requires authentication before reading or answering questions", async () => {
    const { env, fetch } = fixture();
    vi.mocked(isAuthorizedRequest).mockResolvedValueOnce(false);
    expect((await handleUiBlocks(new Request("https://shiba.test/api/runs/run/ui-blocks"), env))?.status).toBe(401);
    vi.mocked(isAuthorizedRequest).mockResolvedValueOnce(false);
    expect((await handleUiBlocks(request(), env))?.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unsafe answers and returns 404/409, without resolving approvals", async () => {
    const { env, fetch } = fixture();
    await createUiBlock(env, "owner", "run", block);
    const rejected = await handleUiBlocks(request(undefined, { blockId: block.id, optionIds: ["delete"] }), env);
    expect(rejected?.status).toBe(400);
    expect(await rejected!.json()).toMatchObject({ errors: ["danger_requires_confirm"] });
    expect((await handleUiBlocks(request("missing/answer"), env))?.status).toBe(404);
    expect((await handleUiBlocks(request(undefined, answer, "https://evil.test"), env))?.status).toBe(403);
    const accepted = await handleUiBlocks(request(), env);
    expect(accepted?.status).toBe(200);
    expect(await accepted!.json()).toMatchObject({ receipt: { answer, answeredVia: "web" } });
    expect((await handleUiBlocks(request(), env))?.status).toBe(409);
    // No DO request at all: answering cannot reach /api/approvals or its resolver.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lists pending and recent answered questions with fallback text", async () => {
    const { env } = fixture();
    const get = () => handleUiBlocks(new Request("https://shiba.test/api/runs/run/ui-blocks"), env);
    expect(await (await get())!.json()).toEqual({ ok: true, questions: [] });
    await createUiBlock(env, "owner", "run", block);
    expect(await (await get())!.json()).toMatchObject({ questions: [{ status: "pending", fallbackText: expect.stringContaining("Reply with the number(s)") }] });
    await answerUiBlock(env, "owner", "run", block.id, answer, "fallback");
    expect(await (await get())!.json()).toMatchObject({ questions: [{ status: "answered", answeredVia: "fallback" }] });
    expect(await handleUiBlocks(new Request("https://shiba.test/unrelated"), env)).toBeNull();
    expect((await handleUiBlocks(new Request("https://shiba.test/api/runs/run/ui-blocks", { method: "DELETE" }), env))?.status).toBe(405);
    const malformed = new Request("https://shiba.test/api/runs/run/ui-blocks/question/answer", { method: "POST", headers: { origin: "https://shiba.test" }, body: "{" });
    expect((await handleUiBlocks(malformed, env))?.status).toBe(400);
  });
});
