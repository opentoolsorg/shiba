import { describe, expect, it } from "vitest";
import { artifactWorkspaceExecutionTargetSchema } from "@shiba/shared";
import { buildExecutionTargetFields, hasComposerInput, parseArtifactDeliverables } from "./execution-target-input";

describe("dashboard execution target request fields", () => {
  it("allows an automatic output bundle while validating any requested artifact paths", () => {
    expect(parseArtifactDeliverables("")).toMatchObject({ success: true, data: [] });
    expect(parseArtifactDeliverables(" \n\t")).toMatchObject({ success: true, data: [] });
    expect(parseArtifactDeliverables("../private.md").success).toBe(false);
    expect(parseArtifactDeliverables(" reports/brief.md \nreports/sources.json")).toMatchObject({ success: true, data: ["reports/brief.md", "reports/sources.json"] });
  });

  it("requires explicit bounded unique text paths for local artifacts only", () => {
    for (const paths of ["", " \n\t", "out/archive.zip", "../private.md", "out/a.md\nout/A.md", Array.from({ length: 9 }, (_, i) => `out/${i}.txt`).join("\n")]) {
      expect(parseArtifactDeliverables(paths, "local").success).toBe(false);
    }
    expect(parseArtifactDeliverables(Array.from({ length: 8 }, (_, i) => `out/${i}.txt`).join("\n"), "local").success).toBe(true);
  });

  it("gives an automatic output bundle an ephemeral identity and keeps legacy empty artifact targets invalid", () => {
    const fields = buildExecutionTargetFields({ kind: "artifact-workspace", workspaceName: "Research", expectedDeliverables: [] });
    expect(fields.executionTarget).toMatchObject({ kind: "artifact-workspace", workspaceName: "Research", expectedDeliverables: [] });
    expect(fields.executionTarget).toHaveProperty("workspaceId");
    expect(artifactWorkspaceExecutionTargetSchema.safeParse(fields.executionTarget).success).toBe(true);
    expect(artifactWorkspaceExecutionTargetSchema.safeParse({ kind: "artifact-workspace", expectedDeliverables: [] }).success).toBe(false);
    expect(fields).not.toHaveProperty("repoUrl");
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
