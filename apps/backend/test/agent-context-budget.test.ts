import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { ToolSet } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import { sealSpecialistDispatch } from "../src/agents/specialists/contract.js";
import { ExplorerAgent } from "../src/agents/specialists/explorer-agent.js";
import { ReviewerAgent } from "../src/agents/specialists/reviewer-agent.js";
import { SCOPES, type TokenRecord } from "../src/agent-tokens.js";
import { CHAT_CREATE_TOOLS, CHAT_OPT_IN_TOOLS } from "../src/conversation-mode.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { replaceEmployeeToolGrants } from "../src/employee-tool-store.js";
import type { Env } from "../src/env.js";
import { createExtensionSkill } from "../src/extension-skills-store.js";
import { tokenizeCommand } from "../src/exec-allowlist.js";
import { resolveHarness } from "../src/harness/index.js";
import { createShibaMcpHandler, encodePrincipal, MCP_PRINCIPAL_HEADER } from "../src/mcp-gateway.js";
import { createWebSession } from "../src/web-sessions.js";
import { resetLazyRunCodeCacheForTests } from "../src/run-code-lazy.js";
import { LocalRuntimeAdapter, SandboxRuntimeAdapter, type LocalDispatchClient, type SandboxOps } from "../src/runtime.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { preparedGoal } from "./fixtures/onboarding-goal.js";
import limits from "./fixtures/agent-context-budgets.json";
import { repositorySnapshotFixture } from "./repository-snapshot-fixture.js";

const sessions = vi.hoisted(() => new Map<string, unknown[]>());
vi.mock("agents/routing", () => ({
  getAgentByName: async (_binding: unknown, ownerId: string) => ({
    fetch: async () => Response.json({ sessions: sessions.get(ownerId) ?? [] }),
  }),
}));

const workerModules = await vi.hoisted(async () => {
  const { registerHooks, stripTypeScriptTypes } = await import("node:module");
  const { readFileSync } = await import("node:fs");
  const stub = new URL("./cloudflare-stub.ts", import.meta.url);
  return registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith("cloudflare:")) {
        return { url: stub.href, shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url === stub.href) {
        return { format: "module", source: stripTypeScriptTypes(readFileSync(stub, "utf8"), { mode: "transform" }), shortCircuit: true };
      }
      return next(url, context);
    },
  });
});

afterAll(() => workerModules.deregister());

beforeEach(() => {
  const fail = () => { throw new Error("Context budget fixtures do not use the network."); };
  vi.stubGlobal("fetch", vi.fn(fail));
});
afterEach(() => {
  const attempts = vi.mocked(fetch).mock.calls.length;
  sessions.clear();
  resetLazyRunCodeCacheForTests();
  vi.unstubAllGlobals();
  expect(attempts, "Context budget fixtures must never attempt a network request.").toBe(0);
});

const owner = "owner@example.test";
const org = "self-hosted";
const loader = new Proxy({} as NonNullable<Env["LOADER"]>, {
  get() { throw new Error("Context budget fixtures never load an execution worker."); },
});

function coordinator({
  metadata = {}, env = {}, name = owner, text = "Fixture: café", screen = false,
  resizeTool,
}: {
  metadata?: Record<string, unknown>; env?: Partial<Env>; name?: string; text?: string;
  screen?: boolean; resizeTool?: string;
} = {}) {
  const host: CodingOrchestrator = Object.create(CodingOrchestrator.prototype);
  Object.defineProperties(host, {
    env: { value: env },
    name: { value: name },
    state: { value: { runs: screen ? [{ status: "running", computer: true }] : [] } },
    ctx: { value: { id: "context-budget" } },
    workspace: { value: {} },
    context: { value: { tools: () => ({}), freezeSystemPrompt: () => "" } },
    messages: { value: [{ role: "user", id: "fixture", metadata, parts: [{ type: "text", text }] }] },
    workspaceBash: { value: false },
    includeMcpTools: { value: true },
    maxSteps: { value: 1 },
  });
  if (resizeTool) {
    const getTools = host.getTools.bind(host);
    Object.defineProperty(host, "getTools", { value: (): ToolSet => {
      const tools = getTools();
      const selected = tools[resizeTool];
      if (!selected) throw new Error("Synthetic tool mutation did not reach a registered tool.");
      Object.assign(selected, { description: "界".repeat(16_000) });
      return tools;
    } });
  }
  return host;
}

