import { artifactWorkspaceExecutionTargetSchema, type ArtifactWorkspaceExecutionTarget, type RepositoryExecutionTarget } from "@shiba/shared";

export function parseArtifactDeliverables(text: string) {
  return artifactWorkspaceExecutionTargetSchema.shape.expectedDeliverables.safeParse(text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
}

/** Input presence shared by the composer and the global submit shortcut. */
export function hasComposerInput(input: {
  task: string;
  repoUrl: string;
  executionTargetKind: "repository" | "artifact-workspace";
  conversationMode?: "chat" | "work";
  appToolsWork?: boolean;
}): boolean {
  return Boolean(input.task.trim() && (input.conversationMode === "chat" || input.appToolsWork || input.executionTargetKind === "artifact-workspace" || input.repoUrl.trim()));
}

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
