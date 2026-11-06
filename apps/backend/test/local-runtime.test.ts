/**
 * T51 local-runtime tests (PLAN.md §18.13). The ordering is the security
 * claim: the approval-gate and intake-refusal proofs sit BEFORE the adapter
 * tests — the gate is provably unchanged, and `runtime: "local"` can only
 * be minted through the dashboard path.
 */
import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_CLAIM_STALE_MS,
  LOCAL_INTAKE_DASHBOARD,
  LOCAL_INTAKE_HEADER,
  LOCAL_HEARTBEAT_STALE_MS,
  LOCAL_RUNTIME_FLAG,
  buildLocalRunEnvelope,
  compareReleaseVersions,
  leaseIsReclaimable,
  localReleaseDir,
  localizeContainerPath,
  localRunResultSchema,
  resolveLocalRelease,
  type LocalRunEnvelope,
  type LocalRunResult,
  type PersonalExecutionSnapshot,
} from "@shiba/shared";
import worker from "../src/index.js";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { LOCAL_MACHINE_HEADER, LOCAL_DASHBOARD_OWNER_HEADER, LocalDispatch } from "../src/local-dispatch.js";
import { LocalRuntimeAdapter, type LocalDispatchClient } from "../src/runtime.js";
import { resolveHarness } from "../src/harness/index.js";
import { DUMMY_PROVIDER_KEY } from "../src/provider-gateway.js";
import { approveDirect } from "./seeding.js";
import { buildSessionAgentName } from "../src/web-sessions.js";

const mocks = vi.hoisted(() => ({ getAgentByName: vi.fn() }));
vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  proxyToSandbox: async () => null,
  getSandbox: () => ({ destroy: async () => {} }),
}));
vi.mock("agents/routing", () => ({
  getAgentByName: mocks.getAgentByName,
  routeAgentRequest: async () => null,
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
  },
}));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: vi.fn() }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("agents/mcp", () => ({
  createMcpHandler: () => ({
    fetch: async () => Response.json({ mcp: "served" }, { status: 200 }),
    notify: {},
  }),
}));

// ── Shared pure helpers ─────────────────────────────────────────────────

describe("localizeContainerPath", () => {
  it("tokenizes the run's workdir and home, leaves other paths alone", () => {
    expect(localizeContainerPath("/workspace/sb-1", "sb-1")).toBe("${SHIBA_LOCAL_RUN_ROOT}/work");
    expect(localizeContainerPath("/workspace/sb-1/src/x.ts", "sb-1")).toBe("${SHIBA_LOCAL_RUN_ROOT}/work/src/x.ts");
    expect(localizeContainerPath("/root/.config/opencode.json", "sb-1")).toBe("${SHIBA_LOCAL_RUN_ROOT}/home/.config/opencode.json");
    expect(localizeContainerPath("/usr/bin/node", "sb-1")).toBe("/usr/bin/node");
    // A different sandbox's paths are not this run's.
    expect(localizeContainerPath("/workspace/other/x", "sb-1")).toBe("/workspace/other/x");
  });
});

describe("buildLocalRunEnvelope", () => {
  const base = {
    input: {
      sandboxId: "sb-1",
      repoUrl: "https://github.com/o/r",
      baseBranch: "main",
      task: "fix the tests",
      testCommand: ["npm", "test"],
    },
    harnessName: "opencode",
    workdir: "/workspace/sb-1",
    configFiles: [
      { path: "/root/.config/opencode.json", contents: `{"provider":{"x":{"options":{"apiKey":"${DUMMY_PROVIDER_KEY}"}}}}` },
    ],
    setupCommands: [["mkdir", "-p", "/workspace/sb-1/.opencode"]],
    argv: ["opencode", "run", "--config", "/root/.config/opencode.json"],
    env: { OPENCODE_API_KEY: DUMMY_PROVIDER_KEY, HOME: "/root", FOO: "bar" },
    dummyKey: DUMMY_PROVIDER_KEY,
    providerKeyEnv: "OPENCODE_API_KEY",
    execAllowlist: [["npm", "test"], ["pnpm", "test"]],
    setupAllowlist: [["mkdir"], ["ln"], ["chmod"]],
    deadlineAt: 1_800_000,
    now: 1_700_000,
  };

  it("drops the dummy provider key from env and env-references it in config bodies", () => {
    const envelope = buildLocalRunEnvelope(base);
    expect(envelope.env.OPENCODE_API_KEY).toBeUndefined();
    expect(envelope.env.HOME).toBe("${SHIBA_LOCAL_RUN_ROOT}/home"); // container /root → run home
    expect(envelope.env.FOO).toBe("bar");
    expect(envelope.configFiles[0]?.path).toBe("${SHIBA_LOCAL_RUN_ROOT}/home/.config/opencode.json");
    expect(envelope.configFiles[0]?.contents).toContain("{env:OPENCODE_API_KEY}");
    expect(envelope.configFiles[0]?.contents).not.toContain(DUMMY_PROVIDER_KEY);
    expect(envelope.argv).toContain("${SHIBA_LOCAL_RUN_ROOT}/home/.config/opencode.json");
    expect(envelope.cloneDir).toBe("${SHIBA_LOCAL_RUN_ROOT}/work");
    expect(envelope.testCommand).toEqual(["npm", "test"]);
    expect(envelope.execAllowlist).toEqual([["npm", "test"], ["pnpm", "test"]]);
    expect(envelope.setupAllowlist).toEqual([["mkdir"], ["ln"], ["chmod"]]);
    expect(envelope.createdAt).toBe(1_700_000);
  });

  it("requires an explicit matching artifact target for an empty repository URL", () => {
    const executionTarget = { kind: "artifact-workspace" as const, expectedDeliverables: ["brief.md"] };
    const input = { ...base.input, repoUrl: "", expectedDeliverables: ["brief.md"], executionTarget };
    expect(buildLocalRunEnvelope({ ...base, input })).toMatchObject({ repoUrl: "", executionTarget });
    expect(() => buildLocalRunEnvelope({ ...base, input: { ...base.input, repoUrl: "" } })).toThrow();
    expect(() => buildLocalRunEnvelope({ ...base, input: { ...input, expectedDeliverables: ["other.md"] } })).toThrow();
    expect(() => buildLocalRunEnvelope({ ...base, input: { ...input, repoUrl: "https://github.com/o/r" } })).toThrow();
    expect(() => buildLocalRunEnvelope({ ...base, input: { ...input,
      expectedDeliverables: [], executionTarget: { ...executionTarget, workspaceId: "empty", expectedDeliverables: [] },
    } })).toThrow();
  });

  it("refuses malformed envelopes at the schema boundary", () => {
    expect(() =>
      buildLocalRunEnvelope({ ...base, input: { ...base.input, task: "" } }),
    ).toThrow();
  });

  it("preserves the approved bot identity, version, and org in the laptop envelope", () => {
    const envelope = buildLocalRunEnvelope({ ...base, input: {
      ...base.input, customAgentId: "bot-one", customAgentVersion: 3, orgId: "org-one",
    } });
    expect(envelope).toMatchObject({ customAgentId: "bot-one", customAgentVersion: 3, orgId: "org-one" });
  });
});