async function captureTurn(host: CodingOrchestrator) {
  const parts: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "response" },
    { type: "text-delta", id: "response", delta: "Done" },
    { type: "text-end", id: "response" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 } } },
  ];
  const model = new MockLanguageModelV4({ doStream: async () => ({
    stream: simulateReadableStream({ chunks: parts, initialDelayInMs: null, chunkDelayInMs: null }),
  }) });
  Object.defineProperty(host, "resolveModel", { value: () => model, configurable: true });
  await executeTurn(host);
  const [call, extra] = model.doStreamCalls;
  if (!call || extra) throw new Error("Expected exactly one model call from the fixture turn.");
  return call;
}

async function executeTurn(host: CodingOrchestrator) {
  expect(await host.configureContext()).toEqual([]);
  expect(await host.configureChannels()).toEqual({});
  expect(await host.getSkills()).toEqual([]);
  expect(host.getExtensions()).toEqual([]);
  const prepare = host as unknown as { _prepareInferenceInvocation(input: object): Promise<() => {
    toUIMessageStream(options: { onError(error: unknown): string }): AsyncIterable<unknown>;
  }> };
  const invoke = await prepare._prepareInferenceInvocation({});
  for await (const chunk of invoke().toUIMessageStream({ onError: (error) => String(error) })) {
    if (typeof chunk === "object" && chunk !== null && "type" in chunk && chunk.type === "error") {
      throw new Error("The offline coordinator returned an inference error.");
    }
  }
}

const supportedVideo = {
  SHIBA_VIDEO_GENERATION: "1", SHIBA_VIDEO_BACKEND: "google",
  ARTIFACTS: {}, FILES: {}, AGENT_AUDIT: {}, AGENT_TOKENS: {}, MODEL_CREDENTIAL_KEY: "offline-fixture",
} as unknown as Partial<Env>;

async function employeeCases(env: Env) {
  const capability = "mcp:shiba:run_status";
  const profile = { name: "Fixture employee", instructions: "Use the supplied facts", harness: "opencode" } as const;
  const legacy = await createCustomAgent(env, org, "legacy", profile);
  const revoked = await createCustomAgent(env, org, "revoked", { ...profile, toolScopes: [] });
  const granted = await createCustomAgent(env, org, "granted", { ...profile, toolScopes: [capability] });
  await replaceEmployeeToolGrants(env, {
    orgId: org, employeeId: granted.id, employeeVersion: granted.version,
    actorId: owner, role: "member", capabilityIds: [capability], resourcesByCapability: { [capability]: ["run-fixture"] },
  });
  const session = createWebSession(owner, { metadata: { customAgentId: granted.id, orgId: org } });
  sessions.set(owner, [session]);
  const goal = await preparedGoal(env, owner, granted.id, granted.version);
  await createExtensionSkill(env, org, owner, {
    name: "Fixture directory entry", description: "Approved style guidance", instructions: "Fixture only.",
    enabled: true, workspaceId: org,
  });
  const pins = [];
  for (let index = 0; index < 5; index++) {
    const skillId = `skill-${String(index).padStart(24, "0")}`;
    const instructions = `Fixture guidance ${index}: café, “quotes”, and <data>.\nWrite concise paragraphs.`;
    await env.AGENT_AUDIT.batch([
      env.AGENT_AUDIT.prepare(`INSERT INTO skills
        (id, org_id, owner_id, version, status, reviewed_version, active_version, created_at, updated_at)
        VALUES (?, ?, ?, 1, 'active', 1, 1, 0, 0)`).bind(skillId, org, owner),
      env.AGENT_AUDIT.prepare(`INSERT INTO skill_versions
        (skill_id, org_id, owner_id, version, name, instructions, created_at)
        VALUES (?, ?, ?, 1, ?, ?, 0)`).bind(skillId, org, owner, `Style ${index}`, instructions),
    ]);
    pins.push({ skillId, version: 1 });
  }
  const work = (id: string) => coordinator({ env, metadata: { shibaTask: { customAgentId: id, orgId: org } } });
  const cases = [
    ["employee-legacy", work(legacy.id)],
    ["employee-revoked", work(revoked.id)],
    ["employee-missing", work("missing-profile")],
    ["employee-granted", coordinator({ env, name: session.agentName, screen: true, text: goal.task, metadata: {
      shibaTask: { customAgentId: granted.id, orgId: org, ...goal.reference, skillPins: pins, task: goal.task },
    } })],
    ["app-tools-granted", coordinator({ env, name: session.agentName, screen: true, text: goal.task, metadata: {
      shibaWorkTarget: "app-tools", shibaDraftTaskId: goal.reference.draftTaskId,
      shibaDraftTaskVersion: goal.reference.draftTaskVersion, shibaSkillPins: pins,
    } })],
    ["app-tools-unbound", coordinator({ env, metadata: { shibaWorkTarget: "app-tools" } })],
  ] as const;
  return { cases, pins };
}

