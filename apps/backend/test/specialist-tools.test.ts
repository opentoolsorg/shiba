import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { createSpecialistTools } from "../src/agents/specialists/tools.js";
import type { ChildTaskEvent, SpecialistDispatch } from "../src/agents/specialists/contract.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));

const input = { goal: "Inspect", context: "only this", files: [{ path: "a.ts", content: "export const a = 1;" }] };
const observation = { agent: "explorer", status: "completed", summary: "Found a.", report: "a.ts declares a.", findings: [] };
const env = { INTERNAL_SIGNING_KEY: "test-key" } as Env;
const options = { toolCallId: "call-1", messages: [], context: undefined };

beforeEach(() => {
  mocks.execute.mockReset();
  mocks.execute.mockResolvedValue(observation);
});
afterEach(() => vi.useRealTimers());

describe("specialist orchestration", () => {
  it("passes only a signed explicit snapshot and returns lifecycle observations", async () => {
    const events: ChildTaskEvent[] = [];
    const tools = createSpecialistTools(env, "owner", { remaining: 3, active: 0 }, { onEvent: (event) => { events.push(event); }, cancel: vi.fn() });
    expect(tools.explore_codebase?.needsApproval).toBeUndefined();
    await expect(tools.explore_codebase?.execute?.(input, options)).resolves.toEqual(observation);
    const dispatch = mocks.execute.mock.calls[0]?.[0] as SpecialistDispatch;
    expect(dispatch.input).toEqual(input);
    expect(dispatch.parentName).toBe("owner");
    expect(dispatch.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(dispatch).not.toHaveProperty("messages");
    expect(dispatch).not.toHaveProperty("env");
    expect(events.map((event) => event.kind)).toEqual(["ChildTaskSpawned", "ChildTaskProgress", "ChildTaskCompleted"]);
  });

  it("limits total children and atomically refuses concurrent fan-out", async () => {
    let resolve: (value: unknown) => void = () => {};
    mocks.execute.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const budget = { remaining: 3, active: 0 };
    const tools = createSpecialistTools(env, "owner", budget, { onEvent: vi.fn(), cancel: vi.fn() });
    const first = tools.explore_codebase?.execute?.(input, options);
    await expect(tools.explore_codebase?.execute?.(input, { ...options, toolCallId: "concurrent" })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("capacity") });
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
    resolve(observation);
    await first;
    await tools.explore_codebase?.execute?.(input, { ...options, toolCallId: "call-2" });
    await tools.explore_codebase?.execute?.(input, { ...options, toolCallId: "call-3" });
    await expect(tools.explore_codebase?.execute?.(input, { ...options, toolCallId: "call-4" })).resolves.toMatchObject({ ok: false });
    expect(mocks.execute).toHaveBeenCalledTimes(3);
    expect(budget).toEqual({ remaining: 0, active: 0 });
  });

  it("tears down a child that never produces output", async () => {
    vi.useFakeTimers();
    mocks.execute.mockImplementation(() => new Promise(() => {}));
    const cancel = vi.fn();
    const events: ChildTaskEvent[] = [];
    const budget = { remaining: 3, active: 0 };
    const tools = createSpecialistTools(env, "owner", budget, { onEvent: (event) => { events.push(event); }, cancel });
    const pending = tools.explore_codebase?.execute?.(input, options);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pending).resolves.toMatchObject({ ok: false, error: expect.stringContaining("deadline") });
    expect(cancel).toHaveBeenCalledWith("explorer", "agent-tool:call-1");
    expect(events.at(-1)?.kind).toBe("ChildTaskFailed");
    expect(budget.active).toBe(0);
  });
});