describe("installer-lease helpers", () => {
  it("resolves the current pointer, else the newest version", () => {
    expect(localReleaseDir("/r", "daemon", "1.2.0")).toBe("/r/releases/daemon/1.2.0");
    expect(resolveLocalRelease({ current: "1.0.0", versions: ["1.0.0", "1.2.0"] })).toBe("1.0.0");
    expect(resolveLocalRelease({ versions: ["1.9.0", "1.10.0", "1.2.0"] })).toBe("1.10.0");
    expect(resolveLocalRelease({ versions: [] })).toBeNull();
    expect(compareReleaseVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });

  it("a dead holder's lease is reclaimable, a live one's is not", () => {
    expect(leaseIsReclaimable({ holderAlive: true })).toBe(false);
    expect(leaseIsReclaimable({ holderAlive: false })).toBe(true);
  });
});

// ── LocalDispatch DO lifecycle ──────────────────────────────────────────

function fakeStorage() {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async (key: string, value: unknown) => void map.set(key, value),
    delete: async (key: string) => void map.delete(key),
    list: async <T>(opts: { prefix: string }) =>
      new Map([...map.entries()].filter(([key]) => key.startsWith(opts.prefix))) as Map<string, T>,
    __map: map,
  };
}

function makeDispatch() {
  const storage = fakeStorage();
  const ctx = { storage, waitUntil: () => {}, blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn() };
  const obj = new LocalDispatch(ctx as never, {} as never);
  return { obj, storage };
}

async function registerComputer(storage: ReturnType<typeof fakeStorage>, machineId: string, overrides: Record<string, unknown> = {}) {
  await storage.put(`computer:${machineId}`, {
    machineId, hostname: "test-computer", platform: "linux-x64", daemonVersion: "0.1.0",
    harnesses: ["opencode", "claude", "codex"], lastHeartbeat: Date.now(), tokenHash: "paired-test-token-hash",
    ...overrides,
  });
}

const ENVELOPE: LocalRunEnvelope = buildLocalRunEnvelope({
  input: { sandboxId: "sb-d1", repoUrl: "https://github.com/o/r", baseBranch: "main", task: "t" },
  harnessName: "opencode",
  workdir: "/workspace/sb-d1",
  configFiles: [],
  setupCommands: [],
  argv: ["opencode", "run"],
  env: {},
  dummyKey: DUMMY_PROVIDER_KEY,
  execAllowlist: [["npm", "test"]],
  setupAllowlist: [["mkdir"]],
  deadlineAt: Date.now() + 60_000,
});

const RESULT: LocalRunResult = {
  status: "completed",
  exitCode: 0,
  summary: "done",
  stderrTail: "",
  changedFiles: ["a.ts"],
  diff: "diff --git a/a.ts b/a.ts\n",
  files: [{ path: "a.ts", content: "x", encoding: "utf8" }],
  signals: [{ kind: "exec.settled", at: 1, detail: '{"command":"npm test","exit":0}' }],
};

describe("local immutable publication identity", () => {
  it("preserves a frozen 40-hex base revision while accepting older daemon results", () => {
    const baseRevision = "a".repeat(40);
    expect(localRunResultSchema.parse({ ...RESULT, baseRevision }).baseRevision).toBe(baseRevision);
    expect(localRunResultSchema.parse(RESULT).baseRevision).toBeUndefined();
    for (const invalid of ["main", "a".repeat(39), "A".repeat(40), "a".repeat(64), "../../HEAD"]) {
      expect(localRunResultSchema.safeParse({ ...RESULT, baseRevision: invalid }).success).toBe(false);
    }
  });
});