function measure(call: LanguageModelV4CallOptions) {
  const system = call.prompt.filter(({ role }) => role === "system");
  expect(system.length).toBeGreaterThan(0);
  expect((call.tools ?? []).every((entry) => entry.type === "function" && !!entry.inputSchema)).toBe(true);
  return {
    instructions: Buffer.byteLength(JSON.stringify(system)),
    tools: Buffer.byteLength(JSON.stringify(call.tools ?? [])),
  };
}

type Metric = "instructions" | "tools" | "outputSchema" | "carrier";
type Metrics = Partial<Record<Metric, number>>;
const budgets: Partial<Record<string, Metrics>> = limits;

function assertBudget(id: string, actual: Metrics, print = true) {
  const limit = Object.hasOwn(budgets, id) ? budgets[id] : undefined;
  if (!limit) throw new Error(`Uncatalogued agent context fixture: ${id}`);
  if (Object.keys(actual).sort().join() !== Object.keys(limit).sort().join()) {
    throw new Error(`${id}: measured and budgeted metrics differ.`);
  }
  const violations: string[] = [];
  for (const [metric, bytes] of Object.entries(actual)) {
    const ceiling = limit[metric as Metric];
    if (ceiling === undefined || !Number.isSafeInteger(ceiling) || ceiling < 0) throw new Error(`${id} ${metric}: invalid byte ceiling.`);
    if (print) console.log(`${id} ${metric}: ${bytes} / ${ceiling} UTF-8 bytes`);
    if (bytes > ceiling) violations.push(`${id} ${metric}: ${bytes} UTF-8 bytes exceeds ${ceiling} by ${bytes - ceiling}`);
  }
  if (violations.length) throw new Error(`${violations.join("\n")}\nSee docs/architecture/agent-context-budget.md before changing a ceiling.`);
}

const captured = new Set<string>();
function checkCapture(id: string, actual: Metrics) {
  if (captured.has(id)) throw new Error(`Duplicate agent context fixture: ${id}`);
  captured.add(id);
  assertBudget(id, actual);
}

function measureTurn(id: string, call: LanguageModelV4CallOptions) {
  checkCapture(id, measure(call));
  return call.tools?.map(({ name }) => name) ?? [];
}

afterAll(() => {
  expect([...captured].sort()).toEqual(Object.keys(budgets).sort());
});

