import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudflareSandboxProvider, type CloudflareSandboxRpc } from "../src/adapters/cloudflare.js";
import type { JournalExecutionInput, JournalFrame, JournalPage, JournalState } from "../src/types.js";

const JOB_ID = "a".repeat(64);

interface JournalRpc {
  startExecution(input: JournalExecutionInput): Promise<{ jobId: string; state: JournalState }>;
  readExecution(jobId: string, after: number): Promise<JournalPage>;
  cancelExecution(jobId: string): Promise<{ jobId: string; state: JournalState }>;
}

function frame(sequence: number, text: string | number[], stream: "stdout" | "stderr" = "stdout"): JournalFrame {
  return {
    sequence,
    stream,
    dataBase64: Buffer.from(typeof text === "string" ? text : new Uint8Array(text)).toString("base64"),
  };
}

function page(overrides: Partial<JournalPage> = {}): JournalPage {
  return { jobId: JOB_ID, state: "exited", frames: [], cursor: 0, done: true, exitCode: 0, ...overrides };
}

function fixture(overrides: Partial<JournalRpc> = {}) {
  const start = vi.fn<JournalRpc["startExecution"]>(async () => ({ jobId: JOB_ID, state: "running" }));
  const read = vi.fn<JournalRpc["readExecution"]>(async () => page());
  const cancel = vi.fn<JournalRpc["cancelExecution"]>(async () => ({ jobId: JOB_ID, state: "cancelled" }));
  const legacyExec = vi.fn(async () => ({ stdout: "legacy", stderr: "", exitCode: 0 }));
  const rpc: CloudflareSandboxRpc & Partial<JournalRpc> = {
    approveHarnessEgress: async () => {},
    approveEgressOverrides: async () => {},
    approveRepoScope: async () => {},
    gitCheckout: async () => {},
    writeFile: async () => {},
    exec: legacyExec,
    readFileStream: async () => new ReadableStream(),
    destroy: async () => {},
    exposePort: async () => ({ url: "https://preview.example/" }),
    unexposePort: async () => {},
    startProcess: async () => ({ waitForPort: async () => {}, kill: async () => {} }),
    startExecution: start,
    readExecution: read,
    cancelExecution: cancel,
    ...overrides,
  };
  const provider = createCloudflareSandboxProvider({
    resolveRpc: () => rpc,
    execEnvPassthrough: { SHIBA_TRANSPORT: "proxy" },
  });
  return { provider, start, read, cancel, legacyExec };
}

