import type { ArtifactWorkspaceExecutionTarget, RepositoryExecutionTarget } from "@shiba/shared";

export type DashboardExecutionTargetFields =
  | {
      executionTarget: RepositoryExecutionTarget;
      /** Legacy mirrors remain for older API readers and external clients. */
      repoUrl: string;
      baseBranch: string;
    }
  | { executionTarget: ArtifactWorkspaceExecutionTarget };

export function buildExecutionTargetFields(input:
  | { kind: "repository"; repoUrl: string; baseBranch: string }
  | { kind: "artifact-workspace"; workspaceName: string; expectedDeliverables: string[] },
): DashboardExecutionTargetFields {
  if (input.kind === "repository") {
    const target: RepositoryExecutionTarget = {
      kind: "repository",
      repoUrl: input.repoUrl,
      baseBranch: input.baseBranch,
    };
    return { executionTarget: target, repoUrl: input.repoUrl, baseBranch: input.baseBranch };
  }
  const target: ArtifactWorkspaceExecutionTarget = {
    kind: "artifact-workspace",
    workspaceName: input.workspaceName.trim() || "My workspace",
    expectedDeliverables: input.expectedDeliverables,
  };
  return { executionTarget: target };
}
