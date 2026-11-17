import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isQuietRoutine, parseRoutineOutcome, routineCommandFiles, routineIdentity } from "../src/routine-outcome.js";
import { SandboxRuntimeAdapter, type SandboxOps } from "../src/runtime.js";
import { verifyRunOutcome } from "../src/harness/types.js";
import type { CodingTaskInput } from "../src/opencode-input.js";
import { repositorySnapshotFixture } from "./repository-snapshot-fixture.js";

const input: CodingTaskInput = { repoUrl: "https://github.com/o/r", task: "Check for updates", sandboxId: "routine-test",
  baseBranch: "main", publishPullRequest: false, codingModel: "google/gemini-3.5-flash-lite", routineRun: { automationId: "nightly", test: false } };

describe("routine commands", () => {
  it("preserves both calls in either order and rejects an empty failure reason", () => {
    const commands = routineCommandFiles(input)!;
    const directory = mkdtempSync(join(tmpdir(), "routine-commands-"));
    try {
      for (const file of commands.files) writeFileSync(join(directory, basename(file.path)), file.contents);
      for (const order of [["routine_no_update", "routine_report_failure"], ["routine_report_failure", "routine_no_update"]]) {
        writeFileSync(join(directory, "outcome.json"), '{"noUpdate":false}');
        for (const command of order) execFileSync("node", [join(directory, command), ...(command === "routine_report_failure" ? ["Cannot fetch report"] : [])]);
        expect(parseRoutineOutcome(readFileSync(join(directory, "outcome.json"), "utf8"))).toEqual({ noUpdate: true, failureReason: "Cannot fetch report" });
      }
      expect(() => execFileSync("node", [join(directory, "routine_report_failure")], { stdio: "pipe" })).toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("redacts and bounds reasons and rejects malformed outcomes", () => {
    const outcome = parseRoutineOutcome(JSON.stringify({ noUpdate: true, failureReason: `ghp_abcdefgh12345678 ${"x".repeat(600)}` }));
    expect(outcome.failureReason).not.toContain("ghp_abcdefgh");
    expect(outcome.failureReason).toHaveLength(500);
    for (const content of ["null", "{}", '{"noUpdate":true,"failureReason":""}', "not json"]) expect(() => parseRoutineOutcome(content)).toThrow();
  });

  it.each([{ noUpdate: true }, { noUpdate: false, failureReason: "Unavailable" }])("accepts an intentionally empty routine result: %j", (routineOutcome) => {
    const result = { status: "completed" as const, exitCode: 0, summary: "No repository changes", changedFiles: [], files: [], diff: "", stderrTail: "", routineOutcome };
    expect(verifyRunOutcome(input, result, { canRunTests: true })).toEqual({ ok: true });
    expect(verifyRunOutcome({ ...input, routineRun: undefined }, result, { canRunTests: true }).ok).toBe(false);
  });

  it.each([
    [false, false, undefined, false], [true, false, undefined, true], [true, true, undefined, false],
    [false, false, "failed", false], [true, false, "failed", false],
  ])("applies quiet precedence (noUpdate=%s, test=%s, failure=%s)", (noUpdate, test, failureReason, quiet) => {
    expect(isQuietRoutine({ status: "completed", routineRun: { automationId: "nightly", test }, routineOutcome: { noUpdate, failureReason } })).toBe(quiet);
  });

  it("uses only the server intake voucher to identify routines", () => {
    expect(routineIdentity("routine:nightly:test")).toEqual({ automationId: "nightly", test: true });
    expect(routineIdentity("routine:nightly:scheduled")).toEqual({ automationId: "nightly", test: false });
    expect(routineIdentity("dashboard")).toBeUndefined();
    expect(routineIdentity("routine:%:test")).toBeUndefined();
  });

  it.each(["", "Final answer: No updates. ghp_abcdefgh12345678", `${"x".repeat(2400)} Final answer: No updates. ghp_abcdefgh12345678`])("retains bounded redacted harness output for unchanged routines", async (answer) => {
    const snapshot = repositorySnapshotFixture({ status: "" });
    const ops: SandboxOps = { gitCheckout: async () => {},
      exec: async (command) => await snapshot(command) ?? { exitCode: 0, stdout: answer, stderr: "" },
      writeFile: async () => {}, readFile: async () => ({ kind: "utf8", content: '{"noUpdate":true}' }),
    };
    const result = await new SandboxRuntimeAdapter().runCodingTask(ops, input, () => {});
    expect(result).toMatchObject({ status: "completed", changedFiles: [], routineOutcome: { noUpdate: true } });
    if (answer) expect(result.summary).toContain("Final answer: No updates. [redacted]");
    expect(result.summary).not.toContain("ghp_abcdefgh12345678");
    expect(result.summary.length).toBeLessThan(2200);
  });

  it.each([true, false])("installs commands and captures an outcome only for routine runs (%s)", async (routine) => {
    const snapshot = repositorySnapshotFixture({ status: " M a.txt\n", files: { "a.txt": "updated" } });
    const writes = new Map<string, string>();
    const exec = vi.fn<SandboxOps["exec"]>(async (command) => await snapshot(command) ?? { exitCode: 0, stdout: "done", stderr: "" });
    const ops: SandboxOps = { gitCheckout: async () => {}, exec,
      writeFile: async (path, content) => { writes.set(path, content); },
      readFile: async () => ({ kind: "utf8", content: '{"noUpdate":true}' }),
    };
    const task = { ...input, routineRun: routine ? input.routineRun : undefined };
    const result = await new SandboxRuntimeAdapter().runCodingTask(ops, task, () => {});
    expect(result.status).toBe("completed");
    const files = [...writes.keys()].filter((path) => path.includes("shiba-routine-"));
    expect(files).toHaveLength(routine ? 3 : 0);
    expect(files.every((path) => path.startsWith("/tmp/") && !path.startsWith("/workspace/"))).toBe(true);
    const harness = exec.mock.calls.find(([command]) => command.includes("opencode"))!;
    expect(harness).toBeDefined();
    if (routine) {
      expect(harness[0]).toContain("routine_report_failure");
      expect(harness[1]?.env?.PATH).toMatch(/^\/tmp\/shiba-routine-routine-test:/);
      expect(result.routineOutcome).toEqual({ noUpdate: true });
    } else {
      expect(harness[0]).not.toContain("routine_report_failure");
      expect(result).not.toHaveProperty("routineOutcome");
    }
  });
});
