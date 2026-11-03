import { describe, expect, it, vi } from "vitest";
import { Sandbox } from "../src/sandbox/durable-object.js";
import type { Env } from "../src/env.js";

vi.mock("@cloudflare/sandbox", () => ({ Files: class {} }));

describe("sandbox output decoding", () => {
  it("decodes concurrent UTF-8 streams independently and flushes trailing bytes", async () => {
    const stream = (chunks: number[][]) => new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
        controller.close();
      },
    });
    const container = {
      running: true,
      setInactivityTimeout: vi.fn(async () => undefined),
      exec: vi.fn(async () => ({
        stdout: stream([[0xe2], [0x82, 0xac], [0xe2]]),
        stderr: stream([[0xc3], [0xa9]]),
        output: async () => ({ exitCode: 0 }),
      })),
    };
    const ctx = {
      container,
      blockConcurrencyWhile: (run: () => Promise<unknown>) => run(),
      storage: { setAlarm: vi.fn(async () => undefined) },
    };
    const sandbox = new Sandbox(ctx as unknown as ConstructorParameters<typeof Sandbox>[0], {} as Env);
    const output = vi.fn();
    const result = await sandbox.exec("test", { onOutput: output });
    expect(result).toEqual({ stdout: "€�", stderr: "é", exitCode: 0 });
    expect(output).toHaveBeenCalledWith("stdout", "�");
  });

  it("drains asynchronous RPC output callbacks before settling the process", async () => {
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const callbackStarted = new Promise<void>((resolve) => { started = resolve; });
    const processOutput = vi.fn(async () => ({ exitCode: 0 }));
    const container = {
      running: true,
      setInactivityTimeout: vi.fn(async () => undefined),
      exec: vi.fn(async () => ({
        stdout: new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode("first"));
          controller.enqueue(new TextEncoder().encode("last"));
          controller.close();
        } }),
        output: processOutput,
      })),
    };
    const ctx = {
      container,
      blockConcurrencyWhile: (run: () => Promise<unknown>) => run(),
      storage: { setAlarm: vi.fn(async () => undefined) },
    };
    const sandbox = new Sandbox(ctx as unknown as ConstructorParameters<typeof Sandbox>[0], {} as Env);
    const seen: string[] = [];
    const running = sandbox.exec("test", { onOutput: async (_stream, data) => {
      started?.();
      await gate;
      seen.push(data);
    } });
    await callbackStarted;
    expect(processOutput).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    release?.();
    expect(await running).toEqual({ stdout: "firstlast", stderr: "", exitCode: 0 });
    expect(seen).toEqual(["first", "last"]);
    expect(processOutput).toHaveBeenCalledOnce();
  });
});
