import { describe, expect, it } from "vitest";
import { buildExecutionTargetFields } from "./execution-target-input";

describe("dashboard execution target request fields", () => {
  it("keeps repository requests typed and mirrors the legacy repository fields", () => {
    expect(buildExecutionTargetFields({
      kind: "repository",
      repoUrl: "https://github.com/acme/app",
      baseBranch: "main",
    })).toEqual({
      executionTarget: { kind: "repository", repoUrl: "https://github.com/acme/app", baseBranch: "main" },
      repoUrl: "https://github.com/acme/app",
      baseBranch: "main",
    });
  });

  it("creates an artifact target without repository fields and normalizes a blank workspace name", () => {
    const fields = buildExecutionTargetFields({
      kind: "artifact-workspace",
      workspaceName: "  ",
      expectedDeliverables: ["deliverables/brief.md"],
    });
    expect(fields).toEqual({
      executionTarget: {
        kind: "artifact-workspace",
        workspaceName: "My workspace",
        expectedDeliverables: ["deliverables/brief.md"],
      },
    });
    expect(fields).not.toHaveProperty("repoUrl");
    expect(fields).not.toHaveProperty("baseBranch");
  });
});
