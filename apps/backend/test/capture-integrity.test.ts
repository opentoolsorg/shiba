import { describe, expect, it } from "vitest";
import { SandboxRuntimeAdapter } from "../src/runtime.js";
import { repositorySnapshotFixture } from "./repository-snapshot-fixture.js";
import type { SandboxOps } from "../src/runtime.js";

const INPUT = {
  repoUrl: "https://github.com/owner/repo",
  task: "t",
  baseBranch: "main",
  publishPullRequest: false,
  sandboxId: "run-abc",
  codingModel: "google/gemini-3.5-flash-lite",
};

function opsWithStatus(stdout: string, files?: Record<string, string>): SandboxOps {
  const snapshot = repositorySnapshotFixture({ status: stdout, files });
  return {
    async gitCheckout() {},
    async writeFile() {},
    async exec(command) {
      const result = await snapshot(command);
      if (result) return result;
      if (command.includes("status")) return { stdout, stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async readFile() {
      return { kind: "utf8", content: "x" };
    },
  } as SandboxOps;
}

const stdout = Array.from({ length: 51 }, (_, i) => ` M src/f${i}.ts`).join("\n") + "\n";

describe("capture integrity (#18)", () => {
  it("fails the run instead of publishing past the file cap", async () => {
    const adapter = new SandboxRuntimeAdapter();
    const result = await adapter.runCodingTask(opsWithStatus(stdout), INPUT, () => {});
    expect(result.status).toBe("error");
    expect(result.summary).toContain("capture limit");
  });

  it("fails the run when complete captured bytes exceed the total cap", async () => {
    const paths = Array.from({ length: 6 }, (_, i) => `src/f${i}.ts`);
    const status = paths.map((path) => ` M ${path}`).join("\n") + "\n";
    const files = Object.fromEntries(paths.map((path) => [path, "x".repeat(100_000)]));
    const result = await new SandboxRuntimeAdapter().runCodingTask(opsWithStatus(status, files), INPUT, () => {});
    expect(result.status).toBe("error");
    expect(result.summary).toContain("partial tree");
  });
});