it("captures actual coordinator instructions and filtered tool schemas", async () => {
  const { database, sqlite } = customAgentD1();
  using db = sqlite;
  const env = { AGENT_AUDIT: database, LOADER: loader, CodingOrchestrator: {} } as unknown as Env;
  const slackEnv = { ...env, SLACK_BOT_TOKEN: "unused-fixture-marker" };
  const insertFact = db.prepare("INSERT INTO workspace_channel_facts (id,team_id,connection_id,fact,created_by,source_channel,created_at) VALUES (?, 'T1', 'legacy', ?, 'U1', 'C1', ?)");
  const facts = Array.from({ length: 32 }, (_, index) => {
    const key = String(index).padStart(2, "0");
    return { id: `fact-${key}`, fact: `${key}:${'界"<>&'.repeat(99)}界<` };
  });
  for (const [index, { id, fact }] of facts.entries()) insertFact.run(id, fact, index);
  const expectSlackFacts = (call: LanguageModelV4CallOptions) => {
    const system = call.prompt.find(({ role }) => role === "system");
    const block = system?.role === "system"
      ? system.content.match(/<workspace_facts>\n[^\n]+\n([^\n]+)\n<\/workspace_facts>/)?.[1]
      : undefined;
    const emitted: unknown = block === undefined ? null : JSON.parse(block);
    expect(JSON.stringify(emitted) === JSON.stringify(facts), "All seeded Slack facts must reach the measured instruction block.").toBe(true);
  };
  const cold = coordinator({ env, screen: true });
  const slack = coordinator({ env: slackEnv, name: "slack:T1:C1:123.000001" });
  const cases = [
    ["chat-text", coordinator({ metadata: { shibaMode: "chat" } })],
    ["chat-lookups", coordinator({ metadata: { shibaMode: "chat", shibaChatTools: ["web_search", "knowledge_search"] } })],
    ["chat-report-lookups", coordinator({ env: supportedVideo, metadata: { shibaMode: "chat", shibaChatTools: ["web_search", "knowledge_search"], shibaChatCreate: "report" } })],
    ...Object.keys(CHAT_CREATE_TOOLS).map((choice) => [`chat-${choice}`, coordinator({
      env: supportedVideo, metadata: { shibaMode: "chat", shibaChatTools: CHAT_OPT_IN_TOOLS, shibaChatCreate: choice },
    })] as const),
    ["work-default", coordinator({ env: { AGENT_AUDIT: database } })],
    ["work-cold", cold],
    ["slack-work-cold", slack],
  ] as const;
  for (const [id, host] of cases) {
    const call = await captureTurn(host);
    if (id === "slack-work-cold") expectSlackFacts(call);
    const names = measureTurn(id, call);
    if (id === "chat-text") expect(names).toEqual([]);
    else if (id.startsWith("chat-")) {
      const create = Object.values(CHAT_CREATE_TOOLS).filter((name) => names.includes(name));
      const key = id === "chat-report-lookups" ? "report" : id.slice(5);
      expect(create).toEqual(Object.hasOwn(CHAT_CREATE_TOOLS, key) ? [CHAT_CREATE_TOOLS[key as keyof typeof CHAT_CREATE_TOOLS]] : []);
      expect(names).toEqual(expect.arrayContaining(["web_search", "knowledge_search"]));
      if (key !== "lookups" && id !== "chat-report-lookups") expect(names).toContain("browser_sign_in");
      expect(names).not.toContain("delegate_coding_task");
    } else {
      expect(names).toContain("delegate_coding_task");
      expect(names).not.toContain("bash");
      expect(names.includes("run_code")).toBe(id !== "work-default");
      expect(names.includes("screen_shot")).toBe(id === "work-cold");
      if (id !== "work-default") expect(call.tools?.find(({ name }) => name === "run_code")).not.toHaveProperty("description", expect.stringContaining("Available:\n"));
    }
  }
  for (const [id, host] of [["work-warm", cold], ["slack-work-warm", slack]] as const) {
    await vi.waitFor(() => expect(host).toHaveProperty("warmedRunCode.description"));
    const call = await captureTurn(host);
    if (id === "slack-work-warm") expectSlackFacts(call);
    expect(measureTurn(id, call)).toContain("run_code");
    expect(call.tools?.find(({ name }) => name === "run_code")).toHaveProperty("description", expect.stringContaining("Available:\n"));
  }
  const employees = await employeeCases(env);
  for (const [id, host] of employees.cases) {
    const call = await captureTurn(host);
    const names = measureTurn(id, call);
    const granted = id.endsWith("-granted");
    for (const name of ["tool_search", "tool_describe", "tool_call", "employee_context_read", "employee_retain_draft"]) {
      expect(names.includes(name)).toBe(granted);
    }
    for (const name of ["employee_tool_catalog", "employee_tool_call", "bash"]) expect(names).not.toContain(name);
    expect(names.includes("run_code")).toBe(id === "employee-legacy");
    expect(names.includes("delegate_coding_task")).toBe(id.startsWith("employee-"));
    if (id === "app-tools-unbound") expect(names).toEqual([]);
    if (granted) {
      const message = call.prompt.find(({ role }) => role === "system");
      const system = message?.role === "system" ? message.content : "";
      expect(system.includes("<skill-directory>") && system.includes("SELECTED ONBOARDING SOURCES") &&
        employees.pins.every(({ skillId, version }) => system.includes(`${skillId}@${version}`)),
      "The measured granted-employee request must include the directory, source and all five pins.").toBe(true);
    }
  }
});

