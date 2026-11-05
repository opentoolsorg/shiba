import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildLocalRunEnvelope, type LocalRunEnvelope, type LocalRunResult } from "@shiba/shared";
import { LocalDispatch, LOCAL_MACHINE_HEADER } from "../src/local-dispatch.js";
import { LocalRuntimeAdapter, type LocalDispatchClient } from "../src/runtime.js";
import { resolveHarness } from "../src/harness/index.js";
import { deliverableStorageKey, persistRunDeliverables, verifyExpectedDeliverables } from "../src/run-deliverables.js";

function fixture() {
  const rows = new Map<string, unknown>();
  const storage = {
    get: async <T>(key: string) => rows.get(key) as T | undefined,
    put: async (key: string, value: unknown) => { rows.set(key, value); },
    delete: async (key: string) => rows.delete(key),
    list: async <T>({ prefix }: { prefix: string }) => new Map([...rows].filter(([key]) => key.startsWith(prefix))) as Map<string, T>,
  };
  const dispatch = new LocalDispatch({ storage: { ...storage, transaction: async <T>(fn: (tx: typeof storage) => Promise<T>) => fn(storage) }, waitUntil() {} } as never, {} as never);
  const post = (route: string, body: unknown, machine?: string) => dispatch.fetch(new Request(`https://internal${route}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(machine ? { [LOCAL_MACHINE_HEADER]: machine } : {}) }, body: JSON.stringify(body),
  }));
  return { rows, post, dispatch };
}
const input = {
  sandboxId: "artifact-pipeline", runtime: "local" as const, repoUrl: "", baseBranch: "main", task: "Write the approved brief",
  codingModel: "google/gemini-3.5-flash-lite", targetMachineId: "paired-fixture", initiatorUserId: "owner-fixture",
  expectedDeliverables: ["out/brief.md"], executionTarget: { kind: "artifact-workspace" as const, expectedDeliverables: ["out/brief.md"] },
};

describe("local artifact adapter boundaries", () => {
  it.each([
    { targetMachineId: undefined }, { targetMachineId: " " }, { initiatorUserId: undefined },
    { expectedDeliverables: ["../private.md"], executionTarget: { kind: "artifact-workspace", expectedDeliverables: ["../private.md"] } },
  ])("rejects incomplete authority before dispatch: %j", async (change) => {
    let dispatched = false;
    const client = { dispatch: async () => { dispatched = true; } } as unknown as LocalDispatchClient;
    const result = await new LocalRuntimeAdapter(resolveHarness("opencode"), { client }).runCodingTask({} as never, { ...input, ...change } as never, async () => {});
    expect(result.status).toBe("error");
    expect(dispatched).toBe(false);
  });

  it.each(["cancelled", "settled"] as const)("never reopens a %s artifact ID, including as repository work", async (status) => {
    const f = fixture();
    const envelope = buildLocalRunEnvelope({ input, harnessName: "opencode", workdir: `/workspace/${input.sandboxId}`,
      configFiles: [], setupCommands: [], argv: ["opencode"], env: {}, dummyKey: "placeholder", execAllowlist: [], setupAllowlist: [], deadlineAt: Date.now() + 60_000 });
    f.rows.set(`run:${input.sandboxId}`, { envelope, status, settledAt: Date.now() });
    for (const candidate of [envelope, { ...envelope, executionTarget: undefined, repoUrl: "https://github.com/fixture/repo" }]) {
      expect((await f.post("/dispatch", { envelope: candidate, targetMachineId: input.targetMachineId, dashboardOwnerId: input.initiatorUserId })).status).toBe(409);
    }
    f.rows.set(`run:${input.sandboxId}`, { envelope, status, settledAt: Date.now() - 8 * 24 * 60 * 60_000 });
    expect((await f.post("/dispatch", { envelope })).status).toBe(409);
    expect(f.rows.has(`run:${input.sandboxId}`)).toBe(false);
  });

  it.each(["pending", "claimed"] as const)("revocation invalidates %s artifacts but preserves legacy repository records", async (status) => {
    const f = fixture();
    const envelope = buildLocalRunEnvelope({ input, harnessName: "opencode", workdir: `/workspace/${input.sandboxId}`,
      configFiles: [], setupCommands: [], argv: ["opencode"], env: {}, dummyKey: "placeholder", execAllowlist: [], setupAllowlist: [], deadlineAt: Date.now() + 60_000 });
    f.rows.set("computer:paired-fixture", { tokenHash: "fixture", harnesses: ["opencode"], lastHeartbeat: Date.now() });
    f.rows.set(`run:${input.sandboxId}`, { envelope, status, targetMachineId: input.targetMachineId, claimToken: "held" });
    f.rows.set("run:legacy", { envelope: { ...envelope, sandboxId: "legacy", executionTarget: undefined, repoUrl: "https://github.com/fixture/repo" }, status, targetMachineId: input.targetMachineId, claimToken: "legacy-held" });
    if (status === "claimed") {
      for (const machine of [undefined, "wrong-machine"]) {
        for (const route of ["/control", "/result", "/events", "/approval"]) {
          expect((await f.post(route, { sandboxId: input.sandboxId, claimToken: "held" }, machine)).status).toBe(403);
        }
      }
      expect((await f.post("/control", { sandboxId: input.sandboxId, claimToken: "held" }, input.targetMachineId)).status).toBe(200);
    }
    expect((await f.post("/revoke-computer", { machineId: input.targetMachineId })).status).toBe(200);
    expect(f.rows.get(`run:${input.sandboxId}`)).toMatchObject({ status: "cancelled", claimToken: undefined });
    expect(f.rows.get("run:legacy")).toMatchObject({ status, claimToken: "legacy-held" });
    expect((await f.post("/control", { sandboxId: input.sandboxId, claimToken: "held" }, input.targetMachineId)).status).toBe(403);
    expect((await f.post("/result", { sandboxId: input.sandboxId, claimToken: "held" }, input.targetMachineId)).status).toBe(403);
    expect(await (await f.post("/claim", {}, input.targetMachineId)).json()).toEqual({ envelope: null });
  });

  it.each(["dispatch", "status"] as const)("marks uncertain artifact %s transport as nonretryable unknown", async (stage) => {
    let submissions = 0;
    const client: LocalDispatchClient = {
      dispatch: async () => { submissions++; if (stage === "dispatch") throw new Error("receipt lost"); },
      status: async () => { throw new Error("mailbox unavailable after submission"); },
      cancel: async () => {},
    };
    const result = await new LocalRuntimeAdapter(resolveHarness("opencode"), { client }).runCodingTask({} as never, input as never, async () => {});
    expect(result).toMatchObject({ status: "error", errorCode: "outcome_unknown", files: [] });
    expect(result.summary).toContain("do not retry automatically");
    expect(submissions).toBe(1);
  });

  it("runs the actual daemon through adapter, pinned dispatch, claim/result and private artifact persistence without Git", async () => {
    const f = fixture();
    f.rows.set("computer:paired-fixture", { machineId: "paired-fixture", hostname: "fixture", platform: "linux-x64", daemonVersion: "fixture",
      harnesses: ["opencode"], lastHeartbeat: Date.now(), tokenHash: "fixture-paired-hash" });
    const root = await mkdtemp(path.join(os.tmpdir(), "shiba-artifact-pipeline-"));
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "git"), `#!/bin/sh\ntouch "${path.join(root, "git-used")}"\nexit 90\n`, { mode: 0o755 });
    await writeFile(path.join(bin, "opencode"), '#!/bin/sh\n[ "$1" = "--version" ] && exit 0\nmkdir -p out\nprintf "# Complete approved brief\\n" > out/brief.md\nprintf "not exported" > unrequested.txt\necho fixture-completed\n', { mode: 0o755 });
    let envelope: LocalRunEnvelope | undefined;
    let daemonDone: Promise<number | null> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let output = "";
    const server = createServer(async (req, res) => {
      try {
        if (req.headers.authorization !== "Bearer fixture-daemon-token") { res.writeHead(403).end(); return; }
        let body = "";
        for await (const chunk of req) body += String(chunk);
        const response = await f.post((req.url ?? "").replace("/api/local", ""), JSON.parse(body), "paired-fixture");
        res.writeHead(response.status, { "Content-Type": "application/json" });
        res.end(await response.text());
      } catch { res.writeHead(500).end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const client: LocalDispatchClient = {
      dispatch: async (value, targetMachineId, dashboardOwnerId) => {
        envelope = value;
        expect((await f.post("/dispatch", { envelope: value, targetMachineId, dashboardOwnerId })).status).toBe(200);
        expect(await (await f.post("/claim", {})).json()).toEqual({ envelope: null });
        expect(await (await f.post("/claim", {}, "wrong-machine")).json()).toEqual({ envelope: null });
        child = spawn(process.execPath, [path.resolve("../../scripts/shiba-local-daemon.mjs"), "--once"], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root, SHIBA_LOCAL_RUN_ROOT: path.join(root, "runs"),
            SHIBA_WORKER_URL: `http://127.0.0.1:${port}`, LOCAL_ADAPTER_TOKEN: "fixture-daemon-token" }, stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout?.on("data", chunk => { output += String(chunk); });
        child.stderr?.on("data", chunk => { output += String(chunk); });
        daemonDone = new Promise((resolve, reject) => { child!.on("close", resolve); child!.on("error", reject); });
      },
      status: async sandboxId => (await (await f.dispatch.fetch(new Request(`https://internal/status?sandboxId=${sandboxId}`))).json()) as Awaited<ReturnType<LocalDispatchClient["status"]>>,
      cancel: async sandboxId => { await f.post("/cancel", { sandboxId }); },
    };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 25_000);
    try {
      const result = await new LocalRuntimeAdapter(resolveHarness("opencode"), { client, pollIntervalMs: 10 })
        .runCodingTask({} as never, input as never, async () => {}, { signal: abort.signal });
      expect(await daemonDone, output).toBe(0);
      expect(result).toMatchObject({ status: "completed", diff: "", changedFiles: ["out/brief.md"],
        files: [{ path: "out/brief.md", content: "# Complete approved brief\n", encoding: "utf8" }] });
      expect(result.baseRevision).toBeUndefined();
      await expect(access(path.join(root, "git-used"))).rejects.toThrow();
      const bodies = new Map<string, string>();
      const artifacts = await verifyExpectedDeliverables(input.expectedDeliverables, result.files);
      const metadata = await persistRunDeliverables({ ATTACHMENTS: { put: async (key: string, body: string) => { bodies.set(key, body); return {}; } } } as never, input.sandboxId, artifacts);
      expect(metadata).toHaveLength(1);
      expect(metadata[0]).not.toHaveProperty("content");
      expect(bodies.get(deliverableStorageKey(input.sandboxId, metadata[0]!.sha256, 0))).toBe("# Complete approved brief\n");
      const replay = { envelope, targetMachineId: input.targetMachineId, dashboardOwnerId: input.initiatorUserId };
      expect((await f.post("/dispatch", replay)).status).toBe(409);
      expect((await f.post("/result", { sandboxId: input.sandboxId, claimToken: "wrong", result: result as unknown as LocalRunResult }, input.targetMachineId)).status).toBe(409);
      // Audit pruning must not reopen an already-executed artifact ID.
      f.rows.delete(`run:${input.sandboxId}`);
      expect((await f.post("/dispatch", replay)).status).toBe(409);
    } finally {
      clearTimeout(timer);
      child?.kill("SIGKILL");
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 35_000);
});