function journal(deadline = Date.now() + 60_000) {
  return { jobId: JOB_ID, deadline };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Cloudflare source journal adapter", () => {
  it("preserves the ordinary default workspace when no cwd is supplied", async () => {
    const f = fixture();
    const sandbox = await f.provider.get("approved-run");
    const frozenJournal = journal();
    await sandbox.exec("run-approved-cli", { journal: frozenJournal });
    expect(f.start).toHaveBeenCalledExactlyOnceWith({ jobId: JOB_ID, command: "run-approved-cli", cwd: "/workspace",
      deadline: frozenJournal.deadline, env: { SHIBA_TRANSPORT: "proxy" } });
  });

  it("launches the frozen command once and returns a known CLI failure as an exec result", async () => {
    const f = fixture();
    f.read.mockResolvedValue(page({
      frames: [frame(1, "compiled\n"), frame(2, "test failed\n", "stderr")],
      cursor: 2,
      exitCode: 17,
    }));
    const sandbox = await f.provider.get("approved-run");
    const onOutput = vi.fn();
    const frozenJournal = journal();
    const result = await sandbox.exec("run-approved-cli", {
      cwd: "/workspace/approved-run", env: { PLACEHOLDER: "dummy" }, journal: frozenJournal, onOutput,
    });
    expect(f.start).toHaveBeenCalledExactlyOnceWith({
      jobId: JOB_ID,
      command: "run-approved-cli",
      cwd: "/workspace/approved-run",
      env: { SHIBA_TRANSPORT: "proxy", PLACEHOLDER: "dummy" },
      deadline: frozenJournal.deadline,
    });
    expect(result).toEqual({ stdout: "compiled\n", stderr: "test failed\n", exitCode: 17 });
    expect(onOutput.mock.calls).toEqual([["stdout", "compiled\n"], ["stderr", "test failed\n"]]);
    expect(f.legacyExec).not.toHaveBeenCalled();
  });

  it("reattaches after a lost START response and a failed READ without relaunching or breaking split UTF-8", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.start.mockRejectedValueOnce(new Error("START response lost after launch"));
    f.read
      .mockResolvedValueOnce(page({
        state: "running", done: false, exitCode: undefined,
        frames: [frame(1, [0xf0, 0x9f]), frame(2, [0xe2], "stderr")], cursor: 2,
      }))
      .mockRejectedValueOnce(new Error("READ disconnected"))
      .mockResolvedValueOnce(page({
        frames: [frame(3, [0x98, 0x80]), frame(4, [0x82, 0xac], "stderr")], cursor: 4,
      }));
    const sandbox = await f.provider.get("approved-run");
    const output = vi.fn();
    const result = sandbox.exec("run-approved-cli", { cwd: "/workspace/approved-run", journal: journal(), onOutput: output });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ stdout: "😀", stderr: "€", exitCode: 0 });
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.read.mock.calls).toEqual([[JOB_ID, 0], [JOB_ID, 2], [JOB_ID, 2]]);
    expect(output.mock.calls.filter(([, chunk]) => chunk !== "")).toEqual([["stdout", "😀"], ["stderr", "€"]]);
    expect(f.legacyExec).not.toHaveBeenCalled();
  });

  it.each(["startExecution", "readExecution", "cancelExecution"] as const)(
    "refuses missing %s support before any command launches",
    async (method) => {
      const f = fixture({ [method]: undefined });
      const sandbox = await f.provider.get("approved-run");
      await expect(sandbox.exec("run-approved-cli", { cwd: "/workspace/approved-run", journal: journal() })).rejects.toMatchObject({
        code: "capability_unsupported",
      });
      expect(f.start).not.toHaveBeenCalled();
      expect(f.read).not.toHaveBeenCalled();
      expect(f.cancel).not.toHaveBeenCalled();
      expect(f.legacyExec).not.toHaveBeenCalled();
    },
  );

  it.each(["lost", "cancelled", "limited", "timed_out"] as const)(
    "does not report success for terminal %s even if an exit code says zero",
    async (state) => {
      const f = fixture();
      f.read.mockResolvedValue(page({ state, exitCode: 0 }));
      const sandbox = await f.provider.get("approved-run");
      await expect(sandbox.exec("run-approved-cli", { cwd: "/workspace/approved-run", journal: journal() })).rejects.toBeInstanceOf(Error);
      expect(f.start).toHaveBeenCalledTimes(1);
      expect(f.legacyExec).not.toHaveBeenCalled();
    },
  );

  const malformedPages: Array<[string, Partial<JournalPage>]> = [
    ["another job's output", { jobId: "b".repeat(64) }],
    ["a missing first frame", { frames: [frame(2, "lost")], cursor: 2 }],
    ["a sequence gap", { frames: [frame(1, "safe"), frame(3, "gap")], cursor: 3 }],
    ["duplicate frames", { frames: [frame(1, "first"), frame(1, "duplicate")], cursor: 1 }],
    ["a cursor beyond the supplied frames", { frames: [frame(1, "safe")], cursor: 2 }],
    ["a negative cursor", { cursor: -1 }],
    ["a fractional frame sequence", { frames: [{ ...frame(1, "x"), sequence: 1.5 }], cursor: 1 }],
    ["an invalid base64 payload", { frames: [{ sequence: 1, stream: "stdout", dataBase64: "%%%" }], cursor: 1 }],
    ["noncanonical base64", { frames: [{ sequence: 1, stream: "stdout", dataBase64: "Zh==" }], cursor: 1 }],
    ["an oversized frame", { frames: [frame(1, Array<number>(4097).fill(65))], cursor: 1 }],
    ["an oversized page", { frames: Array.from({ length: 65 }, (_, i) => frame(i + 1, "x")), cursor: 65 }],
    ["an unknown state", { state: "unexpected" as JournalState }],
    ["an unknown output stream", { frames: [{ ...frame(1, "x"), stream: "control" as "stdout" }], cursor: 1 }],
    ["an exited process without an exit code", { exitCode: undefined }],
    ["a fractional exit code", { exitCode: 0.5 }],
  ];

  it.each(malformedPages)("fails closed on %s", async (_name, malformed) => {
    const f = fixture();
    f.read.mockResolvedValue(page(malformed));
    const sandbox = await f.provider.get("approved-run");
    const output = vi.fn();
    await expect(sandbox.exec("run-approved-cli", { cwd: "/workspace/approved-run", journal: journal(), onOutput: output })).rejects.toBeInstanceOf(Error);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(output).not.toHaveBeenCalled();
    expect(f.legacyExec).not.toHaveBeenCalled();
  });

  it.each([
    ["raw output", 1025, 4096],
    ["frame count", 4097, 1],
  ] as const)("enforces the cumulative %s bound across otherwise valid pages", async (_name, totalFrames, bytesPerFrame) => {
    const f = fixture();
    f.read.mockImplementation(async (_id, after) => {
      const last = Math.min(after + 64, totalFrames);
      return page({
        frames: Array.from({ length: last - after }, (_, i) => frame(after + i + 1, Array<number>(bytesPerFrame).fill(65))),
        cursor: last, done: last === totalFrames,
        state: last === totalFrames ? "exited" : "running",
        exitCode: last === totalFrames ? 0 : undefined,
      });
    });
    const sandbox = await f.provider.get("approved-run");
    await expect(sandbox.exec("run-approved-cli", { cwd: "/workspace/approved-run", journal: journal() })).rejects.toBeInstanceOf(Error);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.legacyExec).not.toHaveBeenCalled();
  });

  it.each(["throws", "rejects"] as const)("does not replay accepted output when a consumer callback %s", async (failureMode) => {
    const f = fixture();
    f.read.mockResolvedValue(page({ frames: [frame(1, "first"), frame(2, "second")], cursor: 2 }));
    const sandbox = await f.provider.get("approved-run");
    const callbackFailure = new Error("consumer could not persist output");
    const output = vi.fn(() => {
      if (failureMode === "rejects") return Promise.reject(callbackFailure);
      throw callbackFailure;
    });
    await expect(sandbox.exec("run-approved-cli", { cwd: "/workspace/approved-run", journal: journal(), onOutput: output })).rejects.toBeInstanceOf(Error);
    expect(output).toHaveBeenCalledExactlyOnceWith("stdout", "first");
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it("rejects a replayed source frame after earlier output was already accepted", async () => {
    const f = fixture();
    f.read
      .mockResolvedValueOnce(page({ frames: [frame(1, "accepted")], cursor: 1, state: "running", done: false, exitCode: undefined }))
      .mockResolvedValueOnce(page({ frames: [frame(1, "accepted")], cursor: 1 }));
    const sandbox = await f.provider.get("approved-run");
    const output = vi.fn();
    await expect(sandbox.exec("run-approved-cli", { cwd: "/workspace/approved-run", journal: journal(), onOutput: output })).rejects.toBeInstanceOf(Error);
    expect(output).toHaveBeenCalledExactlyOnceWith("stdout", "accepted");
    expect(f.read.mock.calls).toEqual([[JOB_ID, 0], [JOB_ID, 1]]);
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it("forwards the complete retained source while keeping only the ordinary exec output tail", async () => {
    const f = fixture();
    const chunk = "x".repeat(4_096);
    f.read.mockImplementation(async (_id, after) => {
      const cursor = Math.min(after + 64, 200);
      return page({
        frames: Array.from({ length: cursor - after }, (_, i) => frame(after + i + 1, chunk)),
        cursor, state: cursor === 200 ? "exited" : "running", done: cursor === 200,
        exitCode: cursor === 200 ? 0 : undefined,
      });
    });
    const sandbox = await f.provider.get("approved-run");
    const output = vi.fn();
    const result = await sandbox.exec("run-approved-cli", { cwd: "/workspace/approved-run", journal: journal(), onOutput: output });
    expect(result.stdout).toBe("x".repeat(512_000));
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(output.mock.calls).toHaveLength(200);
    expect(output.mock.calls.reduce((length, [, text]) => length + text.length, 0)).toBe(819_200);
  });

  it("has no RPC effects if cancellation happened before execution", async () => {
    const f = fixture();
    const sandbox = await f.provider.get("approved-run");
    const controller = new AbortController();
    controller.abort();
    await expect(sandbox.exec("run-approved-cli", { cwd: "/workspace/approved-run", journal: journal(), signal: controller.signal })).rejects.toBeInstanceOf(Error);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.legacyExec).not.toHaveBeenCalled();
  });

  it("requests sticky cancellation if abort happens while START's outcome is unknown", async () => {
    const f = fixture();
    f.start.mockImplementation(() => new Promise(() => {}));
    const sandbox = await f.provider.get("approved-run");
    const controller = new AbortController();
    const result = sandbox.exec("run-approved-cli", { cwd: "/workspace/approved-run", journal: journal(), signal: controller.signal });
    const rejection = expect(result).rejects.toBeInstanceOf(Error);
    await Promise.resolve();
    expect(f.start).toHaveBeenCalledTimes(1);
    controller.abort();
    await rejection;
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(JOB_ID);
    expect(f.legacyExec).not.toHaveBeenCalled();
  });

  it("cancels a supervised job when its output consumer stalls and the signal aborts", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.read.mockResolvedValue(page({ frames: [frame(1, "waiting on consumer")], cursor: 1 }));
    const sandbox = await f.provider.get("approved-run");
    const controller = new AbortController();
    const output = vi.fn(() => new Promise<void>(() => {}));
    const result = sandbox.exec("run-approved-cli", {
      cwd: "/workspace/approved-run", journal: journal(), signal: controller.signal, onOutput: output,
    });
    const rejection = expect(result).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(0);
    expect(output).toHaveBeenCalledTimes(1);
    controller.abort();
    await rejection;
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(JOB_ID);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it("keeps the original deadline while an output consumer is stalled", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.read.mockResolvedValue(page({ frames: [frame(1, "waiting on consumer")], cursor: 1 }));
    const sandbox = await f.provider.get("approved-run");
    const output = vi.fn(() => new Promise<void>(() => {}));
    const result = sandbox.exec("run-approved-cli", {
      cwd: "/workspace/approved-run", journal: journal(Date.now() + 2_000), onOutput: output,
    });
    const rejection = expect(result).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(2_100);
    await rejection;
    expect(output).toHaveBeenCalledTimes(1);
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(JOB_ID);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it("bounds an ambiguous START RPC and then attaches without sending START again", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.start.mockImplementation(() => new Promise(() => {}));
    f.read.mockResolvedValue(page({ frames: [frame(1, "already launched")], cursor: 1 }));
    const sandbox = await f.provider.get("approved-run");
    const result = sandbox.exec("run-approved-cli", { cwd: "/workspace/approved-run", journal: journal() });
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(result).resolves.toEqual({ stdout: "already launched", stderr: "", exitCode: 0 });
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.read).toHaveBeenCalledExactlyOnceWith(JOB_ID, 0);
  });

  it("does not extend the original deadline while READ is stalled", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.read.mockImplementation(() => new Promise(() => {}));
    const sandbox = await f.provider.get("approved-run");
    const result = sandbox.exec("run-approved-cli", { cwd: "/workspace/approved-run", journal: journal(Date.now() + 2_000) });
    const rejection = expect(result).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(2_100);
    await rejection;
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(JOB_ID);
  });

  it("attaches after a timed-out READ and ignores its eventual late response", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finishStalledRead!: (value: JournalPage) => void;
    f.read.mockImplementationOnce(() => new Promise((resolve) => { finishStalledRead = resolve; }))
      .mockResolvedValueOnce(page({ frames: [frame(1, "retained source")], cursor: 1 }));
    const sandbox = await f.provider.get("approved-run");
    const output = vi.fn();
    const result = sandbox.exec("run-approved-cli", { cwd: "/workspace/approved-run", journal: journal(), onOutput: output });
    const completion = expect(result).resolves.toEqual({ stdout: "retained source", stderr: "", exitCode: 0 });
    await vi.advanceTimersByTimeAsync(5_500);
    await completion;
    finishStalledRead(page({ frames: [frame(1, "late response")], cursor: 1 }));
    await Promise.resolve();
    expect(output).toHaveBeenCalledExactlyOnceWith("stdout", "retained source");
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.read.mock.calls).toEqual([[JOB_ID, 0], [JOB_ID, 0]]);
  });

  it("stops retrying after the consecutive READ failure budget", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.read.mockRejectedValue(new Error("persistent disconnected source"));
    const sandbox = await f.provider.get("approved-run");
    const result = sandbox.exec("run-approved-cli", { cwd: "/workspace/approved-run", journal: journal() });
    const rejection = expect(result).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(30_500);
    await rejection;
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(JOB_ID);
    expect(f.legacyExec).not.toHaveBeenCalled();
  });

  it("leaves nonjournal execution on the original single-attempt transport", async () => {
    const f = fixture();
    const sandbox = await f.provider.get("approved-run");
    await expect(sandbox.exec("echo legacy")).resolves.toEqual({ stdout: "legacy", stderr: "", exitCode: 0 });
    expect(f.legacyExec).toHaveBeenCalledTimes(1);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
  });
});