it("captures built-in MCP schemas after the actual tools/list scope filter", async () => {
  const { database, sqlite } = customAgentD1();
  using _db = sqlite;
  const handler = await createShibaMcpHandler({ AGENT_AUDIT: database } as Env, "/mcp");
  for (const protocolVersion of ["2025-11-25", "2026-07-28"]) {
    for (const [scope, scopes, revoked] of [
      ["all", [...SCOPES], false],
      ["read-runs", ["runs:read"], false],
      ["revoked", [...SCOPES], true],
    ] satisfies Array<[string, TokenRecord["scopes"], boolean]>) {
      const principal = encodePrincipal({ principal: owner, scopes, created: 1, revoked });
      const modern = protocolVersion === "2026-07-28";
      const response = await handler.fetch(new Request("https://worker.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json", accept: "application/json, text/event-stream",
          "mcp-protocol-version": protocolVersion, [MCP_PRINCIPAL_HEADER]: principal,
          ...(modern ? { "mcp-method": "tools/list" } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: modern ? {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": protocolVersion,
            "io.modelcontextprotocol/clientInfo": { name: "context-budget-fixture", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        } : {} }),
      }));
      const body = await response.text();
      const data = response.headers.get("content-type")?.includes("text/event-stream")
        ? body.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? ""
        : body;
      const payload = JSON.parse(data) as { result?: { tools?: Array<{ name: string; inputSchema: object }>; nextCursor?: string }; error?: { code: number } };
      const tools = payload.result?.tools;
      if (revoked) {
        expect(tools).toBeUndefined();
        expect(payload.error?.code).toBe(-32601);
        continue;
      }
      expect(response.status).toBe(200);
      if (!tools || payload.result?.nextCursor) throw new Error("MCP did not return a complete tool list.");
      expect(tools.every(({ inputSchema }) => typeof inputSchema === "object" && inputSchema !== null)).toBe(true);
      const id = `mcp-${modern ? "modern" : "legacy"}-${scope}`;
      checkCapture(id, { tools: Buffer.byteLength(JSON.stringify(tools)) });
      const names = tools.map(({ name }) => name);
      expect(names).toContain("run_status");
      expect(names.includes("queue_run")).toBe(scope === "all");
      if (scope === "read-runs") expect(names.sort()).toEqual(["list_approvals", "list_runs", "run_status"]);
    }
  }
});

