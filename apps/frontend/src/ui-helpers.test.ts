import { describe, expect, it, vi } from "vitest";
import { formatToolOutput, runsListUrl } from "./ui-helpers";

describe("runsListUrl", () => {
  it("requests the lean summary projection for ordinary views", () => {
    expect(runsListUrl("sess-1", false, false)).toBe("/api/runs?view=summary");
    expect(runsListUrl("sess-1", true, false)).toBe(
      "/api/runs?session=sess-1&view=summary",
    );
  });

  it("requests the full payload only for detail views", () => {
    expect(runsListUrl("sess-1", false, true)).toBe("/api/runs");
    expect(runsListUrl("a b", true, true)).toBe("/api/runs?session=a+b");
  });
});

describe("formatToolOutput", () => {
  const partWith = (output: unknown) =>
    ({ type: "tool-x", output }) as never;

  it("returns null for missing output and raw strings verbatim", () => {
    expect(formatToolOutput(partWith(undefined))).toBeNull();
    expect(formatToolOutput(partWith(null))).toBeNull();
    expect(formatToolOutput(partWith("done"))).toBe("done");
  });

  it("memoizes serialization by output object identity", () => {
    const spy = vi.spyOn(JSON, "stringify");
    const output = { files: ["a.ts", "b.ts"], ok: true };
    const first = formatToolOutput(partWith(output));
    const second = formatToolOutput(partWith(output));
    expect(second).toBe(first);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("reserializes a different output object", () => {
    const spy = vi.spyOn(JSON, "stringify");
    formatToolOutput(partWith({ n: 1 }));
    formatToolOutput(partWith({ n: 2 }));
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
