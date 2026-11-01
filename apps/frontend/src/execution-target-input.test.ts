import { describe, expect, it } from "vitest";
import { buildExecutionTargetFields, hasComposerInput, parseArtifactDeliverables } from "./execution-target-input";

describe("dashboard execution target request fields", () => {
  it("requires at least one safe artifact output with the same contract as server intake", () => {
    expect(parseArtifactDeliverables("").success).toBe(false);
    expect(parseArtifactDeliverables(" \n\t").success).toBe(false);
    expect(parseArtifactDeliverables("../private.md").success).toBe(false);
    expect(parseArtifactDeliverables(" reports/brief.md \nreports/sources.json")).toMatchObject({ success: true, data: ["reports/brief.md", "reports/sources.json"] });
  });

  it("allows repo-free artifact, Chat, and app-tool shortcut input while repository Work still requires a repo", () => {
    const input = { task: "Draft a brief", repoUrl: "", executionTargetKind: "repository" as const, conversationMode: "work" as const };
    expect(hasComposerInput(input)).toBe(false);
    expect(hasComposerInput({ ...input, repoUrl: "https://github.com/acme/app" })).toBe(true);
    expect(hasComposerInput({ ...input, executionTargetKind: "artifact-workspace" })).toBe(true);
    expect(hasComposerInput({ ...input, conversationMode: "chat" })).toBe(true);
    expect(hasComposerInput({ ...input, appToolsWork: true })).toBe(true);
    expect(hasComposerInput({ ...input, task: " ", executionTargetKind: "artifact-workspace" })).toBe(false);
  });
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