it("rejects oversized active schema metadata but ignores inactive tools and arbitrary user text", async () => {
  const metadata = { shibaMode: "chat", shibaChatTools: ["web_search", "knowledge_search"] };
  const normal = measure(await captureTurn(coordinator({ metadata })));
  const inactive = measure(await captureTurn(coordinator({ metadata, resizeTool: "generate_image", text: "界".repeat(16_000) })));
  const oversized = measure(await captureTurn(coordinator({ metadata, resizeTool: "web_search" })));
  expect(inactive).toEqual(normal);
  assertBudget("chat-lookups", normal, false);
  expect(oversized.tools - normal.tools).toBeGreaterThan(45_000);
  expect(() => assertBudget("chat-lookups", oversized, false)).toThrow(/chat-lookups tools: .* UTF-8 bytes exceeds/);
  const host = coordinator({ metadata });
  const beforeTurn = host.beforeTurn.bind(host);
  vi.spyOn(host, "beforeTurn").mockImplementation(async (ctx) => {
    const normal = await beforeTurn(ctx);
    return { ...normal, instructions: `${normal.instructions}\n${"界".repeat(16_000)}` };
  });
  const largeInstructions = measure(await captureTurn(host));
  expect(largeInstructions.instructions - normal.instructions).toBeGreaterThanOrEqual(48_000);
  expect(largeInstructions.tools).toBe(normal.tools);
  expect(() => assertBudget("chat-lookups", largeInstructions, false)).toThrow(/chat-lookups instructions: .* UTF-8 bytes exceeds/);
  expect(() => assertBudget("unreviewed", normal)).toThrow(/Uncatalogued agent context fixture/);
});

type WorkersAiRequest = {
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ type: string; function: { name: string; parameters?: object } }>;
  response_format?: object;
};

function workersAiBytes(request: WorkersAiRequest) {
  const system = request.messages.filter(({ role }) => role === "system");
  expect(system).not.toHaveLength(0);
  expect((request.tools ?? []).every((entry) => entry.type === "function" && !!entry.function.parameters)).toBe(true);
  return { instructions: Buffer.byteLength(JSON.stringify(system)), tools: Buffer.byteLength(JSON.stringify(request.tools ?? [])) };
}

it("captures the default coordinator provider and read-only specialist binding requests", async () => {
  const run = vi.fn(async (_model: string, _request: WorkersAiRequest) => ({ response: "Done" }));
  await executeTurn(coordinator({ env: { AI: { run } as unknown as Ai }, metadata: {
    shibaMode: "chat", shibaChatTools: ["web_search", "knowledge_search"],
  } }));
  const [call, extra] = run.mock.calls;
  if (!call || extra) throw new Error("Expected exactly one coordinator AI binding call.");
  expect(call[1].tools?.map((entry) => entry.function.name)).toEqual(["web_search", "knowledge_search"]);
  checkCapture("workers-ai-chat-lookups", workersAiBytes(call[1]));

  for (const [role, prototype, input] of [
    ["explorer", ExplorerAgent.prototype, { goal: "Inspect", context: "Café", files: [{ path: "a.ts", content: "export const a = 1;" }] }],
    ["reviewer", ReviewerAgent.prototype, { goal: "Review", specification: "Keep approval gates", diff: "+export const a = 1;" }],
  ] as const) {
    run.mockClear();
    run.mockResolvedValue({ response: JSON.stringify({ agent: role, status: "completed", summary: "Fixture", report: "Fixture", findings: [] }) });
    const env = { INTERNAL_SIGNING_KEY: "offline-fixture-signing-material-only", AI: { run } };
    const dispatch = await sealSpecialistDispatch(env, role, owner, "fixture-child", input);
    const agent: ExplorerAgent | ReviewerAgent = Object.create(prototype);
    Object.defineProperties(agent, {
      env: { value: env },
      parentPath: { value: [{ className: "CodingOrchestrator", name: owner }] },
      specialistRole: { value: role },
      messages: { value: [{ id: "fixture", role: "user", parts: [{ type: "text", text: JSON.stringify(dispatch) }] }] },
    });
    const result = await (await agent.onChatMessage(() => {})).text();
    expect(result.includes('"type":"text-delta"'), "Specialist did not complete the synthetic observation.").toBe(true);
    const [entry, duplicate] = run.mock.calls;
    if (!entry || duplicate) throw new Error("Expected exactly one specialist AI binding call.");
    const request = entry[1];
    expect(request.tools ?? []).toEqual([]);
    expect(request.response_format).toMatchObject({ type: "json_schema" });
    checkCapture(`workers-ai-${role}`, { ...workersAiBytes(request), outputSchema: Buffer.byteLength(JSON.stringify(request.response_format)) });
  }
});