const post = (path: string, body: unknown) =>
  new Request(`https://local-dispatch${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("LocalDispatch DO", () => {
  it("dispatch → claim → result settles; the claimToken is the result credential", async () => {
    const { obj } = makeDispatch();
    expect((await obj.fetch(post("/dispatch", { envelope: ENVELOPE }))).status).toBe(200);
    expect((await obj.fetch(post("/dispatch", { envelope: ENVELOPE }))).status).toBe(409); // live duplicate

    const claim = await obj.fetch(post("/claim", { operator: "op@test" }));
    const claimBody = (await claim.json()) as { envelope: LocalRunEnvelope | null; claimToken?: string };
    expect(claimBody.envelope?.sandboxId).toBe("sb-d1");
    expect(claimBody.claimToken).toBeTruthy();
    // Second daemon finds nothing pending.
    const empty = (await (await obj.fetch(post("/claim", {}))).json()) as { envelope: null };
    expect(empty.envelope).toBeNull();

    // A wrong token cannot settle the run.
    expect(
      (await obj.fetch(post("/result", { sandboxId: "sb-d1", claimToken: "forged", result: RESULT }))).status,
    ).toBe(409);
    expect(
      (await obj.fetch(post("/result", { sandboxId: "sb-d1", claimToken: claimBody.claimToken, result: RESULT }))).status,
    ).toBe(200);

    const status = (await (await obj.fetch(new Request("https://local-dispatch/status?sandboxId=sb-d1"))).json()) as {
      status: string;
      result?: LocalRunResult;
    };
    expect(status.status).toBe("settled");
    expect(status.result?.changedFiles).toEqual(["a.ts"]);
  });

  it("scopes harness visibility and decisions to the queued dashboard owner", async () => {
    const { obj } = makeDispatch();
    await obj.fetch(post("/dispatch", { envelope: ENVELOPE, dashboardOwnerId: "alice@example.com" }));
    const claimBody = (await (await obj.fetch(post("/claim", { operator: "op@test" }))).json()) as {
      claimToken: string;
    };
    await obj.fetch(post("/approval", {
      sandboxId: "sb-d1",
      claimToken: claimBody.claimToken,
      request: { requestId: "req-1", kind: "command", title: "Run shell", detail: "ls" },
    }));
    const bobView = await obj.fetch(
      new Request("https://local-dispatch/harness", { headers: { [LOCAL_DASHBOARD_OWNER_HEADER]: "bob@example.com" } }),
    );
    expect(((await bobView.json()) as { runs: unknown[] }).runs).toEqual([]);
    const aliceView = await obj.fetch(
      new Request("https://local-dispatch/harness", { headers: { [LOCAL_DASHBOARD_OWNER_HEADER]: "alice@example.com" } }),
    );
    expect(((await aliceView.json()) as { runs: unknown[] }).runs).toHaveLength(1);
    const denied = await obj.fetch(
      new Request("https://local-dispatch/harness-decide", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [LOCAL_DASHBOARD_OWNER_HEADER]: "bob@example.com",
        },
        body: JSON.stringify({ sandboxId: "sb-d1", requestId: "req-1", decision: "allow" }),
      }),
    );
    expect(denied.status).toBe(403);
  });

  it("pins a record to targetMachineId; only the matching vouched machine (or anyone, if unpinned) claims it", async () => {
    const { obj, storage } = makeDispatch();
    await registerComputer(storage, "m-1");
    const claimAs = async (machine?: string) =>
      (await (
        await obj.fetch(
          new Request("https://local-dispatch/claim", {
            method: "POST",
            headers: { "content-type": "application/json", ...(machine !== undefined ? { [LOCAL_MACHINE_HEADER]: machine } : {}) },
            body: "{}",
          }),
        )
      ).json()) as { envelope: LocalRunEnvelope | null };
    expect((await obj.fetch(post("/dispatch", { envelope: ENVELOPE, targetMachineId: " m-1 " }))).status).toBe(200);
    expect((await claimAs("m-2")).envelope).toBeNull();
    expect((await claimAs()).envelope).toBeNull(); // shared token: no vouched id, no pinned runs
    expect((await claimAs("m-1")).envelope?.sandboxId).toBe("sb-d1");

    const unpinned = { ...ENVELOPE, sandboxId: "sb-d2" };
    await obj.fetch(post("/dispatch", { envelope: unpinned }));
    expect((await claimAs()).envelope?.sandboxId).toBe("sb-d2");
    await obj.fetch(post("/dispatch", { envelope: { ...ENVELOPE, sandboxId: "sb-d3" } }));
    expect((await claimAs("m-9")).envelope?.sandboxId).toBe("sb-d3");
  });

  it("refuses a targetMachineId over 128 chars", async () => {
    const { obj, storage } = makeDispatch();
    await registerComputer(storage, "x".repeat(128));
    expect((await obj.fetch(post("/dispatch", { envelope: ENVELOPE, targetMachineId: "x".repeat(129) }))).status).toBe(400);
    expect((await obj.fetch(post("/dispatch", { envelope: ENVELOPE, targetMachineId: "x".repeat(128) }))).status).toBe(200);
  });

  it.each([null, 7, false, {}, []])("rejects a non-string target without silently dispatching unpinned work: %j", async (targetMachineId) => {
    const { obj, storage } = makeDispatch();
    expect((await obj.fetch(post("/dispatch", { envelope: ENVELOPE, targetMachineId }))).status).toBe(400);
    expect(await storage.get("run:sb-d1")).toBeUndefined();
  });

  it.each([
    ["unknown", 404],
    ["revoked", 404],
    ["shared-token-only", 404],
    ["offline", 409],
    ["incompatible", 409],
  ])("rejects a pinned %s computer before writing pending work", async (kind, status) => {
    const { obj, storage } = makeDispatch();
    if (kind !== "unknown") {
      await registerComputer(storage, "target", {
        ...(kind === "shared-token-only" ? { tokenHash: undefined } : {}),
        ...(kind === "offline" ? { lastHeartbeat: Date.now() - LOCAL_HEARTBEAT_STALE_MS - 1 } : {}),
        ...(kind === "incompatible" ? { harnesses: ["codex"] } : {}),
      });
    }
    if (kind === "revoked") {
      expect((await obj.fetch(post("/revoke-computer", { machineId: "target" }))).status).toBe(200);
    }
    const response = await obj.fetch(post("/dispatch", { envelope: ENVELOPE, targetMachineId: "target" }));
    expect(response.status).toBe(status);
    expect(await storage.get("run:sb-d1")).toBeUndefined();
    expect(await (await obj.fetch(new Request("https://local-dispatch/pending"))).json()).toEqual({ pending: [] });
  });

  it.each([
    ["claude-code", "claude"],
    ["codex", "codex"],
    ["opencode", "opencode"],
  ])("allows a live busy target advertising %s's daemon executable", async (harness, executable) => {
    const { obj, storage } = makeDispatch();
    await registerComputer(storage, "busy-target", { harnesses: [executable], activeRunId: "another-run" });
    const response = await obj.fetch(post("/dispatch", {
      envelope: { ...ENVELOPE, harness, argv: [executable, "run"] }, targetMachineId: "busy-target",
    }));
    expect(response.status).toBe(200);
    expect(await storage.get("run:sb-d1")).toMatchObject({ status: "pending", targetMachineId: "busy-target" });
  });

  it("does not admit a sandbox-only harness just because its executable exists on the target", async () => {
    const { obj, storage } = makeDispatch();
    await registerComputer(storage, "target", { harnesses: ["claude"] });
    expect((await obj.fetch(post("/dispatch", {
      envelope: { ...ENVELOPE, harness: "claude-subscription" }, targetMachineId: "target",
    }))).status).toBe(409);
    expect(await storage.get("run:sb-d1")).toBeUndefined();
  });

  it("preserves shared-token unpinned dispatch without a paired computer", async () => {
    const { obj, storage } = makeDispatch();
    expect((await obj.fetch(post("/dispatch", { envelope: ENVELOPE }))).status).toBe(200);
    expect([...storage.__map.keys()].some((key) => key.startsWith("computer:"))).toBe(false);
    const claim = await (await obj.fetch(post("/claim", { operator: "legacy-shared-token" }))).json() as { envelope?: LocalRunEnvelope };
    expect(claim.envelope?.sandboxId).toBe(ENVELOPE.sandboxId);
  });

  it("cancel marks the record and a settled record stays settled", async () => {
    const { obj } = makeDispatch();
    await obj.fetch(post("/dispatch", { envelope: ENVELOPE }));
    expect((await obj.fetch(post("/cancel", { sandboxId: "sb-d1" }))).status).toBe(200);
    const status = (await (await obj.fetch(new Request("https://local-dispatch/status?sandboxId=sb-d1"))).json()) as { status: string };
    expect(status.status).toBe("cancelled");
    // A cancelled record frees the sandboxId for re-dispatch.
    expect((await obj.fetch(post("/dispatch", { envelope: ENVELOPE }))).status).toBe(200);
  });

  it("reaps a claim whose holder went stale", async () => {
    const { obj, storage } = makeDispatch();
    await obj.fetch(post("/dispatch", { envelope: ENVELOPE }));
    const claim = await obj.fetch(post("/claim", {}));
    expect(claim.status).toBe(200);
    // Rewind the claim past the stale window — the daemon died mid-run.
    const record = (await storage.get<{ envelope: LocalRunEnvelope } & Record<string, unknown>>("run:sb-d1"))!;
    await storage.put("run:sb-d1", { ...record, claimedAt: Date.now() - LOCAL_CLAIM_STALE_MS - 1 });
    const status = (await (await obj.fetch(new Request("https://local-dispatch/status?sandboxId=sb-d1"))).json()) as { status: string };
    expect(status.status).toBe("cancelled");
  });

  it("a targeted record is skipped by other machines; untargeted is open to all; identity-less callers get unpinned only", async () => {
    const { obj, storage } = makeDispatch();
    await registerComputer(storage, "m-a");
    const claimAs = async (machineId?: string) => {
      const req = post("/claim", {});
      if (machineId !== undefined) req.headers.set(LOCAL_MACHINE_HEADER, machineId);
      return ((await (await obj.fetch(req)).json()) as { envelope: LocalRunEnvelope | null }).envelope?.sandboxId ?? null;
    };
    await obj.fetch(post("/dispatch", { envelope: ENVELOPE, targetMachineId: "m-a" }));
    expect(await claimAs("m-b")).toBeNull();
    expect(await claimAs("m-a")).toBe("sb-d1");

    // Untargeted: any machine claims it.
    const untargeted = { ...ENVELOPE, sandboxId: "sb-any", createdAt: ENVELOPE.createdAt + 1 };
    await obj.fetch(post("/dispatch", { envelope: untargeted }));
    expect(await claimAs("m-b")).toBe("sb-any");

    // Shared-token daemon (no vouched machine id) must not claim a pinned run.
    const pinned = { ...ENVELOPE, sandboxId: "sb-pinned", createdAt: ENVELOPE.createdAt + 2 };
    await obj.fetch(post("/dispatch", { envelope: pinned, targetMachineId: "m-a" }));
    expect(await claimAs()).toBeNull();
  });

  it("skipping a targeted record still hands the next one to the caller in order", async () => {
    const { obj, storage } = makeDispatch();
    await registerComputer(storage, "m-a");
    await obj.fetch(post("/dispatch", { envelope: ENVELOPE, targetMachineId: "m-a" }));
    await obj.fetch(post("/dispatch", { envelope: { ...ENVELOPE, sandboxId: "sb-later", createdAt: ENVELOPE.createdAt + 1 } }));
    const req = post("/claim", {});
    req.headers.set(LOCAL_MACHINE_HEADER, "m-b");
    const claimed = (await (await obj.fetch(req)).json()) as { envelope: LocalRunEnvelope | null };
    expect(claimed.envelope?.sandboxId).toBe("sb-later");
  });

  it("refuses malformed envelopes and results", async () => {
    const { obj } = makeDispatch();
    expect((await obj.fetch(post("/dispatch", { envelope: { sandboxId: "x" } }))).status).toBe(400);
    expect((await obj.fetch(post("/result", { sandboxId: "none", claimToken: "t", result: RESULT }))).status).toBe(404);
  });
});

// ── Intake boundary: the sharpest edge ──────────────────────────────────

function makeOrchestrator(env: Record<string, unknown> = {}, name = "default") {
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: { ...productionEnvStubs(), ...env },
    name,
    state: { runs: [] } as { runs: unknown[]; pendingApprovals?: unknown[] },
    setState(next: unknown) {
      setStateLikeProduction(this as unknown as CodingOrchestrator, next as Parameters<CodingOrchestrator["setState"]>[0]);
    },
  });
  return instance as unknown as {
    onRequest: (request: Request) => Promise<Response>;
    state: { runs: unknown[]; pendingApprovals?: { runtime?: string; approvalId: string }[] };
    name: string;
  };
}

function queueRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://internal/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const RUN_BODY = { repoUrl: "https://github.com/o/r", task: "fix the tests" };

describe("T51 intake boundary", () => {
  const artifactInput = { repoUrl: "", task: "Write a brief", runtime: "local", harness: "opencode",
    executionTarget: { kind: "artifact-workspace", workspaceId: "local-brief", expectedDeliverables: ["out/brief.md"] } };

  it("freezes explicitly selected local artifacts without starting execution", async () => {
    const orchestrator = makeOrchestrator({ [LOCAL_RUNTIME_FLAG]: "1", AI_GATEWAY_TOKEN: "" });
    const response = await orchestrator.onRequest(queueRequest(artifactInput, { [LOCAL_INTAKE_HEADER]: LOCAL_INTAKE_DASHBOARD }));
    expect(response.status, await response.clone().text()).toBe(200);
    expect(orchestrator.state.pendingApprovals?.[0]).toMatchObject({ status: "pending", runtime: "local", repoUrl: "",
      expectedDeliverables: ["out/brief.md"], executionTarget: artifactInput.executionTarget });
    expect(orchestrator.state.runs).toEqual([]);
  });

  it.each([
    { headers: {}, env: { [LOCAL_RUNTIME_FLAG]: "1" }, status: 403 },
    { headers: { [LOCAL_INTAKE_HEADER]: LOCAL_INTAKE_DASHBOARD }, env: {}, status: 403 },
  ])("retains local artifact authority gates: %j", async ({ headers, env, status }) => {
    expect((await makeOrchestrator(env).onRequest(queueRequest(artifactInput, headers as Record<string, string>))).status).toBe(status);
  });

  it.each([
    { executionTarget: { ...artifactInput.executionTarget, expectedDeliverables: [] } },
    { publishPullRequest: true }, { runSetup: true }, { repoUrl: "https://github.com/o/r" },
  ])("rejects conflicting local artifact authority: %j", async (extra) => {
    const orchestrator = makeOrchestrator({ [LOCAL_RUNTIME_FLAG]: "1" });
    expect((await orchestrator.onRequest(queueRequest({ ...artifactInput, ...extra }, { [LOCAL_INTAKE_HEADER]: LOCAL_INTAKE_DASHBOARD }))).status).toBe(400);
    expect(orchestrator.state.pendingApprovals ?? []).toEqual([]);
  });

  it("rejects an unknown runtime value", async () => {
    const res = await makeOrchestrator({ [LOCAL_RUNTIME_FLAG]: "1" }).onRequest(
      queueRequest({ ...RUN_BODY, runtime: "nonsense" }),
    );
    expect(res.status).toBe(400);
  });

  it("refuses runtime:\"local\" when the deployment flag is off", async () => {
    const res = await makeOrchestrator({}).onRequest(
      queueRequest({ ...RUN_BODY, runtime: "local" }, { [LOCAL_INTAKE_HEADER]: LOCAL_INTAKE_DASHBOARD }),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("SHIBA_LOCAL_RUNTIME");
  });

  it("refuses runtime:\"local\" without the dashboard voucher — every chat/internal surface posts bare", async () => {
    // Slack, MCP, email, and automation intakes all reach this same handler
    // with no X-Shiba-Intake header — only the Worker's authenticated
    // /api/runs forward stamps it.
    const res = await makeOrchestrator({ [LOCAL_RUNTIME_FLAG]: "1" }).onRequest(
      queueRequest({ ...RUN_BODY, runtime: "local" }),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("dashboard");
  });

  it("refuses a forged voucher value", async () => {
    const res = await makeOrchestrator({ [LOCAL_RUNTIME_FLAG]: "1" }).onRequest(
      queueRequest({ ...RUN_BODY, runtime: "local" }, { [LOCAL_INTAKE_HEADER]: "slack" }),
    );
    expect(res.status).toBe(403);
  });

  it("refuses a harness that does not declare the local runtime", async () => {
    const res = await makeOrchestrator({ [LOCAL_RUNTIME_FLAG]: "1" }).onRequest(
      queueRequest(
        { ...RUN_BODY, runtime: "local", harness: "grok" },
        { [LOCAL_INTAKE_HEADER]: LOCAL_INTAKE_DASHBOARD },
      ),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("does not run on the local runtime");
  });

  it("mints an approval carrying the frozen runtime when flag + voucher + harness all hold", async () => {
    const orchestrator = makeOrchestrator({ [LOCAL_RUNTIME_FLAG]: "1" });
    const res = await orchestrator.onRequest(
      queueRequest({ ...RUN_BODY, runtime: "local", harness: "opencode" }, { [LOCAL_INTAKE_HEADER]: LOCAL_INTAKE_DASHBOARD }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; approvalId: string };
    expect(body.ok).toBe(true);
    const approval = orchestrator.state.pendingApprovals?.find((a) => a.approvalId === body.approvalId);
    expect(approval?.runtime).toBe("local");
  });

  describe("targetMachineId intake", () => {
    const queueLocal = (extra: Record<string, unknown>, orchestrator = makeOrchestrator({ [LOCAL_RUNTIME_FLAG]: "1" })) =>
      orchestrator.onRequest(
        queueRequest({ ...RUN_BODY, runtime: "local", harness: "opencode", ...extra }, { [LOCAL_INTAKE_HEADER]: LOCAL_INTAKE_DASHBOARD }),
      );

    it("400s an empty, over-long, or non-string target", async () => {
      expect((await queueLocal({ targetMachineId: "" })).status).toBe(400);
      expect((await queueLocal({ targetMachineId: "   " })).status).toBe(400);
      expect((await queueLocal({ targetMachineId: "x".repeat(129) })).status).toBe(400);
      expect((await queueLocal({ targetMachineId: 7 })).status).toBe(400);
    });

    it("trims the target and freezes it on the approval", async () => {
      const orchestrator = makeOrchestrator({ [LOCAL_RUNTIME_FLAG]: "1" });
      const res = await queueLocal({ targetMachineId: "  m-1  " }, orchestrator);
      expect(res.status).toBe(200);
      const { approvalId } = (await res.json()) as { approvalId: string };
      const approval = orchestrator.state.pendingApprovals?.find((a) => a.approvalId === approvalId) as { targetMachineId?: string };
      expect(approval.targetMachineId).toBe("m-1");
    });

    it("ignores the target when the runtime is not local", async () => {
      const orchestrator = makeOrchestrator({});
      const res = await orchestrator.onRequest(queueRequest({ ...RUN_BODY, runtime: "sandbox", targetMachineId: "m-1" }));
      expect(res.status).toBe(200);
      const { approvalId } = (await res.json()) as { approvalId: string };
      const approval = orchestrator.state.pendingApprovals?.find((a) => a.approvalId === approvalId) as { targetMachineId?: string };
      expect(approval.targetMachineId).toBeUndefined();
    });
  });

  it("runtime:\"sandbox\" queues normally with no flag and no voucher", async () => {
    const orchestrator = makeOrchestrator({});
    const res = await orchestrator.onRequest(queueRequest({ ...RUN_BODY, runtime: "sandbox" }));
    expect(res.status).toBe(200);
  });
});

// ── Approval gate: provably unchanged ───────────────────────────────────

const DELEGATE_INPUT = { repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false };

describe("approval gate under runtime selection", () => {
  it("refuses execution with no approved pointer — the T40 gate stands", async () => {
    const orchestrator = makeOrchestrator({ [LOCAL_RUNTIME_FLAG]: "1" });
    const child = vi.fn(async () => "");
    const out = await (orchestrator as unknown as {
      executeDelegatedTask: (i: unknown, c: unknown, id: string) => Promise<string>;
    }).executeDelegatedTask({ ...DELEGATE_INPUT, runtime: "local" }, child, "call-no-approval");
    expect(out).toBe("Run is not approved to execute.");
    expect(child).not.toHaveBeenCalled();
  });

  it("refuses when the call's runtime drifts from the approved input", async () => {
    const orchestrator = makeOrchestrator({ [LOCAL_RUNTIME_FLAG]: "1" }, "web:user:sess");
    approveDirect(orchestrator as never, "call-mismatch", { ...DELEGATE_INPUT }); // approved as sandbox
    const child = vi.fn(async () => "");
    const out = await (orchestrator as unknown as {
      executeDelegatedTask: (i: unknown, c: unknown, id: string) => Promise<string>;
    }).executeDelegatedTask({ ...DELEGATE_INPUT, runtime: "local" }, child, "call-mismatch");
    expect(out).toBe("Approved input does not match this call's runtime.");
    expect(child).not.toHaveBeenCalled();
    // And the reserved run never started.
    expect((orchestrator.state.runs[0] as { status: string }).status).toBe("pending");
  });

  it("refuses a local run on a Slack-thread DO even with the flag on", async () => {
    const orchestrator = makeOrchestrator({ [LOCAL_RUNTIME_FLAG]: "1" }, "slack:T1:C1:1234.5678");
    approveDirect(orchestrator as never, "call-slack", { ...DELEGATE_INPUT, runtime: "local" });
    const child = vi.fn(async () => "");
    const out = await (orchestrator as unknown as {
      executeDelegatedTask: (i: unknown, c: unknown, id: string) => Promise<string>;
    }).executeDelegatedTask({ ...DELEGATE_INPUT, runtime: "local" }, child, "call-slack");
    expect(out).toContain("dashboard session");
    expect(child).not.toHaveBeenCalled();
  });

  it("refuses a local run on the shared \"default\" DO — automations cannot dispatch local", async () => {
    const orchestrator = makeOrchestrator({ [LOCAL_RUNTIME_FLAG]: "1" }, "default");
    approveDirect(orchestrator as never, "call-default", { ...DELEGATE_INPUT, runtime: "local" });
    const child = vi.fn(async () => "");
    const out = await (orchestrator as unknown as {
      executeDelegatedTask: (i: unknown, c: unknown, id: string) => Promise<string>;
    }).executeDelegatedTask({ ...DELEGATE_INPUT, runtime: "local" }, child, "call-default");
    expect(out).toContain("dashboard session");
    expect(child).not.toHaveBeenCalled();
  });
});

// ── Worker surface: the voucher stamp + the daemon bearer ───────────────

function workerEnv(orchestrator: { onRequest: (r: Request) => Promise<Response> }, dispatch?: LocalDispatch) {
  mocks.getAgentByName.mockImplementation(async (_ns: unknown, name: string) => ({
    name,
    fetch: (request: Request | string) => {
      // Real stubs take strings too (sessionCheck fetches "https://internal/...").
      const req = typeof request === "string" ? new Request(request) : request;
      const url = new URL(req.url);
      if (url.pathname.startsWith("/internal/web-sessions/")) {
        const id = decodeURIComponent(url.pathname.split("/").pop()!);
        return Promise.resolve(Response.json({ session: { id, userId: name,
          agentName: buildSessionAgentName(name, id), name: "Local runtime fixture session",
          createdAt: 1, updatedAt: 1, metadata: {} } }));
      }
      return orchestrator.onRequest(req);
    },
  }));
  return {
    CodingOrchestrator: {} as never,
    ...(dispatch !== undefined
      ? {
          LocalDispatch: {
            idFromName: (name: string) => name,
            get: () => ({ fetch: (r: Request) => dispatch.fetch(r) }),
          } as never,
        }
      : {}),
  };
}

describe("Worker /api/runs intake stamping", () => {
  it("the authenticated /api/runs path stamps the voucher; an inbound copy is stripped", async () => {
    const orchestrator = makeOrchestrator({ [LOCAL_RUNTIME_FLAG]: "1" });
    const env = workerEnv(orchestrator);
    const res = await worker.fetch(
      new Request("http://localhost/api/runs?session=11111111-2222-3333-4444-555555555555", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // A caller-forged value is deleted and replaced.
          [LOCAL_INTAKE_HEADER]: "slack",
        },
        body: JSON.stringify({ ...RUN_BODY, runtime: "local", harness: "opencode" }),
      }),
      env as never,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const approval = orchestrator.state.pendingApprovals?.[0];
    expect(approval?.runtime).toBe("local");
    // It routed to the dashboard session DO.
    expect(mocks.getAgentByName).toHaveBeenCalledWith(expect.anything(), "web:default:11111111-2222-3333-4444-555555555555");
  });
});

describe("Worker /api/local daemon surface", () => {
  const daemonPost = (sub: string, body: unknown, token?: string) =>
    new Request(`https://shiba.test/api/local/${sub}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });

  it("is dark when the flag is off or the token unset", async () => {
    const orchestrator = makeOrchestrator();
    expect((await worker.fetch(daemonPost("claim", {}, "x"), { ...workerEnv(orchestrator), LOCAL_DISPATCH: {} } as never)).status).toBe(404);
    const env = { ...workerEnv(orchestrator), [LOCAL_RUNTIME_FLAG]: "1", LocalDispatch: undefined } as never;
    expect((await worker.fetch(daemonPost("claim", {}, "x"), env)).status).toBe(404);
  });

  it("rejects a wrong bearer and serves the right one", async () => {
    const { obj } = makeDispatch();
    await obj.fetch(post("/dispatch", { envelope: ENVELOPE }));
    const env = {
      ...workerEnv(makeOrchestrator(), obj),
      [LOCAL_RUNTIME_FLAG]: "1",
      LOCAL_ADAPTER_TOKEN: "daemon-secret",
    } as never;
    expect((await worker.fetch(daemonPost("claim", {}, "wrong"), env)).status).toBe(401);
    const res = await worker.fetch(daemonPost("claim", { operator: "op@box" }, "daemon-secret"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { envelope: LocalRunEnvelope | null; claimToken?: string };
    expect(body.envelope?.sandboxId).toBe("sb-d1");
    expect(body.claimToken).toBeTruthy();
  });

  it("only claim/result/status/pending are reachable — no dispatch surface exists for the daemon", async () => {
    const { obj } = makeDispatch();
    const env = {
      ...workerEnv(makeOrchestrator(), obj),
      [LOCAL_RUNTIME_FLAG]: "1",
      LOCAL_ADAPTER_TOKEN: "daemon-secret",
    } as never;
    expect((await worker.fetch(daemonPost("dispatch", { envelope: ENVELOPE }, "daemon-secret"), env)).status).toBe(404);
  });
});

// ── LocalRuntimeAdapter ─────────────────────────────────────────────────

function makeClient(overrides: Partial<LocalDispatchClient> = {}) {
  const state = {
    dispatched: [] as LocalRunEnvelope[],
    cancelled: [] as string[],
    statuses: [
      { status: "pending" },
      { status: "claimed", claimedBy: "op@box", claimedAt: 1 },
      { status: "settled", result: RESULT },
    ] as const,
  };
  let index = 0;
  const client: LocalDispatchClient = {
    dispatch: async (envelope) => void state.dispatched.push(envelope),
    status: async () => state.statuses[Math.min(index++, state.statuses.length - 1)] as never,
    cancel: async (sandboxId) => void state.cancelled.push(sandboxId),
    ...overrides,
  };
  return { client, state };
}

const TASK_INPUT = {
  repoUrl: "https://github.com/o/r",
  task: "fix the tests",
  baseBranch: "main",
  publishPullRequest: false,
  sandboxId: "sb-d1",
  codingModel: "google/gemini-3.5-flash-lite",
};

const NOOP_OPS = {} as never;
const NOOP_EMIT = async () => {};

describe("LocalRuntimeAdapter", () => {
  it("dispatches approved bounded repository-free artifacts without a dummy repository", async () => {
    const executionTarget = { kind: "artifact-workspace" as const, workspaceId: "artifact-fixture", expectedDeliverables: ["out/brief.md"] };
    const { client, state } = makeClient({ status: async () => ({ status: "settled", result: {
      ...RESULT, baseRevision: undefined, changedFiles: ["out/brief.md"], diff: "", files: [{ path: "out/brief.md", content: "# Complete brief\n", encoding: "utf8" }],
    } }) as never });
    const adapter = new LocalRuntimeAdapter(resolveHarness("opencode"), { client, pollIntervalMs: 0 });
    const result = await adapter.runCodingTask(NOOP_OPS, { ...TASK_INPUT, repoUrl: "", executionTarget,
      expectedDeliverables: executionTarget.expectedDeliverables } as never, NOOP_EMIT, {});
    expect(result.status).toBe("completed");
    expect(state.dispatched[0]).toMatchObject({ repoUrl: "", executionTarget, expectedDeliverables: ["out/brief.md"] });
    expect(state.dispatched[0]?.task).toContain("current working directory");
    expect(result.files).toEqual([{ path: "out/brief.md", content: "# Complete brief\n", encoding: "utf8" }]);
  });

  it("rejects unapproved artifact bytes from a daemon response", async () => {
    const executionTarget = { kind: "artifact-workspace" as const, expectedDeliverables: ["brief.md"] };
    const { client } = makeClient({ status: async () => ({ status: "settled", result: {
      ...RESULT, baseRevision: undefined, changedFiles: ["brief.md"], diff: "", files: [
        { path: "brief.md", content: "Complete", encoding: "utf8" },
        { path: "private.md", content: "not approved", encoding: "utf8" },
      ],
    } }) as never });
    const adapter = new LocalRuntimeAdapter(resolveHarness("opencode"), { client, pollIntervalMs: 0 });
    const result = await adapter.runCodingTask(NOOP_OPS, { ...TASK_INPUT, repoUrl: "", executionTarget,
      expectedDeliverables: ["brief.md"] } as never, NOOP_EMIT, {});
    expect(result.status).toBe("error");
    expect(result.summary).toContain("unapproved files");
    expect(result.files).toEqual([]);
  });

  it.each([
    { expectedDeliverables: [] },
    { expectedDeliverables: ["other.md"] },
    { expectedDeliverables: ["brief.md"], publishPullRequest: true },
  ])("rejects incomplete or conflicting artifact authority: %j", async (fields) => {
    const { client, state } = makeClient();
    const adapter = new LocalRuntimeAdapter(resolveHarness("opencode"), { client, pollIntervalMs: 0 });
    const result = await adapter.runCodingTask(NOOP_OPS, { ...TASK_INPUT, repoUrl: "", ...fields,
      executionTarget: { kind: "artifact-workspace", expectedDeliverables: ["brief.md"] } } as never, NOOP_EMIT, {});
    expect(result.status).toBe("error");
    expect(state.dispatched).toEqual([]);
  });

  it.each([
    { kind: "artifact-workspace", expectedDeliverables: ["brief.md"] },
    { kind: "connected-app", connectionId: "private-app", action: "read" },
  ])("refuses a $kind target before config, credentials, dispatch or polling", async (executionTarget) => {
    const forbidden = vi.fn(() => { throw new Error("Must not access provider configuration."); });
    const harness = Object.assign(Object.create(resolveHarness("claude-code")), {
      configFile: forbidden, env: forbidden, setupCommands: forbidden, buildArgv: forbidden,
    });
    const status = vi.fn();
    const { client, state } = makeClient({ status });
    const adapter = new LocalRuntimeAdapter(harness, { client, pollIntervalMs: 0 });
    const result = await adapter.runCodingTask(NOOP_OPS, { ...TASK_INPUT, executionTarget } as never, NOOP_EMIT, {});
    expect(result.status).toBe("error");
    expect(result.summary).toContain("matching nonempty approved deliverables");
    expect(forbidden).not.toHaveBeenCalled();
    expect(state.dispatched).toEqual([]);
    expect(status).not.toHaveBeenCalled();
  });

  it("dispatches only the personal native account envelope without reading deployment harness config or keys", async () => {
    const snapshot: PersonalExecutionSnapshot = { version: 1, grantId: `plex_${"a".repeat(32)}`, grantVersion: 1,
      ownerAccountId: "native-owner", actorId: "owner@example.test", workspaceId: `ws_${"a".repeat(24)}`, membershipVersion: 1,
      machineId: "personal-machine", machineRevision: 1, harness: "claude-code", billingMode: "native-subscription",
      accountFingerprint: "a".repeat(64), authVersion: "b".repeat(64), codingModel: "anthropic/claude-sonnet-4-6",
      repoUrl: "https://github.com/o/r", expiresAt: Date.now() + 60_000, allowedPhases: ["local_repository_task"] };
    const proof = { snapshot, approvalId: "personal-approval", inputHash: "c".repeat(64), contextDigest: "d".repeat(64),
      executionOwner: "web:owner@example.test:11111111-1111-4111-8111-111111111111", handoffId: "personal-handoff", generation: 1, approvedUntil: Date.now() + 30_000 };
    const forbiddenBuilder = vi.fn(() => { throw new Error("Deployment harness config is forbidden."); });
    const harness = Object.assign(Object.create(resolveHarness("claude-code")), { configFile: forbiddenBuilder, env: forbiddenBuilder,
      setupCommands: forbiddenBuilder, buildArgv: forbiddenBuilder, verify: vi.fn(async () => ({ ok: true as const })) });
    const dispatch = vi.fn(async (_envelope: LocalRunEnvelope, _target?: string, _actor?: string) => {});
    const { client } = makeClient({ dispatch, status: async () => ({ status: "settled", result: RESULT }) });
    const adapter = new LocalRuntimeAdapter(harness, { client, pollIntervalMs: 0 });
    const input = { ...TASK_INPUT, codingModel: snapshot.codingModel, harness: snapshot.harness, runtime: "local" as const,
      initiatorUserId: snapshot.actorId, targetMachineId: snapshot.machineId, personalExecution: snapshot, personalExecutionClaim: proof };
    expect((await adapter.runCodingTask(NOOP_OPS, input, NOOP_EMIT)).status).toBe("completed");
    expect(forbiddenBuilder).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]).toMatchObject([{ task: TASK_INPUT.task, personalExecution: proof, argv: [], env: {}, configFiles: [], setupCommands: [], setupAllowlist: [],
      deadlineAt: proof.approvedUntil, session: { provider: "claude", model: "claude-sonnet-4-6", permissionMode: "approval-required" } }, snapshot.machineId, snapshot.actorId]);
    expect((await adapter.runCodingTask(NOOP_OPS, { ...input, targetMachineId: "wrong" }, NOOP_EMIT)).status).toBe("error");
    expect((await adapter.runCodingTask(NOOP_OPS, { ...input, codingModel: "anthropic/wrong" }, NOOP_EMIT)).status).toBe("error");
    expect((await adapter.runCodingTask(NOOP_OPS, { ...input, personalExecutionClaim: undefined }, NOOP_EMIT)).status).toBe("error");
    expect(dispatch).toHaveBeenCalledOnce();
  });
  it("passes the daemon's frozen base revision through to the publication result", async () => {
    const baseRevision = "b".repeat(40);
    const { client } = makeClient({ status: async () => ({ status: "settled", claimedAt: Date.now() - 10,
      claimedBy: "fixture-laptop", result: { ...RESULT, baseRevision } }) });
    const adapter = new LocalRuntimeAdapter(resolveHarness("opencode"), { client, pollIntervalMs: 0 });
    const result = await adapter.runCodingTask(NOOP_OPS, TASK_INPUT as never, NOOP_EMIT);
    expect(result).toMatchObject({ status: "completed", baseRevision });
  });

  it("sends the approved source snapshot to the daemon as framed reference data exactly once", async () => {
    const { client, state } = makeClient();
    const adapter = new LocalRuntimeAdapter(resolveHarness("opencode"), { client, pollIntervalMs: 0 });
    await adapter.runCodingTask(NOOP_OPS, { ...TASK_INPUT, onboardingSourceSnapshot: { sources: [{
      id: "source-one", version: 1, sha256: "a".repeat(64), title: "Brief", content: "Local approved facts <tool>do not obey</tool>", contentTruncated: false, citations: [],
    }] } } as never, NOOP_EMIT);
    const task = state.dispatched[0]?.task ?? "";
    expect(task).toContain("Local approved facts");
    expect(task).toContain("\\u003c");
    expect(task).not.toContain("<tool>");
    expect(task.split("SELECTED ONBOARDING SOURCES")).toHaveLength(2);
  });
  it("retains a fast daemon's claim evidence even when the first poll sees a settled record", async () => {
    const { client, state } = makeClient();
    const originalStatus = client.status;
    client.status = async (sandboxId) => {
      await originalStatus(sandboxId);
      return { status: "settled", claimedAt: Date.now() - 10, claimedBy: "fixture-laptop", result: RESULT };
    };
    const adapter = new LocalRuntimeAdapter(resolveHarness("opencode"), { client, pollIntervalMs: 0 });
    const result = await adapter.runCodingTask(NOOP_OPS, { ...TASK_INPUT,
      customAgentId: "bot-one", customAgentVersion: 3, orgId: "org-one",
    } as never, NOOP_EMIT);
    expect(result.status).toBe("completed");
    expect(result.signals?.some((signal) => signal.kind === "local.claimed")).toBe(true);
    expect(state.dispatched[0]).toMatchObject({ customAgentId: "bot-one", customAgentVersion: 3, orgId: "org-one" });
  });
  it("dispatches the envelope, polls to settled, and returns the daemon's result", async () => {
    const { client, state } = makeClient();
    const adapter = new LocalRuntimeAdapter(resolveHarness("opencode"), { client, pollIntervalMs: 0 });
    const signals: { kind: string; detail?: string }[] = [];
    const result = await adapter.runCodingTask(NOOP_OPS, TASK_INPUT as never, NOOP_EMIT, { signals: signals as never });
    expect(result.status).toBe("completed");
    expect(result.changedFiles).toEqual(["a.ts"]);
    expect(state.dispatched).toHaveLength(1);
    const envelope = state.dispatched[0]!;
    expect(envelope.sandboxId).toBe("sb-d1");
    expect(envelope.harness).toBe("opencode");
    expect(envelope.argv[0]).toBe("opencode");
    // The dummy key never leaves the Worker — dropped from env outright.
    expect(Object.values(envelope.env)).not.toContain(DUMMY_PROVIDER_KEY);
    const kinds = signals.map((s) => s.kind);
    expect(kinds).toContain("local.dispatched");
    expect(kinds).toContain("local.claimed");
    expect(kinds).toContain("local.settled");
    // Daemon receipts merged — the exec.settled the verify gate reads.
    expect(kinds).toContain("exec.settled");
  });

  it("passes the approved targetMachineId to the dispatch client", async () => {
    const targets: (string | undefined)[] = [];
    const { client } = makeClient({ dispatch: async (_envelope, target) => void targets.push(target) });
    const adapter = new LocalRuntimeAdapter(resolveHarness("opencode"), { client, pollIntervalMs: 0 });
    await adapter.runCodingTask(NOOP_OPS, { ...TASK_INPUT, targetMachineId: "m-1" } as never, NOOP_EMIT, {});
    await adapter.runCodingTask(NOOP_OPS, TASK_INPUT as never, NOOP_EMIT, {});
    expect(targets).toEqual(["m-1", undefined]);
  });

  it.each(["grok", "pi"])("refuses %s because it does not support the local runtime", async (harnessName) => {
    const { client, state } = makeClient();
    const adapter = new LocalRuntimeAdapter(resolveHarness(harnessName), { client, pollIntervalMs: 0 });
    const result = await adapter.runCodingTask(NOOP_OPS, TASK_INPUT as never, NOOP_EMIT, {});
    expect(result.status).toBe("error");
    expect(result.summary).toContain("does not run on the local runtime");
    expect(state.dispatched).toHaveLength(0);
  });

  it("cancels the record when the run is aborted mid-poll", async () => {
    const { client, state } = makeClient({
      status: async () => ({ status: "pending" }) as never,
    });
    const adapter = new LocalRuntimeAdapter(resolveHarness("opencode"), { client, pollIntervalMs: 5 });
    const controller = new AbortController();
    const promise = adapter.runCodingTask(NOOP_OPS, TASK_INPUT as never, NOOP_EMIT, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toThrow("Run cancelled.");
    expect(state.cancelled).toEqual(["sb-d1"]);
  });

  it("fails closed when the record is cancelled under it", async () => {
    const { client } = makeClient({
      status: async () => ({ status: "cancelled" }) as never,
    });
    const adapter = new LocalRuntimeAdapter(resolveHarness("opencode"), { client, pollIntervalMs: 0 });
    const result = await adapter.runCodingTask(NOOP_OPS, TASK_INPUT as never, NOOP_EMIT, {});
    expect(result.status).toBe("error");
    expect(result.summary).toContain("cancelled");
  });

  it("surfaces a daemon-reported failure as an error, not a completion", async () => {
    const { client } = makeClient({
      status: async () =>
        ({
          status: "settled",
          result: { ...RESULT, status: "error", exitCode: 2, summary: "claude exited", stderrTail: "boom" },
        }) as never,
    });
    const adapter = new LocalRuntimeAdapter(resolveHarness("opencode"), { client, pollIntervalMs: 0 });
    const result = await adapter.runCodingTask(NOOP_OPS, TASK_INPUT as never, NOOP_EMIT, {});
    expect(result.status).toBe("error");
    expect(result.summary).toContain("exited with code 2");
  });
});
