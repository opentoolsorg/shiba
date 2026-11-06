import type { JSX, ReactNode } from "react";
import {
  ChevronRight,
  Cloud,
  FileText,
  FolderGit2,
  Laptop,
  MessageCircle,
  PanelLeft,
} from "lucide-react";
import type { ConversationMode } from "../conversation-mode";
import { Tooltip } from "./Tooltip";

export interface ConversationWorkspaceHeadingProps {
  title: string;
  mode?: ConversationMode;
  appToolsWork?: boolean;
  executionTargetKind: "repository" | "artifact-workspace";
  runTarget: "sandbox" | "local";
  repoUrl: string;
  artifactWorkspaceName: string;
  machineName?: string;

  // Top-bar header integration props
  crumbs?: string[];
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  actions?: ReactNode;
  className?: string;
}

function repositoryLabel(repoUrl: string): string {
  const parts = repoUrl.trim().replace(/\.git$/, "").split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : "Choose a repository";
}

/**
 * ConversationWorkspaceHeading — Thread header and execution target indicator.
 *
 * Truthfully displays where the next task will run (sandbox vs local paired computer;
 * git repository vs artifact workspace; or connected app tools).
 * When `crumbs` is provided, renders the 48px top bar header row with breadcrumb,
 * execution target badge, and right-aligned actions.
 */
export function ConversationWorkspaceHeading({
  title,
  mode = "work",
  appToolsWork = false,
  executionTargetKind,
  runTarget,
  repoUrl,
  artifactWorkspaceName,
  machineName,
  crumbs,
  sidebarCollapsed = false,
  onToggleSidebar,
  actions,
  className = "",
}: ConversationWorkspaceHeadingProps): JSX.Element {
  const artifact = executionTargetKind === "artifact-workspace";
  const local = runTarget === "local";
  const target = artifact
    ? artifactWorkspaceName.trim() || "Untitled workspace"
    : local
      ? machineName?.trim() || "Paired computer"
      : repositoryLabel(repoUrl);
  const targetKind = artifact ? "Artifact workspace" : "Repository";
  const execution = local ? "Local computer" : "Cloud sandbox";
  const TargetIcon = artifact ? FileText : local ? Laptop : FolderGit2;
  const ExecutionIcon = local ? Laptop : Cloud;

  const targetStatusNode =
    mode === "chat" ? (
      <div
        className="flex min-w-0 items-center gap-1.5 text-[11px] font-mono text-[#71717a] dark:text-zinc-400"
        role="status"
        aria-label="Chat mode, task tools disabled"
      >
        <span className="shrink-0 uppercase tracking-[0.08em]">Chat</span>
        <span aria-hidden="true">·</span>
        <MessageCircle aria-hidden="true" className="size-3 shrink-0" />
        <span className="truncate">Conversation · no task tools</span>
      </div>
    ) : appToolsWork ? (
      <div
        className="flex min-w-0 items-center gap-1.5 text-[11px] font-mono text-[#71717a] dark:text-zinc-400"
        role="status"
        aria-label="Next task target: Connected app tools"
      >
        <span className="shrink-0 uppercase tracking-[0.08em]">Next task</span>
        <span aria-hidden="true">·</span>
        <span className="truncate">Connected app tools · granted resources</span>
      </div>
    ) : (
      <div
        className="flex min-w-0 items-center gap-1.5 text-[11px] font-mono text-[#71717a] dark:text-zinc-400"
        role="status"
        aria-label={`Next task target: ${execution}, ${targetKind}, ${target}`}
      >
        <span className="shrink-0 uppercase tracking-[0.08em]">Next task</span>
        <span aria-hidden="true">·</span>
        <ExecutionIcon aria-hidden="true" className="size-3 shrink-0" />
        <span className="shrink-0">{execution}</span>
        <span aria-hidden="true">·</span>
        <TargetIcon aria-hidden="true" className="size-3 shrink-0" />
        <span className="truncate">
          {targetKind}: {target}
        </span>
      </div>
    );

  // If breadcrumbs are provided, render 48px top bar
  if (crumbs && crumbs.length > 0) {
    return (
      <header
        className={`h-12 min-h-[48px] w-full px-4 flex items-center justify-between select-none shrink-0 border-b border-[#e4e4e7] dark:border-zinc-800 bg-white dark:bg-zinc-900 ${className}`.trim()}
      >
        {/* Left: sidebar toggle + breadcrumbs */}
        <div className="flex items-center gap-2.5 min-w-0">
          {onToggleSidebar ? (
            <Tooltip
              content={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              shortcut="⌘B"
              side="bottom"
            >
              <button
                type="button"
                onClick={onToggleSidebar}
                aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                aria-expanded={!sidebarCollapsed}
                className="size-7 rounded-md flex items-center justify-center text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-[#f4f4f5] dark:hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400"
              >
                <PanelLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
              </button>
            </Tooltip>
          ) : null}

          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 min-w-0">
            <ol className="flex items-center gap-1.5 min-w-0">
              {crumbs.map((crumb, idx) => {
                const isLast = idx === crumbs.length - 1;
                return (
                  <li key={`${crumb}-${idx}`} className="flex items-center gap-1.5 min-w-0">
                    {idx > 0 ? (
                      <ChevronRight
                        className="size-3.5 text-[#a1a1aa] dark:text-zinc-600 shrink-0"
                        strokeWidth={1.5}
                        aria-hidden="true"
                      />
                    ) : null}
                    <span
                      className={
                        isLast
                          ? "text-[14px] font-semibold text-[#0a0a0a] dark:text-zinc-100 truncate"
                          : "text-[14px] text-[#71717a] dark:text-zinc-400 truncate"
                      }
                      aria-current={isLast ? "page" : undefined}
                    >
                      {crumb}
                    </span>
                  </li>
                );
              })}
            </ol>
          </nav>

          <span className="text-[#d4d4d8] dark:text-zinc-700 select-none">|</span>
          <div className="hidden sm:flex min-w-0">{targetStatusNode}</div>
        </div>

        {/* Heading hidden visually when in breadcrumb mode, but accessible */}
        <h1 className="sr-only">{title}</h1>

        {/* Right actions */}
        {actions ? <div className="flex items-center gap-1">{actions}</div> : null}
      </header>
    );
  }

  // Compact heading mode (default)
  return (
    <div className={`min-w-0 flex flex-col gap-0.5 select-none ${className}`.trim()}>
      <h1 className="text-base font-semibold text-[#0a0a0a] dark:text-zinc-100 tracking-tight truncate">
        {title}
      </h1>
      {targetStatusNode}
    </div>
  );
}