it("captures hosted coding and paired-runtime task carriers without launching either runtime", async () => {
  const input = {
    repoUrl: "https://github.com/example/fixture", baseBranch: "main", publishPullRequest: false,
    sandboxId: "context-budget-fixture", task: 'Write a brief on "café".',
    expectedDeliverables: ["report.md"],
    onboardingSourceSnapshot: { sources: [{
      id: "fixture", title: "Brief", sha256: "a".repeat(64), version: 1, content: "Evidence <data> & café.",
      contentTruncated: false, citations: [],
    }] },
  };
  const files = new Map<string, string>();
  const snapshot = repositorySnapshotFixture({ status: "?? report.md\n", files: { "report.md": "# Done\n" } });
  const exec = vi.fn(async (command: string) => await snapshot(command) ?? { stdout: "", stderr: "", exitCode: 0 });
  const ops: SandboxOps = {
    async gitCheckout() {},
    async writeFile(path, content) { files.set(path, content); },
    async readFile() { return { kind: "utf8", content: "# Done\n" }; },
    exec,
  };
  const hosted = await new SandboxRuntimeAdapter(resolveHarness("codex")).runCodingTask(ops, {
    ...input, codingModel: "openai/gpt-5.3-codex",
  }, () => {});
  expect(hosted.status).toBe("completed");
  const jobPath = `/workspace/${input.sandboxId}.job.json`;
  expect(exec.mock.calls.some(([command]) => tokenizeCommand(command)?.at(-1) === jobPath)).toBe(true);
  const job = files.get(jobPath);
  if (!job) throw new Error("Hosted coding did not write a session job.");
  const { prompt } = JSON.parse(job) as { prompt: string };
  expect(prompt).toContain("SELECTED ONBOARDING SOURCES");
  expect(prompt).toContain("Required deliverables");
  checkCapture("harness-hosted-codex", { instructions: Buffer.byteLength(prompt), carrier: Buffer.byteLength(job) });

  const dispatch = vi.fn<LocalDispatchClient["dispatch"]>(async () => {});
  const client: LocalDispatchClient = {
    dispatch,
    cancel: async () => { throw new Error("Unexpected fixture cancellation."); },
    status: async () => ({ status: "settled", result: {
      status: "completed", exitCode: 0, summary: "Fixture", stderrTail: "",
      changedFiles: ["report.md"], diff: "", files: [{ path: "report.md", content: "# Done\n", encoding: "utf8" }],
    } }),
  };
  const paired = await new LocalRuntimeAdapter(resolveHarness("opencode"), { client, pollIntervalMs: 0 }).runCodingTask(
    {} as SandboxOps, { ...input, codingModel: "google/gemini-3.5-flash-lite" }, () => {},
  );
  expect(paired.status).toBe("completed");
  const [envelope, extra] = dispatch.mock.calls;
  if (!envelope || extra) throw new Error("Expected exactly one paired runtime envelope.");
  const { task, argv } = envelope[0];
  expect(task).toContain("SELECTED ONBOARDING SOURCES");
  expect(argv).toContain(task);
  checkCapture("harness-paired-opencode", { instructions: Buffer.byteLength(task), carrier: Buffer.byteLength(JSON.stringify({ task, argv })) });
});
