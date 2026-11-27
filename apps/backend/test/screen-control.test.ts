/**
 * PLAN-V2-NEXT computer-use surface: screen_action argv validation,
 * the scoped exec trail, the DO route, and the MCP tool registrations.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import type { OrchestratorState } from "../src/agents/orchestrator.js";
import { LOCAL_INTAKE_HEADER, runInputHash, type RunSignal } from "@shiba/shared";
import {
  runScreenAction,
  ScreenActionError,
  screenActionArgv,
} from "../src/screen-control.js";
import type { ExecResult, SandboxOps } from "../src/runtime.js";
import { createRun } from "../src/runs.js";
import {
  setSandboxHandleResolver,
  setSandboxOpsFactory,
} from "../src/sandbox/lifecycle.js";
import { sendWorkerRequest, productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { tokenizeCommand } from "../src/exec-allowlist.js";
import { AGENT_MEDIA_TOOL_DEFAULTS } from "../src/employee-tool-policy.js";
import { createChatScreenTools } from "../src/tools/chat-screen-tools.js";

const mocks = vi.hoisted(() => ({
  destroy: vi.fn(),
  execute: vi.fn(),
  keepAliveWhile: vi.fn((fn: () => Promise<unknown>) => fn()),
  schedule: vi.fn(async (..._args: unknown[]) => ({})),
}));
vi.mock("@cloudflare/think", () => ({
  Think: class {
    onStart() {}
    getTools() {
      return {};
    }
    onRequest() {
      return new Response(null, { status: 404 });
    }
    keepAliveWhile(fn: () => Promise<unknown>) {
      return mocks.keepAliveWhile(fn);
    }
    schedule(...args: unknown[]) {
      return mocks.schedule(...args);
    }
  },
}));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

const AGENT_PRINCIPAL_HEADER = "X-Agent-Principal";
const PNG_FIXTURE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jT1sAAAAASUVORK5CYII=";

function fakeOps(exec: SandboxOps["exec"]): SandboxOps {
  return {
    exec,
    gitCheckout: async () => {},
    writeFile: async () => {},
    readFile: async () => ({ kind: "utf8" as const, content: "" }),
  };
}

const okExec = vi.fn(async (_cmd: string): Promise<ExecResult> => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
}));

function agent() {
  const storage = new Map<string, unknown>();
  return Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: { ...productionEnvStubs(), Sandbox: {} },
    name: "dashboard:test",
    ctx: { storage: { kv: {
      get: (key: string) => structuredClone(storage.get(key)),
      put: (key: string, value: unknown) => storage.set(key, structuredClone(value)),
    } }, waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined) },
    state: { runs: [] } as OrchestratorState,
    setState(this: CodingOrchestrator, next: OrchestratorState) {
      setStateLikeProduction(this, next);
    },
  });
}

function seedRun(instance: CodingOrchestrator, status: "running" | "completed") {
  const run = {
    ...createRun({
      runId: "run-1",
      sandboxId: "sbx-1",
      repoUrl: "https://github.com/o/r",
      task: "t",
      baseBranch: "main",
      publishPullRequest: false,
      computer: true,
      runtime: "sandbox",
      sandboxProvider: "cloudflare",
    }),
    status,
  };
  const approved = { ...run, approval: { approvalId: "approval-1", decidedBy: "tester", decidedAt: 1, inputHash: runInputHash(run) } };
  instance.state.runs = [approved];
  return approved;
}

const screenPost = (
  runId: string,
  action: Record<string, unknown>,
  principal?: string,
) =>
  new Request(`https://internal/api/runs/${encodeURIComponent(runId)}/screen`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(principal ? { [AGENT_PRINCIPAL_HEADER]: principal } : { [LOCAL_INTAKE_HEADER]: "screen:user-alpha" }),
    },
    body: JSON.stringify({ action }),
  });

const controlPost = (operation: "take" | "release", actorId = "user-alpha") =>
  new Request("https://internal/api/runs/run-1/screen", {
    method: "POST", headers: { [LOCAL_INTAKE_HEADER]: `screen:${actorId}` },
    body: JSON.stringify({ control: operation }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.destroy.mockResolvedValue(undefined);
  mocks.execute.mockResolvedValue("ok");
  okExec.mockClear();
  okExec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  setSandboxOpsFactory(() => fakeOps(okExec));
});

describe("screenActionArgv", () => {
  it("click emits move+click with validated coords and button", () => {
    expect(screenActionArgv({ type: "click", x: 10, y: 20 })).toEqual([
      ["xdotool", "mousemove", "10", "20"],
      ["xdotool", "click", "1"],
    ]);
    expect(screenActionArgv({ type: "click", x: 1, y: 2, button: "right" })[1]).toEqual([
      "xdotool", "click", "3",
    ]);
    expect(screenActionArgv({ type: "click", x: 1, y: 2, button: 2 })[1]![2]).toBe("2");
  });

  it("type keeps metacharacters literal as one argv element", () => {
    const argv = screenActionArgv({ type: "type", text: "a; rm -rf / && $(x)" });
    expect(argv).toHaveLength(1);
    expect(argv[0]![5]).toBe("a; rm -rf / && $(x)");
  });

  it("scroll maps to wheel-button clicks", () => {
    expect(screenActionArgv({ type: "scroll", dx: 0, dy: 240 })).toEqual([
      ["xdotool", "click", "--repeat", "2", "5"],
    ]);
    expect(screenActionArgv({ type: "scroll", dx: -240, dy: 0 })[0]![4]).toBe("6");
  });

  it("rejects malformed input before it becomes argv", () => {
    const bad: unknown[] = [
      { type: "click", x: -1, y: 0 },
      { type: "click", x: 1.5, y: 0 },
      { type: "click", x: 0, y: 200_000 },
      { type: "click", x: 0, y: 0, button: 4 },
      { type: "type", text: "" },
      { type: "scroll", dx: 0, dy: 0 },
      { type: "key", keys: "a; rm -rf /" },
      { type: "key", keys: "ctrl+s && x" },
      { type: "key", keys: "$(whoami)" },
      { type: "key", keys: "exec" },
    ];
    for (const action of bad) {
      expect(() => screenActionArgv(action as never)).toThrow(ScreenActionError);
    }
    expect(() => screenActionArgv({ type: "nope" } as never)).toThrow(ScreenActionError);
  });

  it("shot emits scrot + base64", () => {
    expect(screenActionArgv({ type: "shot" })).toEqual([
      ["scrot", "-o", "/tmp/shiba-screen.png"],
      ["base64", "-w0", "/tmp/shiba-screen.png"],
    ]);
  });
});

describe("runScreenAction", () => {
  it("drives validated argv in one active-only operation and records the exec", async () => {
    const signals: RunSignal[] = [];
    const result = await runScreenAction(
      fakeOps(okExec),
      { type: "click", x: 3, y: 4 },
      "agent",
      signals,
    );
    expect(result).toEqual({ ok: true });
    expect(okExec).toHaveBeenCalledTimes(1);
    expect(okExec).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ activeOnly: true }));
    const argv = tokenizeCommand(okExec.mock.calls[0]![0])!;
    expect(argv.slice(0, 3)).toEqual(["shiba-run-computer", "action", "agent"]);
    expect(JSON.parse(argv[3]!)).toEqual([["xdotool", "mousemove", "3", "4"], ["xdotool", "click", "1"]]);
    expect(signals.map((s) => s.kind)).toEqual(["exec.invoked", "exec.settled"]);
  });

  it("returns the base64 payload on shot", async () => {
    const shotExec = vi.fn(async (cmd: string): Promise<ExecResult> =>
      cmd.includes("base64")
        ? { stdout: PNG_FIXTURE, stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 0 });
    const result = await runScreenAction(fakeOps(shotExec), { type: "shot" }, "agent");
    expect(result).toEqual({ ok: true, screenshotBase64: PNG_FIXTURE });
  });

  it("stops at the first nonzero exit", async () => {
    const failExec = vi.fn(async (): Promise<ExecResult> => ({
      stdout: "",
      stderr: "no display",
      exitCode: 1,
    }));
    const result = await runScreenAction(
      fakeOps(failExec),
      { type: "click", x: 1, y: 1 },
      "agent",
    );
    expect(result.ok).toBe(false);
    expect(result).toEqual({ ok: false });
    expect(failExec).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/runs/<id>/screen", () => {
  it("404s unknown runs and hides other principals' runs", async () => {
    const instance = agent();
    expect((await sendWorkerRequest(instance, screenPost("run-nope", { type: "click", x: 0, y: 0 }))).status).toBe(404);
    const run = seedRun(instance, "running");
    instance.state.runs = [{ ...run, queuedBy: "agent-alpha" }];
    expect(
      (await sendWorkerRequest(instance, screenPost("run-1", { type: "click", x: 0, y: 0 }, "agent-beta"))).status,
    ).toBe(404);
  });

  it("requires Worker-vouched authority and refuses runs without intact approval", async () => {
    const instance = agent();
    const run = seedRun(instance, "running");
    expect((await instance.onRequest(screenPost("run-1", { type: "shot" }))).status).toBe(401);
    const unauthenticated = new Request("https://internal/api/runs/run-1/screen", {
      method: "POST", body: JSON.stringify({ action: { type: "shot" } }),
    });
    expect((await instance.onRequest(unauthenticated)).status).toBe(403);
    for (const mismatched of [{ ...run, computer: false }, { ...run, approval: undefined }, { ...run, task: "changed" }]) {
      instance.state.runs = [mismatched];
      expect((await sendWorkerRequest(instance, screenPost("run-1", { type: "shot" }))).status).toBe(409);
    }
    expect(okExec).not.toHaveBeenCalled();
  });

  it("409s when the run is not running — no screen to drive", async () => {
    const instance = agent();
    seedRun(instance, "completed");
    const res = await sendWorkerRequest(instance, screenPost("run-1", { type: "click", x: 0, y: 0 }));
    expect(res.status).toBe(409);
    expect(okExec).not.toHaveBeenCalled();
  });

  it("400s a malformed action without touching the sandbox", async () => {
    const instance = agent();
    seedRun(instance, "running");
    const res = await sendWorkerRequest(instance, screenPost("run-1", { type: "key", keys: "$(x)" }));
    expect(res.status).toBe(400);
    expect(okExec).not.toHaveBeenCalled();
  });

  it("drives the action, records signals on the run, emits run.progress", async () => {
    const instance = agent();
    const run = seedRun(instance, "running");
    instance.state.runs = [{ ...run, queuedBy: "agent-alpha" }];
    const res = await sendWorkerRequest(instance,
      screenPost("run-1", { type: "type", text: "private input" }, "agent-alpha"),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(okExec).toHaveBeenCalledTimes(1);
    expect(okExec.mock.calls[0]![0]).toContain('"xdotool","type"');
    expect(okExec.mock.calls[0]![0]).toContain("private input");

    const latest = instance.state.runs.find((r) => r.runId === "run-1");
    expect(latest?.signals?.map((s) => s.kind)).toEqual(["exec.invoked", "exec.settled"]);
    expect(JSON.stringify(latest?.signals)).not.toContain("private input");
    const progress = (instance.state.events ?? []).find(
      (e) => e.kind === "run.progress" && e.runId === "run-1",
    );
    expect(progress).toBeDefined();
    expect((progress!.payload as { summary: string }).summary).toContain("screen_type");
  });

  it("returns the screenshot payload for shot", async () => {
    okExec.mockImplementation(async (cmd: string): Promise<ExecResult> =>
      cmd.includes("base64")
        ? { stdout: PNG_FIXTURE, stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 0 });
    const instance = agent();
    seedRun(instance, "running");
    const res = await sendWorkerRequest(instance, screenPost("run-1", { type: "shot" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, control: "agent", screenshotBase64: PNG_FIXTURE });
    expect(instance.state.runs[0]?.signals ?? []).toEqual([]);
  });

  it("hands one authenticated person control, pauses the agent, and records take and release", async () => {
    const instance = agent();
    const run = seedRun(instance, "running");
    instance.state.runs = [{ ...run, queuedBy: "agent-alpha" }];
    const input = { type: "key", keys: "Return" };
    expect((await sendWorkerRequest(instance, screenPost("run-1", input))).status).toBe(409);
    expect(okExec).not.toHaveBeenCalled();
    expect(await (await sendWorkerRequest(instance, controlPost("take"))).json()).toEqual({ ok: true, control: "you" });
    expect((await sendWorkerRequest(instance, controlPost("take", "user-beta"))).status).toBe(409);
    expect(await (await sendWorkerRequest(instance, screenPost("run-1", { type: "shot" }, "agent-alpha"))).json())
      .toMatchObject({ ok: false, paused: true });
    expect(okExec).toHaveBeenCalledTimes(1);
    expect((await sendWorkerRequest(instance, screenPost("run-1", input))).status).toBe(200);
    expect((await sendWorkerRequest(instance, controlPost("release"))).status).toBe(200);
    expect((await sendWorkerRequest(instance, screenPost("run-1", input, "agent-alpha"))).status).toBe(200);
    expect(instance.state.runs[0]?.receipts?.filter(({ kind }) => kind === "computer").map(({ message }) => message)).toEqual([
      "Control taken by user-alpha.", "Control handed back by user-alpha.",
    ]);
  });

  it("does not return a frame after a run ends during capture", async () => {
    const instance = agent();
    const run = seedRun(instance, "running");
    okExec.mockImplementationOnce(async () => {
      instance.state.runs = [{ ...run, status: "completed" }];
      return { stdout: PNG_FIXTURE, stderr: "", exitCode: 0 };
    });
    const res = await sendWorkerRequest(instance, screenPost("run-1", { type: "shot" }));
    expect(res.status).toBe(503);
    expect(await res.json()).not.toHaveProperty("screenshotBase64");
  });

  it("405s non-POST", async () => {
    const instance = agent();
    seedRun(instance, "running");
    const res = await instance.onRequest(
      new Request("https://internal/api/runs/run-1/screen", { method: "GET" }),
    );
    expect(res.status).toBe(405);
  });
});

describe("chat screen tool policy", () => {
  it("only exposes and executes screen tools for the live run selected by the latest Chat message", async () => {
    const instance = agent();
    const run = seedRun(instance, "running");
    instance.state.runs.push({ ...run, runId: "run-2" });
    Object.assign(instance, { name: "person@example.test", messages: [] });
    const turn = async (runId?: string) => {
      Object.assign(instance, { messages: [...instance.messages, { role: "user", metadata: { shibaMode: "chat", shibaComputerRunId: runId } }] });
      const tools = instance.getTools();
      return { tools, ...await instance.beforeTurn({ tools, system: instance.getSystemPrompt() } as never) };
    };
    expect((await turn()).activeTools).toEqual([]);
    expect((await turn("other")).activeTools).toEqual([]);
    const selected = await turn("run-1");
    expect(selected.activeTools?.sort()).toEqual(["screen_click", "screen_key", "screen_scroll", "screen_shot", "screen_type"]);
    expect(selected.instructions).toContain("run-1");
    const execute = selected.tools.screen_scroll?.execute;
    if (!execute) throw new Error("The selected screen has no scroll tool.");
    const scroll = (input: { runId: string; dx: number; dy: number }) =>
      execute(input, { toolCallId: "scroll", messages: [], context: undefined });
    expect(await scroll({ runId: "run-2", dx: 0, dy: 1 })).toMatchObject({ error: expect.any(String) });
    expect(okExec).not.toHaveBeenCalled();
    expect(await scroll({ runId: "run-1", dx: 0, dy: 1 })).toMatchObject({ ok: true });
    expect((await turn()).tools).not.toHaveProperty("screen_scroll");
    expect(await scroll({ runId: "run-1", dx: 0, dy: 1 })).toMatchObject({ error: expect.any(String) });
    instance.state.runs[0] = { ...run, task: "Changed after approval." };
    expect((await turn("run-1")).activeTools).toEqual([]);
    instance.state.runs[0] = { ...run, status: "completed" };
    expect((await turn("run-1")).activeTools).toEqual([]);
  });

  it("requires confirmation to click, type or send keys, and treats screenshots as reads", () => {
    const tools = createChatScreenTools({} as never, { userId: "u", workspaceId: "w", act: vi.fn() });
    for (const name of ["screen_click", "screen_type", "screen_key"]) {
      expect(tools[name]?.needsApproval).toBe(true);
      expect(AGENT_MEDIA_TOOL_DEFAULTS[name]?.risk).toBe("approval_required");
    }
    expect(tools.screen_shot?.needsApproval).toBeUndefined();
    expect(AGENT_MEDIA_TOOL_DEFAULTS.screen_shot?.risk).toBe("read");
  });
});

describe("screen_* MCP tools", () => {
  it("register under sandbox:exec like the other mutating tools", async () => {
    const { createToolRegistry } = await import("../src/mcp-gateway.js");
    const { registerScreenTools } = await import("../src/mcp-screen-tools.js");
    const env = { AGENT_AUDIT: undefined, CodingOrchestrator: {} } as never;
    const registry = createToolRegistry(env);
    registerScreenTools(registry, env);
    const tools = registry.tools();
    for (const name of ["screen_click", "screen_type", "screen_scroll", "screen_key", "screen_shot"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.scope).toBe("sandbox:exec");
    }
    // A token without the scope is refused before the orchestrator.
    const denied = await registry.invoke(
      "screen_key",
      { runId: "run-1", keys: "Return" },
      { principal: "a", scopes: ["runs:read"], created: 0, revoked: false },
    );
    expect(denied.isError).toBe(true);
  });
});
