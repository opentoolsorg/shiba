import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JournalExecutionInput, JournalPage } from "@shiba/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sandbox } from "../src/sandbox/durable-object.js";
import { EXECUTION_EPOCH_LABEL, EXECUTION_JOURNAL_SOURCE, executionInputDigest } from "../src/sandbox/execution-journal.js";
import type { Env } from "../src/env.js";

vi.mock("@cloudflare/sandbox", () => ({ Files: class {
  async mkdir() {}
  async writeFile() {}
} }));

const EPOCH = "11111111-1111-4111-8111-111111111111";
const ROOT_LITERAL = 'const ROOT = "/var/lib/shiba-executions";';
const fixtures: Array<{ root: string; native: { destroy(): Promise<void> } }> = [];
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function gate() {
  let release: (() => void) = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  return { pending, release };
}

async function host() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shiba-journal-do-"));
  const values = new Map<string, unknown>();
  const children: ChildProcess[] = [];
  const key = createHash("sha256").update(root).digest("hex");
  const input: JournalExecutionInput = {
    jobId: key, command: `${quote(process.execPath)} -e ${quote("process.stdout.write('first');setTimeout(()=>process.stderr.write('last'),100)")}`,
    cwd: root, deadline: Date.now() + 10_000,
  };
  const native = {
    running: true, images: { sandbox: "pinned-image" }, labels: { [EXECUTION_EPOCH_LABEL]: EPOCH },
    inspect: vi.fn(async (): Promise<{ labels: Record<string, string>; image: string }> => ({ labels: { ...native.labels }, image: "pinned-image" })),
    setInactivityTimeout: vi.fn(async () => undefined),
    start: vi.fn((_options?: ContainerStartupOptions) => undefined),
    interceptAllOutboundHttp: vi.fn(async () => undefined),
    interceptOutboundHttps: vi.fn(async () => undefined),
    destroy: vi.fn(async () => {
      native.running = false;
      for (const child of children) {
        if (child.pid && child.exitCode === null && child.signalCode === null) { try { child.kill("SIGKILL"); } catch {} }
      }
    }),
    getTcpPort: vi.fn(() => ({ fetch: vi.fn(async () => new Response(null)) })),
    exec: vi.fn(async (argv: string[], options?: { stdin?: ReadableStream; env?: Record<string, string>; stdout?: string; stderr?: string }) => {
      expect(argv[0]).toBe("node");
      expect(argv[2]).toBe(EXECUTION_JOURNAL_SOURCE);
      const source = EXECUTION_JOURNAL_SOURCE.replace(ROOT_LITERAL, `const ROOT = ${JSON.stringify(path.join(root, "journals"))};`);
      const child = spawn(process.execPath, ["-e", source, ...argv.slice(3)], {
        cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, ...options?.env },
        stdio: ["pipe", options?.stdout === "ignore" ? "ignore" : "pipe", options?.stderr === "ignore" ? "ignore" : "pipe"],
      });
      children.push(child);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout?.on("data", (bytes) => stdout.push(bytes));
      child.stderr?.on("data", (bytes) => stderr.push(bytes));
      const ended = new Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }>((resolve) => {
        child.on("close", (code) => resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code ?? -1 }));
      });
      if (!child.stdin) throw new Error("The native process fixture requires stdin.");
      child.stdin.on("error", () => undefined);
      child.stdin.end(options?.stdin ? Buffer.from(await new Response(options.stdin).arrayBuffer()) : undefined);
      return { output: () => ended };
    }),
  };
  const storage = {
    kv: {
      get<T>(name: string): T | undefined { const value = values.get(name); return value === undefined ? undefined : structuredClone(value) as T; },
      put(name: string, value: unknown) { values.set(name, structuredClone(value)); },
    },
    get: async <T>(name: string) => values.get(name) as T | undefined,
    setAlarm: vi.fn(async () => undefined),
    deleteAll: vi.fn(async () => { values.clear(); }),
  };
  const context = { id: { toString: () => key }, container: native, storage, blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(), exports: { SandboxOutbound: () => ({ fetch: async () => new Response(null) }) } };
  const construct = () => new Sandbox(context as unknown as ConstructorParameters<typeof Sandbox>[0], {} as Env);
  const result = { root, values, native, storage, input, construct, sandbox: construct() };
  fixtures.push(result);
  return result;
}

