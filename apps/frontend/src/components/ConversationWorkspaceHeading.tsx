import type { JSX } from "react";
import { Cloud, FileText, FolderGit2, Laptop, MessageCircle } from "lucide-react";
import type { ConversationMode } from "../conversation-mode";

export interface ConversationWorkspaceHeadingProps {
  title: string;
  mode?: ConversationMode;
  appToolsWork?: boolean;
  executionTargetKind: "repository" | "artifact-workspace";
  runTarget: "sandbox" | "local";
  repoUrl: string;
  artifactWorkspaceName: string;
  machineName?: string;
}

function repositoryLabel(repoUrl: string): string {
  const parts = repoUrl.trim().replace(/\.git$/, "").split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : "Choose a repository";
}

/** A compact chat title and truthful summary of where the next task will run. */
export function ConversationWorkspaceHeading({
  title,
  mode = "work",
  appToolsWork = false,
  executionTargetKind,
  runTarget,
  repoUrl,
  artifactWorkspaceName,
  machineName,
}: ConversationWorkspaceHeadingProps): JSX.Element {
  const artifact = executionTargetKind === "artifact-workspace";
  const local = runTarget === "local" && !artifact;
  const target = artifact
    ? artifactWorkspaceName.trim() || "Untitled workspace"
    : local
      ? machineName?.trim() || "Paired computer"
      : repositoryLabel(repoUrl);
  const targetKind = artifact ? "Artifact workspace" : "Repository";
  const execution = artifact ? "Cloud sandbox" : local ? "Local computer" : "Cloud sandbox";
  const TargetIcon = artifact ? FileText : local ? Laptop : FolderGit2;
  const ExecutionIcon = local ? Laptop : Cloud;

  return (
    <div className="min-w-0 flex flex-col gap-0.5">
      <h1 className="text-base text-[var(--fg)] tracking-tight truncate">{title}</h1>
      {mode === "chat" ? (
        <div
          className="flex min-w-0 items-center gap-1.5 text-[10px] font-mono text-[var(--muted-foreground-2)]"
          role="status"
          aria-label="Chat mode, task tools disabled"
        >
          <span className="shrink-0 uppercase tracking-[0.08em]">Chat</span>
          <span aria-hidden="true">·</span>
          <MessageCircle aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">Conversation · no task tools</span>
        </div>
      ) : appToolsWork ? (
        <div className="flex min-w-0 items-center gap-1.5 text-[10px] font-mono text-[var(--muted-foreground-2)]" role="status" aria-label="Next task target: Connected app tools">
          <span className="shrink-0 uppercase tracking-[0.08em]">Next task</span>
          <span aria-hidden="true">·</span>
          <span className="truncate">Connected app tools · granted resources</span>
        </div>
      ) : <div
        className="flex min-w-0 items-center gap-1.5 text-[10px] font-mono text-[var(--muted-foreground-2)]"
        role="status"
        aria-label={`Next task target: ${execution}, ${targetKind}, ${target}`}
      >
        <span className="shrink-0 uppercase tracking-[0.08em]">Next task</span>
        <span aria-hidden="true">·</span>
        <ExecutionIcon aria-hidden="true" className="size-3 shrink-0" />
        <span className="shrink-0">{execution}</span>
        <span aria-hidden="true">·</span>
        <TargetIcon aria-hidden="true" className="size-3 shrink-0" />
        <span className="truncate">{targetKind}: {target}</span>
      </div>}
    </div>
  );
}
