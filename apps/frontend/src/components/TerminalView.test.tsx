// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalView } from "./TerminalView";

const xterm = vi.hoisted(() => ({ instances: [] as Array<{ write: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  write = vi.fn(); reset = vi.fn(); dispose = vi.fn(); open = vi.fn(); resize = vi.fn();
  constructor() { xterm.instances.push(this); }
} }));

beforeEach(() => { xterm.instances = []; });
afterEach(cleanup);
async function mounted() {
  await act(async () => { await vi.dynamicImportSettled(); });
  const terminal = xterm.instances[0];
  if (!terminal) throw new Error("xterm did not mount");
  return terminal;
}

describe("TerminalView retained-window writes", () => {
  it("seeds async xterm initialization from the latest text, offset and source epoch", async () => {
    const view = render(<TerminalView text="old" totalChars={3} epoch={1} />);
    view.rerender(<TerminalView text="fresh" totalChars={5} epoch={2} />);
    const terminal = await mounted();
    expect(terminal.write.mock.calls).toEqual([["fresh"]]);
    view.rerender(<TerminalView text="fresh!" totalChars={6} epoch={2} />);
    expect(terminal.write.mock.calls).toEqual([["fresh"], ["!"]]);
    expect(terminal.reset).not.toHaveBeenCalled();
  });

  it("writes only appended bytes once the 250k retained window slides", async () => {
    const initial = "a".repeat(250_000);
    const view = render(<TerminalView text={initial} totalChars={250_000} epoch={0} />);
    const terminal = await mounted();
    const next = `${initial.slice(3)}END`;
    view.rerender(<TerminalView text={next} totalChars={250_003} epoch={0} />);
    expect(terminal.write.mock.calls).toEqual([[initial], ["END"]]);
    expect(terminal.reset).not.toHaveBeenCalled();
    view.rerender(<TerminalView text={next} totalChars={250_003} epoch={0} />);
    expect(terminal.write).toHaveBeenCalledTimes(2);
  });

  it("uses the append offset even when repeated characters leave the capped window unchanged", async () => {
    const text = "a".repeat(250_000);
    const view = render(<TerminalView text={text} totalChars={250_000} />);
    const terminal = await mounted();
    view.rerender(<TerminalView text={text} totalChars={250_001} />);
    expect(terminal.write.mock.calls).toEqual([[text], ["a"]]);
    expect(terminal.reset).not.toHaveBeenCalled();
  });

  it("resets genuine replacements and source epochs, including an empty replacement", async () => {
    const view = render(<TerminalView text="same" totalChars={4} epoch={1} />);
    const terminal = await mounted();
    view.rerender(<TerminalView text="next" totalChars={4} epoch={1} />);
    view.rerender(<TerminalView text="next" totalChars={4} epoch={2} />);
    view.rerender(<TerminalView text="" totalChars={0} epoch={3} />);
    expect(terminal.reset).toHaveBeenCalledTimes(3);
    expect(terminal.write.mock.calls).toEqual([["same"], ["next"], ["next"]]);
  });

  it.each([Number.NaN, Infinity, -1, 2, Number.MAX_SAFE_INTEGER + 1])("resets invalid append metadata (%s)", async (totalChars) => {
    const view = render(<TerminalView text="safe" totalChars={4} />);
    const terminal = await mounted();
    view.rerender(<TerminalView text="next" totalChars={totalChars} />);
    expect(terminal.reset).toHaveBeenCalledOnce();
    expect(terminal.write.mock.calls).toEqual([["safe"], ["next"]]);
  });

  it.each([{ text: "tail", total: 20 }, { text: "WRONG!", total: 8 }, { text: "short", total: 5 }])("resets a missing retained delta, conflicting overlap or rewound counter: %s", async ({ text, total }) => {
    const view = render(<TerminalView text="abcdef" totalChars={6} />);
    const terminal = await mounted();
    view.rerender(<TerminalView text={text} totalChars={total} />);
    expect(terminal.reset).toHaveBeenCalledOnce();
    expect(terminal.write.mock.calls).toEqual([["abcdef"], [text]]);
  });

  it("preserves append/replacement behavior for text-only callers without empty writes", async () => {
    const view = render(<TerminalView text="first" />);
    const terminal = await mounted();
    view.rerender(<TerminalView text="first next" />);
    view.rerender(<TerminalView text="replacement" />);
    view.rerender(<TerminalView text="" />);
    expect(terminal.write.mock.calls).toEqual([["first"], [" next"], ["replacement"]]);
    expect(terminal.reset).toHaveBeenCalledTimes(2);
  });
});
