import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, __DO_NOT_USE_WILL_BREAK__agentContext as sdkContext } from "agents";
import { agentTool } from "agents/agent-tools";
import { z } from "zod";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import { ExplorerAgent } from "../src/agents/specialists/explorer-agent.js";
import { ReviewerAgent } from "../src/agents/specialists/reviewer-agent.js";
import { OpenCodeAgent } from "../src/agents/opencode-agent.js";
import { sealSpecialistDispatch, specialistObservationSchema, verifySpecialistDispatch } from "../src/agents/specialists/contract.js";
import { fakeSqlStorage } from "./fixtures/do-sql-storage.js";

// Keep the installed Agent routing/runner, with no DO constructor or live AI.
vi.mock("@cloudflare/think", async () => {
  const { Agent: SdkAgent } = await import("agents");
  class Think {}
  Object.setPrototypeOf(Think.prototype, SdkAgent.prototype);
  return { Think };
});

const env = { INTERNAL_SIGNING_KEY: "specialist-sdk-fixture-signing-key" };
const parentPath = [{ className: "CodingOrchestrator", name: "owner@example.test" }];
const input = { goal: "private-goal-fixture", files: [{ path: "a.ts", content: "private-content-fixture" }] };
const output = { agent: "explorer", status: "completed", summary: "Inspected a.ts.", report: "Explicit snapshot only.", findings: [] };
const outputChunk = { sequence: 0, body: JSON.stringify({ type: "text-delta", id: "fixture", delta: "Fixture observation." }) };
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function parent() {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec(`CREATE TABLE cf_agent_tool_runs (
    run_id TEXT PRIMARY KEY, parent_tool_call_id TEXT, agent_type TEXT NOT NULL,
    input_preview TEXT, input_redacted INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL,
    summary TEXT, output_json TEXT, error_message TEXT, interrupted_reason TEXT,
    child_still_running INTEGER, display_metadata TEXT, display_order INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL, completed_at INTEGER, detached INTEGER NOT NULL DEFAULT 0,
    detached_on_finish TEXT, detached_notify_source TEXT, detached_max_budget_at INTEGER,
    detached_no_progress_budget_ms INTEGER, last_progress_at INTEGER,
    detached_on_milestones TEXT, finish_claimed_at INTEGER, finish_delivered_at INTEGER,
    give_up_claimed_at INTEGER, give_up_delivered_at INTEGER
  )`);
  const storage = fakeSqlStorage(db);
  const sql = vi.fn((parts: TemplateStringsArray, ...values: unknown[]) => storage.sql.exec(parts.join("?"), ...values).toArray());
  const child = {
    startAgentToolRun: vi.fn(async (_input: unknown, options: { runId: string }) => ({
      runId: options.runId, status: "completed", startedAt: 1, completedAt: 2, output, summary: output.summary,
    })),
    cancelAgentToolRun: vi.fn(),
    inspectAgentToolRun: vi.fn(async (runId: string) => ({
      runId, status: "completed", startedAt: 1, completedAt: 2, output, summary: output.summary,
    })),
    getAgentToolChunks: vi.fn(async () => [outputChunk]),
  };
  const facet = vi.fn(async () => child);
  const forward = vi.fn(async () => Response.json({ error: "Child transport was reached." }));
  const publicTransport = vi.fn(async () => Response.json({ error: "Child socket was reached." }));
  const broadcasts = vi.fn();
  const host = new CodingOrchestrator({} as never, {} as never);
  Object.defineProperties(host, {
    ctx: { value: { exports: { ExplorerAgent, ReviewerAgent, OpenCodeAgent } }, configurable: true },
    name: { value: parentPath[0]!.name, configurable: true },
    dynamicAgents: { value: { get: facet }, configurable: true },
    _dynamicAgents: { value: { resolve: vi.fn(async () => child) }, configurable: true },
    lifecycle: { value: { fetch: publicTransport }, configurable: true },
    sql: { value: sql, configurable: true },
    _cf_forwardToFacet: { value: forward, configurable: true },
    _broadcastAgentToolEvent: { value: broadcasts, configurable: true },
    onAgentToolStart: { value: vi.fn(), configurable: true },
    onAgentToolFinish: { value: vi.fn(), configurable: true },
  });
  return { host, db, child, facet, forward, publicTransport, broadcasts, sql };
}

