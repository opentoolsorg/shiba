import type { JSX } from "react";
import {
  Activity,
  BarChart3,
  CheckCheck,
  GitPullRequest,
  LayoutDashboard,
} from "lucide-react";
import {
  ContextPanel,
  PanelNavItem,
  type Scope,
} from "./ui/ContextPanel";

export interface InsightsPanelProps {
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  active: string;
  onSelect: (id: string) => void;
  pendingApprovalsCount?: number;
  className?: string;
}

/**
 * InsightsPanel — Secondary contextual panel (~265px) for the Insights hub.
 * Nav items:
 *   - Dashboard (dashboard)
 *   - Usage (analytics)
 *   - Activity (activity)
 *   - Pull requests (diff)
 *   - Approvals (approvals, with real pending count badge)
 */
export function InsightsPanel({
  scope,
  onScopeChange,
  active,
  onSelect,
  pendingApprovalsCount = 0,
  className = "",
}: InsightsPanelProps): JSX.Element {
  return (
    <ContextPanel
      title="Insights"
      scope={scope}
      onScopeChange={onScopeChange}
      className={className}
    >
      <nav aria-label="Insights navigation" className="flex flex-col gap-0.5 pt-1">
        <PanelNavItem
          icon={LayoutDashboard}
          label="Dashboard"
          active={active === "dashboard"}
          onClick={() => onSelect("dashboard")}
        />
        <PanelNavItem
          icon={BarChart3}
          label="Usage"
          active={active === "analytics" || active === "usage"}
          onClick={() => onSelect("analytics")}
        />
        <PanelNavItem
          icon={Activity}
          label="Activity"
          active={active === "activity"}
          onClick={() => onSelect("activity")}
        />
        <PanelNavItem
          icon={GitPullRequest}
          label="Pull requests"
          active={active === "diff" || active === "pull-requests" || active === "prs"}
          onClick={() => onSelect("diff")}
        />
        <PanelNavItem
          icon={CheckCheck}
          label="Approvals"
          active={active === "approvals"}
          onClick={() => onSelect("approvals")}
          trailing={
            pendingApprovalsCount > 0 ? (
              <span
                role="status"
                aria-label={`${pendingApprovalsCount} pending approvals`}
                className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-400/20 dark:text-amber-300 tabular-nums"
              >
                {pendingApprovalsCount}
              </span>
            ) : null
          }
        />
      </nav>
    </ContextPanel>
  );
}
