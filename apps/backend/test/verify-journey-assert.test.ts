import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scripts = resolve(import.meta.dirname, "../../../.cursor/skills/verify-shiba/scripts");
const dirs: string[] = [];

function run(result: Record<string, unknown> | null, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "verify-assert-"));
  dirs.push(dir);
  mkdirSync(join(dir, "drive"));
  if (result) writeFileSync(join(dir, "drive/result.json"), JSON.stringify(result));
  // Port is unreachable on purpose: every case here must decide before any network poll.
  const proc = spawnSync("node", [join(scripts, "assert-journey.mjs")], {
    env: { ...process.env, VERIFY_DIR: dir, PORT: "1", ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
  const assertionsPath = join(dir, "drive/assertions.json");
  const assertions = existsSync(assertionsPath) ? JSON.parse(readFileSync(assertionsPath, "utf8")) : null;
  return { code: proc.status, stderr: proc.stderr, assertions };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("verify-shiba assert-journey", () => {
  it("fails when the drive step left no result", () => {
    const out = run(null);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("drive step did not run");
  });

  it("rejects an unknown feature instead of passing vacuously", () => {
    const out = run({ feature: "nope" });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('unknown feature "nope"');
  });

  it("preserves assertions.json when it fails", () => {
    const out = run({ feature: "nope" });
    expect(out.assertions?.failed).toContain("unknown feature");
  });

  it("requires the reject path for task-submit-and-approval", () => {
    expect(run({ feature: "task-submit-and-approval", approvalVisible: true }).code).toBe(1);
    expect(
      run({ feature: "task-submit-and-approval", approvalVisible: true, rejected: true }).code,
    ).toBe(0);
  });

  it.each(["byo-models-ux", "run-registry-status", "captain-subagents", "phase5-integrations-automations"])(
    "fails %s when its evidence is missing",
    (feature) => {
      expect(run({ feature }).code).toBe(1);
    },
  );

  it("passes byo-models-ux with its evidence", () => {
    expect(run({ feature: "byo-models-ux", modelConfigStatus: 200, connectionTestClicked: true }).code).toBe(0);
  });

  it.each(["core-loop-mock", "review-findings", "review-lifecycle", "pr-publish", "sandbox-run-and-diff"])(
    "fails %s without a recorded coding run id",
    (feature) => {
      const out = run({ feature, approvalVisible: true, approved: true, reviewFindingsVisible: true });
      expect(out.code).toBe(1);
      expect(out.stderr).toContain("codingRunId");
    },
  );

  it.each(["core-loop-mock", "review-findings", "review-lifecycle"])(
    "fails %s when review findings never rendered",
    (feature) => {
      const out = run({
        feature,
        approvalVisible: true,
        approved: true,
        codingRunId: "agent-tool:a1",
        reviewFindingsVisible: false,
      });
      expect(out.code).toBe(1);
      expect(out.stderr).toContain("review findings visible in UI");
    },
  );

  it("marks the sandbox diff skipped, not passed, when containers are disabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-assert-"));
    dirs.push(dir);
    mkdirSync(join(dir, "drive"));
    writeFileSync(join(dir, "containers-mode"), "disabled");
    writeFileSync(
      join(dir, "drive/result.json"),
      JSON.stringify({ feature: "sandbox-run-and-diff", approvalVisible: true, approved: true, codingRunId: "agent-tool:a1" }),
    );
    const proc = spawnSync("node", [join(scripts, "assert-journey.mjs")], {
      env: { ...process.env, VERIFY_DIR: dir },
      encoding: "utf8",
    });
    expect(proc.status).toBe(0);
    const steps = JSON.parse(readFileSync(join(dir, "drive/assertions.json"), "utf8")).steps;
    expect(steps).toContainEqual(expect.objectContaining({ name: "docker sandbox diff", status: "skipped" }));
  });
});

describe("verify-shiba journey-lib", () => {
  it("captures the newest verify approval and ignores stale/foreign cards", async () => {
    const lib = (await import(/* @vite-ignore */ join(scripts, "journey-lib.mjs"))) as {
      pickVerifyApproval: (a: unknown[], known?: string[]) => { approvalId: string } | undefined;
      runIdForApproval: (id: string) => string;
    };
    const approvals = [
      { approvalId: "old", task: "verify-shiba: x", createdAt: 1 },
      { approvalId: "other", task: "something else", createdAt: 9 },
      { approvalId: "mine", task: "verify-shiba: x", createdAt: 5 },
    ];
    expect(lib.pickVerifyApproval(approvals, ["old"])?.approvalId).toBe("mine");
    expect(lib.pickVerifyApproval([], [])).toBeUndefined();
    expect(lib.runIdForApproval("mine")).toBe("agent-tool:mine");
  });
});
