import { X } from "lucide-react";
import { type ReactNode, useId } from "react";
import type { RetainedRun, StoredApproval } from "../types";
import { extractCompletedDiff, type PendingApproval, statusLabel } from "../ui-helpers";
import type { WorkPeekTab } from "../work-search";
import { ApprovalCard } from "./ApprovalCard";
import { DiffViewer } from "./DiffViewer";
import { RunDeliverables } from "./RunDeliverables";
import { RunLivePanel } from "./RunLivePanel";
import { WorkDetailModal } from "./WorkDetailModal";
import { StoredApprovalCard } from "./WorkspacePanel";
import type { WorkTask } from "./WorkView";

export interface WorkPeekProps {
  task: WorkTask;
  run?: RetainedRun;
  storedApproval?: StoredApproval;
  pendingApproval?: PendingApproval;
  tab: WorkPeekTab;
  onTabChange(tab: WorkPeekTab): void;
  onClose(): void;
  onOpenFull?(): void;
  onReviewApproval?(): void;
  sessionId?: string;
  notice?: ReactNode;
  decisions?: Record<string, boolean>;
  onDecideApproval?: (id: string, approved: boolean) => void;
  onDecideStoredApproval?: (approval: StoredApproval, approved: boolean, claimAction?: "queue" | "new_branch" | "cancel") => void;
  claimConflict?: { actorId: string; branch: string; repo: string; runId: string } | null;
  /** Supply existing thread/live components for the selected task, with their original scope and handlers. */
  renderContent?: (task: WorkTask, tab: WorkPeekTab) => ReactNode;
}

const TABS = [
  { id: "steps", label: "Steps" },
  { id: "approval", label: "Approval" },
  { id: "diff", label: "Diff" },
  { id: "output", label: "Output" },
] as const;
const control =
  "inline-flex min-h-11 items-center justify-center border border-[var(--border-1)] px-3 text-xs focus-visible:outline-2 focus-visible:outline-[var(--ring)] [@media(hover:hover)]:hover:bg-[var(--card-hover)]";