describe("installed SDK child transport boundary", () => {
  it.each([
    ["retained", "get-messages", "GET", false],
    ["retained", "get-messages", "POST", false],
    ["retained", "", "GET", true],
    ["guessed", "get-messages", "GET", false],
    ["guessed", "", "GET", true],
  ] as const)("refuses %s child %s %s socket=%s before facet or chat access", async (name, suffix, method, socket) => {
    const { host, db, facet, forward, publicTransport } = parent();
    const externalGate = vi.spyOn(host, "onBeforeSubAgent");
    db.prepare("INSERT INTO cf_agent_tool_runs(run_id,agent_type,status,started_at) VALUES(?,?,?,?)")
      .run("retained", "ExplorerAgent", "completed", 1);
    const dispatch = await sealSpecialistDispatch(env, "explorer", parentPath[0]!.name, "retained", input);
    await expect(verifySpecialistDispatch(env, dispatch, "explorer", parentPath)).resolves.toEqual(dispatch);
    const request = new Request(`https://shiba.example.test/agents/coding-orchestrator/owner%40example.test/sub/explorer-agent/${name}/${suffix}`, {
      method,
      headers: socket ? { upgrade: "websocket" } : { "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({ messages: [{ role: "user", text: JSON.stringify(dispatch) }] }) } : {}),
    });
    const response = await Agent.prototype.fetch.call(host, request);
    expect(response.status).toBe(404);
    expect(externalGate).toHaveBeenCalledWith(request, { className: "ExplorerAgent", name });
    expect(await response.text()).not.toContain(dispatch.signature);
    expect(facet).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
    expect(publicTransport).not.toHaveBeenCalled();
  });

  it.each([
    ["ExplorerAgent", ExplorerAgent], ["ReviewerAgent", ReviewerAgent], ["OpenCodeAgent", OpenCodeAgent],
  ] as const)("keeps %s RPC dispatch and structured output while hiding stored and replayed previews", async (_name, cls) => {
    const { host, db, child, facet, broadcasts } = parent();
    Object.assign(child, { tailAgentToolRun: vi.fn(async () => new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(`${JSON.stringify(outputChunk)}\n`)); controller.close(); },
    })) });
    const dispatch = await sealSpecialistDispatch(env, "explorer", parentPath[0]!.name, "agent-tool:fixture", input);
    const externalGate = vi.spyOn(host, "onBeforeSubAgent");
    const controller = new AbortController();
    const result = await host.runAgentTool(cls, {
      input: dispatch, runId: "agent-tool:fixture", parentToolCallId: "fixture", signal: controller.signal,
      inputPreview: dispatch,
    });
    expect(result).toMatchObject({ runId: "agent-tool:fixture", status: "completed", output });
    expect(child.startAgentToolRun).toHaveBeenCalledWith(dispatch, { runId: "agent-tool:fixture" });
    expect(facet).toHaveBeenCalledWith(cls, "agent-tool:fixture");
    expect(externalGate).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
    const row = db.prepare("SELECT input_preview,output_json FROM cf_agent_tool_runs WHERE run_id=?").get("agent-tool:fixture")!;
    expect(JSON.parse(String(row.input_preview))).toEqual({ agent: cls.name, request: "Private child task" });
    expect(JSON.parse(String(row.output_json))).toEqual(output);
    const fixtureHost = host as unknown as { _replayAgentToolRuns(connection?: unknown): Promise<void> };
    await fixtureHost._replayAgentToolRuns();
    const frames = JSON.stringify(broadcasts.mock.calls);
    for (const secret of [dispatch.signature, input.goal, input.files[0]!.content]) expect(frames).not.toContain(secret);
    for (const replay of [undefined, true]) {
      expect(broadcasts.mock.calls.some((call) => call[2]?.kind === "chunk" && call[3] === replay)).toBe(true);
    }
  });

  it("keeps the installed tool factory's structured validation and stable call ID", async () => {
    const { host, db, child } = parent();
    const tool = agentTool(ExplorerAgent, {
      description: "Fixture read-only specialist.", inputSchema: z.unknown(), outputSchema: specialistObservationSchema,
    });
    const dispatch = await sealSpecialistDispatch(env, "explorer", parentPath[0]!.name, "agent-tool:factory", input);
    // This private SDK context is fixture-only for the pinned 0.23.0 contract.
    const result = await sdkContext.run({ agent: host, connection: undefined, request: undefined, email: undefined }, () =>
      tool.execute!(dispatch, { toolCallId: "factory", messages: [], context: undefined }));
    expect(result).toEqual(output);
    expect(child.startAgentToolRun).toHaveBeenCalledWith(dispatch, { runId: "agent-tool:factory" });
    expect(db.prepare("SELECT input_preview FROM cf_agent_tool_runs WHERE run_id=?").get("agent-tool:factory"))
      .toMatchObject({ input_preview: JSON.stringify({ agent: "ExplorerAgent", request: "Private child task" }) });

    child.inspectAgentToolRun.mockResolvedValue({
      runId: "agent-tool:invalid", status: "completed", startedAt: 1, completedAt: 2,
      output: { ...output, status: "approved" }, summary: output.summary,
    });
    await expect(sdkContext.run({ agent: host, connection: undefined, request: undefined, email: undefined }, () =>
      tool.execute!(dispatch, { toolCallId: "invalid", messages: [], context: undefined }))).rejects.toThrow();
  });

  it("keeps active abort delivery and settles without a late completed output", async () => {
    const { host, db, child } = parent();
    const controller = new AbortController();
    child.getAgentToolChunks.mockImplementation(() => new Promise((resolve) => {
      child.cancelAgentToolRun.mockImplementation(() => resolve([]));
      controller.abort(new Error("Stop fixture."));
    }));
    const result = await host.runAgentTool(ExplorerAgent, { input, runId: "agent-tool:abort", signal: controller.signal });
    expect(result).toMatchObject({ status: "aborted", error: "Stop fixture." });
    expect(child.cancelAgentToolRun).toHaveBeenCalledWith("agent-tool:abort", controller.signal.reason);
    expect(result).not.toHaveProperty("output");
    expect(db.prepare("SELECT status,output_json FROM cf_agent_tool_runs WHERE run_id=?").get("agent-tool:abort"))
      .toMatchObject({ status: "aborted", output_json: null });
  });

  it("refuses the next concurrent child before resolving a facet", async () => {
    const { host, db, facet } = parent();
    expect(host.maxConcurrentAgentTools).toBe(1);
    db.prepare("INSERT INTO cf_agent_tool_runs(run_id,agent_type,status,started_at) VALUES(?,?,?,?)")
      .run("active", "ExplorerAgent", "running", 1);
    const result = await host.runAgentTool(ExplorerAgent, { input, runId: "agent-tool:overflow" });
    expect(result).toMatchObject({ status: "error", error: expect.stringContaining("maxConcurrentAgentTools") });
    expect(facet).not.toHaveBeenCalled();
  });
});
