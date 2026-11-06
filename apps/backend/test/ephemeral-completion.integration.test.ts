/** Local integration: real approval, executor, Git capture, ZIP and completion
 * code. Cloudflare bindings, the model CLI and Slack HTTP are test fixtures. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import type { UIMessageChunk } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { OpenCodeAgent } from "../src/agents/opencode-agent.js";
import { handleArtifactDownload } from "../src/artifact-download.js";
import { tokenizeCommand } from "../src/exec-allowlist.js";
import { OpenCodeHarness } from "../src/harness/opencode.js";
import type { Env } from "../src/env.js";
import { parseAgentResultText, parseAgentToolInput, type CodingTaskResult } from "../src/opencode-input.js";
import { LOCAL_INTAKE_HEADER, LOCAL_INTAKE_DASHBOARD } from "@shiba/shared";
import { LocalRuntimeAdapter, SandboxRuntimeAdapter, type SandboxOps } from "../src/runtime.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), acquire: vi.fn(), adapter: vi.fn(), destroy: vi.fn() }));
vi.mock("@cloudflare/ai-chat", () => ({ AIChatAgent: class {} }));
vi.mock("@cloudflare/think", () => ({ Think: class {
  onStart() {}
  getTools() { return {}; }
  onRequest() { return new Response(null, { status: 404 }); }
  keepAliveWhile<T>(run: () => Promise<T>) { return run(); }
  async schedule() { return {}; }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
vi.mock("../src/runtime.js", async (original) => ({
  ...await original<typeof import("../src/runtime.js")>(),
  createRuntimeAdapter: (...args: unknown[]) => mocks.adapter(...args),
}));
vi.mock("../src/sandbox/lifecycle.js", async (original) => ({
  ...await original<typeof import("../src/sandbox/lifecycle.js")>(),
  acquireSandboxOps: mocks.acquire,
  destroySandbox: mocks.destroy,
}));

const THREAD = "slack:T_PHASE1:C_PHASE1:123.456";
const roots: string[] = [];
class FixtureHarness extends OpenCodeHarness {
  override buildArgv() { return ["phase1-fixture-harness"]; }
}

function sandboxFixture(root: string, empty: boolean): SandboxOps {
  const mapped = (value: string) => value.startsWith("/workspace") ? root + value.slice("/workspace".length) : value;
  return {
    pinEgress: vi.fn(async () => {}),
    gitCheckout: vi.fn(async () => { throw new Error("Repo-free tasks must never clone."); }),
    async writeFile(path, content) {
      mkdirSync(dirname(mapped(path)), { recursive: true });
      writeFileSync(mapped(path), content);
    },
    async readFile() { throw new Error("Output capture must use immutable Git blobs."); },
    async exec(command, options) {
      const args = tokenizeCommand(command);
      if (!args?.length || !args[0]) throw new Error("Invalid fixture command.");
      if (args[0] === "phase1-fixture-harness") {
        if (!empty) {
          writeFileSync(join(root, "out/report.md"), "# Local integration report\n");
          writeFileSync(join(root, "out/empty.txt"), "");
          writeFileSync(join(root, "out/binary.bin"), Uint8Array.of(0, 255, 128, 1));
          writeFileSync(join(root, "private-notes.txt"), "INTERNAL_NOT_AN_ARTIFACT");
        }
        options?.onOutput?.("stdout", "local fixture finished\n");
        return { stdout: "local fixture finished\n", stderr: "", exitCode: 0 };
      }
      const stdout = execFileSync(args[0], args.slice(1).map(mapped), {
        cwd: options?.cwd ? mapped(options.cwd) : root,
        env: { ...process.env, ...options?.env }, maxBuffer: 2_000_000,
        timeout: options?.timeoutMs ?? 10_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      return { stdout, stderr: "", exitCode: 0 };
    },
  };
}

function fixture(mode: "local-outputs" | "outputs" | "empty" | "storage-failure" | "storage-rejection" | "cancel-storage" | "missing-config") {
  const root = mkdtempSync(join(tmpdir(), "shiba-ephemeral-completion-"));
  roots.push(root);
  const ops = sandboxFixture(root, mode === "empty");
  const held: Promise<unknown>[] = [];
  const writes: OrchestratorState[] = [];
  const slackMessages: Array<Record<string, unknown>> = [];
  const objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; metadata: Record<string, string>; checksum: ArrayBuffer }>();
  const childAbort = new AbortController();
  let childResult: CodingTaskResult | undefined;
  const put = vi.fn(async (key: string, body: ReadableStream, options: R2PutOptions) => {
    if (mode === "storage-failure") return null;
    if (mode === "storage-rejection") throw new Error("Injected private R2 write rejection.");
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    objects.set(key, { bytes, metadata: options.customMetadata ?? {}, checksum: await crypto.subtle.digest("SHA-256", bytes) });
    if (mode === "cancel-storage") childAbort.abort();
    return { key };
  });
  const get = vi.fn(async (key: string) => {
    const stored = objects.get(key);
    return stored ? { size: stored.bytes.byteLength, body: new Response(stored.bytes).body,
      customMetadata: stored.metadata, checksums: { sha256: stored.checksum } } : null;
  });
  const env = { ...productionEnvStubs(), Sandbox: {}, DASHBOARD_APPROVERS: "U_PHASE1", SLACK_APPROVERS: "U_PHASE1",
    SLACK_BOT_TOKEN: "test-slack-fixture-token", WORKER_HOSTNAME: "shiba.test",
    ...(mode === "local-outputs" ? { SHIBA_LOCAL_RUNTIME: "1", AI_GATEWAY_TOKEN: "",
      ATTACHMENTS: { put: vi.fn(async () => ({ key: "fixture-deliverable" })) } } : {}),
    ...(mode === "missing-config" ? {} : { ARTIFACT_SIGNING_KEY: "test-ephemeral-signing-key-32-bytes", ARTIFACTS: { put, get } }),
  } as unknown as Env;
  const storage = { get: async () => undefined, put: async () => {}, delete: async () => {}, list: async () => new Map() };
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    name: mode === "local-outputs" ? "U_PHASE1" : THREAD, env, messages: [], state: { runs: [] } as OrchestratorState,
    ctx: { storage, waitUntil: (promise: Promise<unknown>) => held.push(promise) },
    setState(next: OrchestratorState) {
      setStateLikeProduction(this, next);
      writes.push(JSON.parse(JSON.stringify(this.state)) as OrchestratorState);
    },
  });
  mocks.acquire.mockResolvedValue(ops);
  const dispatch = vi.fn(async () => {});
  mocks.adapter.mockImplementation((runtime: string) => {
    if (mode !== "local-outputs") return new SandboxRuntimeAdapter(new FixtureHarness());
    expect(runtime).toBe("local");
    return new LocalRuntimeAdapter(new FixtureHarness(), { pollIntervalMs: 0, client: {
      dispatch,
      cancel: async () => {},
      status: async () => ({ status: "settled", result: { status: "completed", exitCode: 0, summary: "Local fixture produced the approved brief.",
        stderrTail: "", diff: "", changedFiles: ["out/brief.md"], files: [{ path: "out/brief.md", content: "# Approved local brief\n", encoding: "utf8" }], signals: [] } }),
    } });
  });
  mocks.execute.mockImplementation(async (envelope: string) => {
    const input = parseAgentToolInput([{ role: "user", text: envelope }]);
    expect(input.executionTarget).toMatchObject({ kind: "artifact-workspace", workspaceId: "phase1-report" });
    expect(input.repoUrl).toBe("");
    expect(input.publishPullRequest).toBe(false);
    const child = Object.assign(Object.create(OpenCodeAgent.prototype) as OpenCodeAgent, {
      env, messages: [{ id: "input", role: "user", parts: [{ type: "text", text: envelope }] }], reportProgress: vi.fn(),
    });
    const response = await child.onChatMessage(() => {}, { requestId: "phase1-local", abortSignal: childAbort.signal });
    if (!response) throw new Error("Executor did not return a stream.");
    const chunks = (await response.text()).split("\n").filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)) as UIMessageChunk);
    const text = chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta).join("");
    childResult = parseAgentResultText(text);
    return text;
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://slack.com/api/")) throw new Error(`Unexpected external fixture request: ${url}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    slackMessages.push(body);
    return Response.json({ ok: true, channel: "C_PHASE1", ts: "123.789" });
  }));
  return { instance, env, ops, writes, dispatch, slackMessages, objects, put, get, childResult: () => childResult,
    drain: async () => { for (let index = 0; index < held.length; index++) await held[index]; } };
}

function post(path: string, body: unknown) {
  return new Request(`https://internal${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function approvedRun(context: ReturnType<typeof fixture>, local = false) {
  const request = post("/api/runs", { repoUrl: "", task: "Produce the phase one report.",
    workspaceTarget: { type: "ephemeral", workspaceId: "phase1-report", template: "report" }, publishPullRequest: false,
    reviewAfterPublish: false, threadKey: THREAD,
    ...(local ? { runtime: "local", expectedDeliverables: ["out/brief.md"] } : {}),
  });
  if (local) request.headers.set(LOCAL_INTAKE_HEADER, LOCAL_INTAKE_DASHBOARD);
  const queued = await context.instance.onRequest(request);
  expect(queued.status, await queued.clone().text()).toBe(200);
  const { approvalId } = await queued.json() as { approvalId: string };
  expect(context.instance.state.pendingApprovals?.find((approval) => approval.approvalId === approvalId)?.status).toBe("pending");
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(context.put).not.toHaveBeenCalled();
  const decision = await context.instance.onRequest(post("/api/approvals", {
    threadKey: THREAD, approvalId, approved: true, decidedBy: "U_PHASE1",
  }));
  expect(decision.status, await decision.clone().text()).toBe(200);
  const runId = `agent-tool:${approvalId}`;
  await vi.waitFor(() => expect(context.instance.state.runs.find((run) => run.runId === runId)?.status).toMatch(/completed|error|aborted|cancelled/), { timeout: 10_000 });
  await context.drain();
  const run = context.instance.state.runs.find((run) => run.runId === runId);
  if (!run) throw new Error("Approved run was not retained.");
  return run;
}

beforeEach(() => { vi.resetAllMocks(); mocks.destroy.mockResolvedValue(undefined); });
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("local new-ephemeral approval to archive completion integration", () => {
  it("exports approved local adapter results only after approval without starting a sandbox", async () => {
    const context = fixture("local-outputs");
    const run = await approvedRun(context, true);
    expect(run.status, run.summary).toBe("completed");
    expect(context.dispatch).toHaveBeenCalledOnce();
    expect(context.dispatch).toHaveBeenCalledWith(expect.objectContaining({ repoUrl: "", expectedDeliverables: ["out/brief.md"],
      executionTarget: expect.objectContaining({ kind: "artifact-workspace", expectedDeliverables: ["out/brief.md"] }) }), undefined, "U_PHASE1");
    expect(context.ops.gitCheckout).not.toHaveBeenCalled();
    expect(run.artifactBundle).toBeDefined();
    expect(run.deliverables?.map((item) => item.path)).toEqual(["out/brief.md"]);
    const bundle = run.artifactBundle!;
    const link = new URL(bundle.downloadUrl);
    const response = await handleArtifactDownload(new Request(new URL(link.pathname, link), {
      method: "POST", body: new URLSearchParams(link.hash.slice(1)), headers: { origin: link.origin, "sec-fetch-site": "same-origin" },
    }), context.env);
    expect(response?.status).toBe(200);
    const zip = unzipSync(new Uint8Array(await response!.arrayBuffer()));
    expect(Object.keys(zip)).toEqual(["brief.md"]);
    expect(new TextDecoder().decode(zip["brief.md"])).toBe("# Approved local brief\n");
  }, 30_000);

  it.each(["outputs", "empty"] as const)("retains one signed bundle in child metadata, completion event, run and Slack for %s", async (mode) => {
    const context = fixture(mode);
    const run = await approvedRun(context);
    expect(run.status).toBe("completed");
    expect(context.ops.gitCheckout).not.toHaveBeenCalled();
    expect(mocks.acquire).toHaveBeenCalledOnce();
    expect(context.put).toHaveBeenCalledOnce();
    const bundle = context.childResult()?.artifactBundle;
    expect(bundle).toBeDefined();
    if (!bundle) throw new Error("No completion artifact bundle.");
    expect(context.childResult()?.files).toEqual([]);
    expect(run.artifactBundle).toEqual(bundle);
    const completed = context.instance.state.events?.find((event) => event.kind === "run.completed" && event.runId === run.runId);
    expect(completed?.payload).toMatchObject({ patch: { artifactBundle: bundle } });
    const completionWrites = context.writes.filter((state) => state.runs.some((item) => item.runId === run.runId && item.status === "completed"));
    expect(completionWrites.length).toBeGreaterThan(0);
    expect(completionWrites.every((state) => state.runs.find((item) => item.runId === run.runId)?.artifactBundle?.downloadUrl === bundle.downloadUrl)).toBe(true);
    expect(context.slackMessages.some((message) => String(message.text).includes(`Artifacts: ${bundle?.downloadUrl}`))).toBe(true);
    const link = new URL(bundle.downloadUrl);
    const response = await handleArtifactDownload(new Request(new URL(link.pathname, link), {
      method: "POST", body: new URLSearchParams(link.hash.slice(1)), headers: { origin: link.origin, "sec-fetch-site": "same-origin" },
    }), context.env);
    expect(response?.status).toBe(200);
    if (!response) throw new Error("Artifact download route was not handled.");
    const zip = unzipSync(new Uint8Array(await response.arrayBuffer()));
    if (mode === "empty") {
      expect(zip).toEqual({});
      expect(bundle?.bytes).toBe(22);
    } else {
      expect(Object.keys(zip).sort()).toEqual(["binary.bin", "empty.txt", "report.md"]);
      expect(zip["empty.txt"]).toEqual(new Uint8Array());
      expect(zip["binary.bin"]).toEqual(Uint8Array.of(0, 255, 128, 1));
      expect(new TextDecoder().decode(zip["report.md"])).toBe("# Local integration report\n");
    }
    expect(JSON.stringify(context.childResult())).not.toContain("INTERNAL_NOT_AN_ARTIFACT");
  }, 30_000);

  it.each(["storage-failure", "storage-rejection", "cancel-storage", "missing-config"] as const)("exposes no completion bundle after %s", async (mode) => {
    const context = fixture(mode);
    const run = await approvedRun(context);
    expect(run.status).not.toBe("completed");
    expect(run.artifactBundle).toBeUndefined();
    expect(context.childResult()?.artifactBundle).toBeUndefined();
    expect(context.instance.state.events?.some((event) => event.kind === "run.completed" && event.runId === run.runId)).toBe(false);
    expect(context.slackMessages.some((message) => String(message.text).includes("Artifacts:"))).toBe(false);
    if (mode === "missing-config") {
      expect(mocks.acquire).not.toHaveBeenCalled();
      expect(context.put).not.toHaveBeenCalled();
    }
  }, 30_000);
});