async function drain(sandbox: Sandbox, jobId: string) {
  const frames: JournalPage["frames"] = [];
  const deadline = Date.now() + 5_000;
  let cursor = 0;
  let page: JournalPage;
  do {
    page = await sandbox.readExecution(jobId, cursor);
    frames.push(...page.frames);
    cursor = page.cursor;
    if (page.done) return { page, frames };
    await pause(20);
  } while (Date.now() < deadline);
  throw new Error("Journal fixture did not settle.");
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    await fixture.native.destroy();
    for (const entry of await fs.readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try { if (await fs.readlink(`/proc/${entry}/cwd`) === fixture.root) process.kill(Number(entry), "SIGKILL"); } catch {}
    }
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

describe("Sandbox execution journal RPC", () => {
  it("reattaches after a lost launch reply and recreated DO without another CLI launch", async () => {
    const item = await host();
    const actual = item.native.exec.getMockImplementation();
    if (!actual) throw new Error("Missing native execution fixture.");
    item.native.exec.mockImplementationOnce(async (argv, options) => {
      await actual(argv, options);
      throw new Error("Accepted launch response was lost.");
    });
    await expect(item.sandbox.startExecution(item.input)).rejects.toThrow("response was lost");
    const restarted = item.construct();
    const output = await drain(restarted, item.input.jobId);
    expect(output.page).toMatchObject({ state: "exited", exitCode: 0 });
    expect(Buffer.concat(output.frames.filter((frame) => frame.stream === "stdout").map((frame) => Buffer.from(frame.dataBase64, "base64"))).toString()).toBe("first");
    expect(Buffer.concat(output.frames.filter((frame) => frame.stream === "stderr").map((frame) => Buffer.from(frame.dataBase64, "base64"))).toString()).toBe("last");
    expect(item.native.exec.mock.calls.filter(([argv]) => argv[4] === "start")).toHaveLength(1);
    expect(item.native.start).not.toHaveBeenCalled();
  });

  it("persists only immutable digest metadata and supplies approved environment on stdin", async () => {
    const item = await host();
    const secret = "fixture-application-value";
    const input = { ...item.input, command: `${quote(process.execPath)} -e ${quote("process.stdout.write(process.env.APP_VALUE)")}`, env: { APP_VALUE: secret } };
    await Promise.all([item.sandbox.startExecution(input), item.sandbox.startExecution(input)]);
    const output = await drain(item.sandbox, input.jobId);
    expect(Buffer.concat(output.frames.map((frame) => Buffer.from(frame.dataBase64, "base64"))).toString()).toBe(secret);
    expect(JSON.stringify([...item.values])).not.toContain(secret);
    expect(JSON.stringify([...item.values])).not.toContain(input.command);
    const calls = item.native.exec.mock.calls.filter(([argv]) => argv[4] === "start");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]?.env).not.toHaveProperty("APP_VALUE");
  });

  it("accepts bounded input whose command expands under JSON escaping", async () => {
    const item = await host();
    const input = { ...item.input, command: "\u0001".repeat(65_536), env: { APP_VALUE: "\u0002".repeat(10_000) } };
    await item.sandbox.startExecution(input);
    const output = await drain(item.sandbox, input.jobId);
    expect(output.page.state).toBe("exited");
    expect(output.page.exitCode).not.toBe(0);
  });

  it.each(["command", "cwd", "env", "deadline"])("refuses a changed frozen %s on the same identity", async (field) => {
    const item = await host();
    await item.sandbox.startExecution(item.input);
    const changes = { command: "echo changed", cwd: "/different", env: { CHANGED: "yes" }, deadline: item.input.deadline + 1 };
    await expect(item.sandbox.startExecution({ ...item.input, [field]: changes[field as keyof typeof changes] })).rejects.toThrow("different inputs");
    expect(item.native.exec.mock.calls.filter(([argv]) => argv[4] === "start")).toHaveLength(1);
  });

  it("keeps a cancellation before START as a sticky tombstone", async () => {
    const item = await host();
    await item.sandbox.cancelExecution(item.input.jobId);
    expect(await item.sandbox.startExecution(item.input)).toMatchObject({ state: "cancelled" });
    expect(item.native.exec.mock.calls.filter(([argv]) => argv[4] === "start")).toHaveLength(0);
  });

  it("cancels an in-flight START before the detached helper can launch the CLI", async () => {
    const item = await host();
    const blocked = gate();
    const entered = gate();
    const actual = item.native.exec.getMockImplementation();
    if (!actual) throw new Error("Missing native execution fixture.");
    item.native.exec.mockImplementationOnce(async (argv, options) => {
      entered.release();
      await blocked.pending;
      return actual(argv, options);
    });
    const starting = item.sandbox.startExecution(item.input);
    await entered.pending;
    expect(await item.sandbox.cancelExecution(item.input.jobId)).toMatchObject({ state: "cancelled" });
    blocked.release();
    expect(await starting).toMatchObject({ state: "cancelled" });
    await pause(100);
    expect(await fs.stat(path.join(item.root, "journals", item.input.jobId)).then(() => true, () => false)).toBe(false);
  });

  it("does not resurrect a claim deleted while START awaits instance inspection", async () => {
    const item = await host();
    const blocked = gate();
    const entered = gate();
    item.native.inspect.mockImplementationOnce(async () => { entered.release(); await blocked.pending; return { labels: { [EXECUTION_EPOCH_LABEL]: EPOCH }, image: "pinned-image" }; });
    const starting = item.sandbox.startExecution(item.input);
    await entered.pending;
    await item.sandbox.destroy();
    blocked.release();
    expect(await starting).toMatchObject({ state: "lost" });
    expect(item.values.size).toBe(0);
    expect(item.native.exec).not.toHaveBeenCalled();
  });

  it("does not resurrect a claim deleted while a read awaits its response", async () => {
    const item = await host();
    await item.sandbox.startExecution(item.input);
    expect((await drain(item.sandbox, item.input.jobId)).page.state).toBe("exited");
    const blocked = gate();
    const entered = gate();
    const actual = item.native.exec.getMockImplementation();
    if (!actual) throw new Error("Missing native execution fixture.");
    item.native.exec.mockImplementationOnce(async (argv, options) => {
      const process = await actual(argv, options);
      return { output: async () => { const output = await process.output(); entered.release(); await blocked.pending; return output; } };
    });
    const reading = item.sandbox.readExecution(item.input.jobId, 0);
    await entered.pending;
    await item.sandbox.destroy();
    blocked.release();
    expect(await reading).toMatchObject({ state: "lost" });
    expect(item.values.size).toBe(0);
  });

  it.each(["missing-exit", "sequence", "failed-control"])("refuses an unsafe %s control response", async (kind) => {
    const item = await host();
    await item.sandbox.startExecution(item.input);
    const reply = { jobId: item.input.jobId, state: "exited", frames: [] as JournalPage["frames"], cursor: 0, done: true,
      ...(kind === "missing-exit" ? {} : { exitCode: 0 }),
    };
    if (kind === "sequence") { reply.frames = [{ sequence: 2, stream: "stdout", dataBase64: "eA==" }]; reply.cursor = 1; }
    item.native.exec.mockResolvedValueOnce({ output: async () => ({ stdout: Buffer.from(JSON.stringify(reply)), stderr: Buffer.alloc(0), exitCode: kind === "failed-control" ? 7 : 0 }) });
    expect(await item.sandbox.readExecution(item.input.jobId, 0)).toMatchObject({ state: "lost", done: true });
  });

  it.each(["stopped", "replaced"])("fails closed on a %s instance without starting a container", async (kind) => {
    const item = await host();
    await item.sandbox.startExecution(item.input);
    if (kind === "stopped") item.native.running = false;
    else item.native.labels[EXECUTION_EPOCH_LABEL] = "22222222-2222-4222-8222-222222222222";
    const before = item.native.exec.mock.calls.length;
    expect(await item.sandbox.readExecution(item.input.jobId, 0)).toMatchObject({ state: "lost", done: true });
    expect(item.native.exec).toHaveBeenCalledTimes(before);
    expect(item.native.start).not.toHaveBeenCalled();
  });

  it("leaves readonly transport errors retryable without relaunching the job", async () => {
    const item = await host();
    await item.sandbox.startExecution(item.input);
    item.native.exec.mockRejectedValueOnce(new Error("read transport disconnected"));
    await expect(item.sandbox.readExecution(item.input.jobId, 0)).rejects.toThrow("transport is unavailable");
    expect((await drain(item.sandbox, item.input.jobId)).page.state).toBe("exited");
    expect(item.native.exec.mock.calls.filter(([argv]) => argv[4] === "start")).toHaveLength(1);
  });

  it("destroys an overdue matching instance even with no source reader", async () => {
    const item = await host();
    await item.sandbox.startExecution({ ...item.input, command: "sleep 100" });
    vi.spyOn(Date, "now").mockReturnValue(item.input.deadline + 1_501);
    await item.sandbox.alarm();
    expect(item.native.destroy).toHaveBeenCalledOnce();
    expect(item.values.get(`execution-journal:${item.input.jobId}`)).toMatchObject({ state: "timed_out" });
  });

  it("keeps an exited CLI instance for approved postprocessing after its execution deadline", async () => {
    const item = await host();
    await item.sandbox.startExecution(item.input);
    expect((await drain(item.sandbox, item.input.jobId)).page.state).toBe("exited");
    item.values.set("execution-journal-deadlines:v1", { [item.input.jobId]: { deadline: item.input.deadline, epoch: EPOCH } });
    vi.spyOn(Date, "now").mockReturnValue(item.input.deadline + 1_501);
    await item.sandbox.alarm();
    expect(item.native.destroy).not.toHaveBeenCalled();
  });

  it("reconciles an unread final receipt before the deadline alarm destroys the container", async () => {
    const item = await host();
    await item.sandbox.startExecution(item.input);
    // Observe process completion outside the DO so its durable claim remains starting.
    const receipt = path.join(item.root, "journals", item.input.jobId, "receipt.json");
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      try { await fs.stat(receipt); break; } catch { await pause(20); }
    }
    await expect(fs.stat(receipt)).resolves.toBeDefined();
    expect(item.values.get(`execution-journal:${item.input.jobId}`)).toMatchObject({ state: "starting" });
    vi.spyOn(Date, "now").mockReturnValue(item.input.deadline + 1_501);
    await item.sandbox.alarm();
    expect(item.native.destroy).not.toHaveBeenCalled();
    expect(item.values.get(`execution-journal:${item.input.jobId}`)).toMatchObject({ state: "exited" });
  });

  it("does not kill a replacement instance for an old execution deadline", async () => {
    const item = await host();
    await item.sandbox.startExecution(item.input);
    item.native.labels[EXECUTION_EPOCH_LABEL] = "22222222-2222-4222-8222-222222222222";
    vi.spyOn(Date, "now").mockReturnValue(item.input.deadline + 1_501);
    await item.sandbox.alarm();
    expect(item.native.destroy).not.toHaveBeenCalled();
  });

  it("does not kill a replacement that appears during deadline receipt reconciliation", async () => {
    const item = await host();
    await item.sandbox.startExecution(item.input);
    item.native.inspect.mockResolvedValueOnce({ labels: { [EXECUTION_EPOCH_LABEL]: EPOCH }, image: "pinned-image" });
    item.native.labels[EXECUTION_EPOCH_LABEL] = "22222222-2222-4222-8222-222222222222";
    vi.spyOn(Date, "now").mockReturnValue(item.input.deadline + 1_501);
    await item.sandbox.alarm();
    expect(item.native.destroy).not.toHaveBeenCalled();
  });

  it("preserves a new deadline installed while the alarm reconciles an older completed job", async () => {
    const item = await host(); await item.sandbox.startExecution(item.input);
    expect((await drain(item.sandbox, item.input.jobId)).page.state).toBe("exited");
    item.values.set("execution-journal-deadlines:v1", { [item.input.jobId]: { deadline: item.input.deadline, epoch: EPOCH } });
    const newId = "e".repeat(64); const newer = { deadline: item.input.deadline + 60_000, epoch: EPOCH };
    item.native.inspect.mockImplementationOnce(async () => {
      item.values.set("execution-journal-deadlines:v1", { [item.input.jobId]: { deadline: item.input.deadline, epoch: EPOCH }, [newId]: newer });
      return { labels: { [EXECUTION_EPOCH_LABEL]: EPOCH }, image: "pinned-image" };
    });
    vi.spyOn(Date, "now").mockReturnValue(item.input.deadline + 1_501);
    await item.sandbox.alarm();
    expect(item.values.get("execution-journal-deadlines:v1")).toEqual({ [newId]: newer });
  });

  it("bounds a stalled deadline receipt read and rearms the native cleanup backstop", async () => {
    const item = await host(); await item.sandbox.startExecution({ ...item.input, command: "sleep 100" });
    item.native.exec.mockImplementationOnce(() => new Promise<never>(() => {}));
    vi.useFakeTimers(); vi.setSystemTime(item.input.deadline + 1_501);
    const now = Date.now(); const alarm = item.sandbox.alarm();
    await vi.advanceTimersByTimeAsync(2_000); await alarm;
    expect(item.storage.setAlarm).toHaveBeenLastCalledWith(now + 2_000 + 5_000);
    vi.useRealTimers();
  });

  it.each(["missing", "stopped", "replaced"] as const)("never starts a container for %s post-attach settlement", async (loss) => {
    const item = await host();
    await item.sandbox.startExecution(item.input);
    expect((await drain(item.sandbox, item.input.jobId)).page.state).toBe("exited");
    if (loss === "missing") item.values.delete(`execution-journal:${item.input.jobId}`);
    if (loss === "stopped") item.native.running = false;
    if (loss === "replaced") item.native.labels[EXECUTION_EPOCH_LABEL] = "22222222-2222-4222-8222-222222222222";
    const calls = item.native.exec.mock.calls.length;
    await expect(item.sandbox.exec("git write-tree", { requiredJournalJobId: item.input.jobId })).rejects.toThrow("Settlement was not restarted");
    expect(item.native.start).not.toHaveBeenCalled();
    expect(item.native.exec).toHaveBeenCalledTimes(calls);
  });

  it("executes settlement only inside the original completed journal's kernel", async () => {
    const item = await host(); await item.sandbox.startExecution(item.input);
    expect((await drain(item.sandbox, item.input.jobId)).page.state).toBe("exited");
    const target = path.join(item.root, "settled.txt");
    expect((await item.sandbox.exec(`printf original > ${quote(target)}`, {
      cwd: item.root, requiredJournalJobId: item.input.jobId,
    })).exitCode).toBe(0);
    expect(await fs.readFile(target, "utf8")).toBe("original");
    expect(item.native.start).not.toHaveBeenCalled();
  });

  it.each(["bootId", "pidNamespace", "initStart"] as const)("refuses replaced %s even when inspection returned a stale matching epoch", async (field) => {
    const item = await host(); await item.sandbox.startExecution(item.input);
    expect((await drain(item.sandbox, item.input.jobId)).page.state).toBe("exited");
    const target = path.join(item.root, "must-not-run.txt");
    item.native.inspect.mockImplementationOnce(async () => {
      for (const file of ["meta.json", "receipt.json"]) {
        const name = path.join(item.root, "journals", item.input.jobId, file);
        const value = JSON.parse(await fs.readFile(name, "utf8"));
        await fs.writeFile(name, JSON.stringify({ ...value, [field]: "replaced-instance" }));
      }
      return { labels: { [EXECUTION_EPOCH_LABEL]: EPOCH }, image: "pinned-image" };
    });
    const result = await item.sandbox.exec(`touch ${quote(target)}`, { cwd: item.root, requiredJournalJobId: item.input.jobId });
    expect(result.exitCode).toBe(125);
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(item.native.start).not.toHaveBeenCalled();
  });

  it.each(["destroy", "inspect"] as const)("backs off overdue cleanup when native %s fails", async (operation) => {
    const item = await host();
    await item.sandbox.startExecution({ ...item.input, command: "sleep 100" });
    const now = item.input.deadline + 1_501;
    vi.spyOn(Date, "now").mockReturnValue(now);
    item.native[operation].mockRejectedValueOnce(new Error("native control unavailable"));
    const touches = item.native.setInactivityTimeout.mock.calls.length;
    await item.sandbox.alarm();
    expect(item.storage.setAlarm).toHaveBeenLastCalledWith(now + 5_000);
    expect(item.native.setInactivityTimeout).toHaveBeenCalledTimes(touches);
  });

  it("refuses missing claims and invalid cursors before container control", async () => {
    const item = await host();
    expect(await item.sandbox.readExecution(item.input.jobId, 0)).toMatchObject({ state: "lost" });
    for (const cursor of [-1, 0.5, 4097]) await expect(item.sandbox.readExecution(item.input.jobId, cursor)).rejects.toThrow("cursor");
    expect(item.native.exec).not.toHaveBeenCalled();
  });

  it.each([false, true])("assigns a fresh epoch when a new instance starts, including snapshot restore: %s", async (snapshot) => {
    const item = await host();
    item.native.running = false;
    if (snapshot) item.values.set("container-snapshot-id", "old-snapshot");
    await item.sandbox.writeFile("/workspace/context", "fixture");
    expect(item.native.start).toHaveBeenCalledOnce();
    const options = item.native.start.mock.calls[0]?.[0] as ContainerStartupOptions | undefined;
    expect(options?.labels?.[EXECUTION_EPOCH_LABEL]).toMatch(/^[a-f0-9-]{36}$/);
    expect(options?.labels?.[EXECUTION_EPOCH_LABEL]).not.toBe(EPOCH);
    expect(options?.enableInternet).toBe(false);
    if (snapshot) expect(options).toHaveProperty("containerSnapshot.id", "old-snapshot");
  });
});

describe("execution journal request bounds", () => {
  it("hashes canonical environment order and rejects oversized or malformed inputs", async () => {
    const input = { jobId: "a".repeat(64), command: "echo ok", cwd: "/workspace", deadline: Date.now() + 1000 };
    expect(await executionInputDigest({ ...input, env: { B: "2", A: "1" } })).toBe(await executionInputDigest({ ...input, env: { A: "1", B: "2" } }));
    for (const changed of [{ command: "x".repeat(65_537) }, { cwd: "relative" }, { env: { "BAD NAME": "x" } }, { deadline: Date.now() + 16 * 60_000 }, { jobId: "../escape" }]) {
      await expect(executionInputDigest({ ...input, ...changed })).rejects.toThrow();
    }
  });
});
