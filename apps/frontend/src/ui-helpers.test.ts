import { describe, expect, it, vi } from "vitest";
import { extractCompletedDiff, formatToolOutput, runsListUrl } from "./ui-helpers";

describe("extractCompletedDiff", () => {
  const marker = "SHIBA_AI_COWORKER_CODING_RESULT_JSON";
  const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

  it("prefers the authoritative diff over a summary containing protocol metadata", () => {
    const summary = `Completed task.\n${patch}${marker}\n${JSON.stringify({ status: "succeeded", diff: "metadata, not a patch" })}`;
    expect(extractCompletedDiff({ status: "completed", diff: patch, summary })).toBe(patch);
  });

  it("removes the result envelope from a legacy summary while retaining the patch's final newline", () => {
    const summary = `Completed task.\n${patch}${marker}\n${JSON.stringify({ status: "succeeded", changedFiles: ["src/a.ts"] })}`;
    expect(extractCompletedDiff({ status: "completed", summary })).toBe(patch);
  });

  it("recognizes a CRLF marker line without changing the patch's line endings", () => {
    const windowsPatch = patch.replace(/\n/g, "\r\n");
    const summary = `Completed task.\r\n${windowsPatch}${marker}\r\n{"status":"succeeded"}`;
    expect(extractCompletedDiff({ status: "completed", summary })).toBe(windowsPatch);
  });

  it("preserves added, removed, context and inline marker text inside actual patch lines", () => {
    const markerPatch = `diff --git a/protocol.txt b/protocol.txt\n--- a/protocol.txt\n+++ b/protocol.txt\n@@ -1,2 +1,3 @@\n-${marker}\n+${marker}\n ${marker}\n+const result = "${marker}";\n`;
    const summary = `${markerPatch}${marker}\n{"status":"succeeded"}`;
    expect(extractCompletedDiff({ status: "completed", summary })).toBe(markerPatch);
  });

  it.each([`${marker}_EXTRA`, `${marker} trailing text`, ` ${marker}`])(
    "does not mistake a non-protocol line %s for the exact result boundary", (line) => {
      const summary = `${patch}${line}\n`;
      expect(extractCompletedDiff({ status: "completed", summary })).toBe(summary);
    },
  );

  it("preserves a legacy patch summary that has no result envelope", () => {
    expect(extractCompletedDiff({ status: "completed", summary: `Task finished.\n${patch}` })).toBe(patch);
    expect(extractCompletedDiff({ status: "completed", summary: "Task finished without a patch." })).toBeNull();
  });
});

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