export function WorkPeek(props: WorkPeekProps) {
  const {
    task,
    run,
    storedApproval,
    pendingApproval,
    tab,
    onTabChange,
    onClose,
    onOpenFull,
    onReviewApproval,
    decisions = {},
  } = props;
  const id = useId();
  const diff = run ? (extractCompletedDiff(run) ?? run.diff) : undefined;
  const decision = decisions[task.id];
  const custom = props.renderContent?.(task, tab);
  const approval = storedApproval ?? pendingApproval;
  const frozen = storedApproval?.payload ?? pendingApproval?.input;
  const content =
    custom ??
    (tab === "approval" ? (
      storedApproval && props.onDecideStoredApproval ? (
        <StoredApprovalCard
          approval={storedApproval}
          decided={decision !== undefined || storedApproval.status !== "pending"}
          decision={decision}
          onDecide={props.onDecideStoredApproval}
          conflict={props.claimConflict}
          onClaimChoice={(choice) => props.onDecideStoredApproval?.(storedApproval, choice !== "cancel", choice)}
        />
      ) : pendingApproval && props.onDecideApproval ? (
        <ApprovalCard
          approval={pendingApproval}
          decided={decision !== undefined}
          decision={decision}
          onDecideApproval={props.onDecideApproval}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <p>
            {approval
              ? "Review the frozen request before deciding."
              : "No approval request is linked to this item."}
          </p>
          {frozen !== undefined ? (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words border border-[var(--border-1)] p-3 font-mono text-xs">
              {typeof frozen === "string" ? frozen : JSON.stringify(frozen, null, 2)}
            </pre>
          ) : null}
          {onReviewApproval ? (
            <button type="button" className={control} onClick={onReviewApproval}>
              Open approval review
            </button>
          ) : null}
        </div>
      )
    ) : tab === "diff" ? (
      diff ? (
        <DiffViewer diff={diff} />
      ) : (
        <p>
          {run?.hasDiff
            ? "A diff is retained. Open the full thread to load its details."
            : "No diff is loaded for this item. Open the full thread to inspect available changes."}
        </p>
      )
    ) : tab === "output" ? (
      run ? (
        <div className="flex flex-col gap-4">
          {run.summary ? (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm">{run.summary}</pre>
          ) : (
            <p>No output summary is loaded.</p>
          )}
          {run.pullUrl ? (
            <a
              href={run.pullUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`${control} w-fit`}
            >
              Open pull request
            </a>
          ) : null}
          <p className="text-xs text-[var(--muted-foreground-2)]">
            Run status and PR links do not establish test results or merge status.
          </p>
          <RunDeliverables
            runId={run.runId}
            status={run.status}
            expected={run.expectedDeliverables}
            deliverables={run.deliverables}
            sessionId={props.sessionId}
          />
        </div>
      ) : (
        <p>No run deliverables are linked to this item.</p>
      )
    ) : (
      <div className="flex flex-col gap-4">
        {run?.error ? (
          <p role="alert" className="break-words text-[var(--destructive)]">
            {run.error}
          </p>
        ) : null}
        {run?.signals?.length ? (
          <ol aria-label="Recorded run steps" className="flex flex-col gap-3">
            {run.signals.map((signal, index) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: Signal order is persisted and append-only; repeated kinds and timestamps are valid.
                key={`${signal.kind}-${signal.at}-${index}`}
                className="border-l-2 border-[var(--border-1)] pl-3"
              >
                <p className="font-mono text-xs">{signal.kind}</p>
                <time
                  dateTime={new Date(signal.at).toISOString()}
                  className="text-xs text-[var(--muted-foreground-2)]"
                >
                  {new Date(signal.at).toLocaleString()}
                </time>
                {signal.detail ? (
                  <p className="whitespace-pre-wrap break-words text-xs">{signal.detail}</p>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p>
            No recorded steps are loaded. Open the full thread for its conversation and live output.
          </p>
        )}
        {run && props.sessionId !== undefined ? (
          <RunLivePanel
            key={`${props.sessionId}:${run.runId}`}
            runId={run.runId}
            sessionId={props.sessionId}
            showDiff={false}
          />
        ) : null}
      </div>
    ));

  return (
    <WorkDetailModal label={`Work inspector: ${task.title}`} onClose={onClose}>
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border-1)] p-4">
        <div className="min-w-0">
          <p className="break-all font-mono text-[10px] uppercase text-[var(--muted-foreground-2)]">
            {task.kind} · {task.id}
          </p>
          <h2 className="mt-1 break-words font-serif text-2xl">{task.title}</h2>
          <p className="mt-2 text-xs">
            {run ? statusLabel(run.status) : task.stateLabel}
            {run?.pullUrl ? " · PR linked" : ""}
          </p>
          {task.repo ? (
            <p className="mt-1 break-all font-mono text-xs text-[var(--muted-foreground-2)]">
              {task.repo}
              {run?.baseBranch ? ` · base ${run.baseBranch}` : ""}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Close task"
          onClick={onClose}
          className={`${control} min-w-11 shrink-0 px-0`}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </header>
      <div
        role="tablist"
        aria-label="Work inspector sections"
        className="flex shrink-0 overflow-x-auto border-b border-[var(--border-1)]"
      >
        {TABS.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${id}-${item.id}`}
            aria-controls={`${id}-panel`}
            aria-selected={tab === item.id}
            tabIndex={tab === item.id ? 0 : -1}
            className={`${control} flex-1 border-0 border-b-2 ${tab === item.id ? "border-b-[var(--primary)] font-semibold" : "border-b-transparent"}`}
            onClick={() => onTabChange(item.id)}
            onKeyDown={(event) => {
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? TABS.length - 1
                    : event.key === "ArrowRight"
                      ? (index + 1) % TABS.length
                      : event.key === "ArrowLeft"
                        ? (index + TABS.length - 1) % TABS.length
                        : -1;
              const target = TABS[next];
              if (!target) return;
              event.preventDefault();
              onTabChange(target.id);
              document.getElementById(`${id}-${target.id}`)?.focus();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {props.notice ? (
        <div role="status" className="shrink-0 border-b border-[var(--border-1)] px-4 py-3 text-xs">
          {props.notice}
        </div>
      ) : null}
      <section
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${tab}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: WAI-ARIA tabs make the panel focusable so keyboard users can read and scroll its content.
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto overscroll-contain p-4 text-sm text-[var(--fg)]"
      >
        {content}
      </section>
      {onOpenFull ? (
        <footer className="shrink-0 border-t border-[var(--border-1)] p-3">
          <button type="button" className={control} onClick={onOpenFull}>
            {task.kind === "approval" ? "Open approval queue" : "Open full thread"}
          </button>
        </footer>
      ) : null}
    </WorkDetailModal>
  );
}
