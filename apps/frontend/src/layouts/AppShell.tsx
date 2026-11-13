import { createContext, useContext, type ReactNode } from "react";
import { navigationLabel, areaForView, type AppNavView } from "../app-navigation";

interface ShellNavigation {
  activeView: AppNavView;
  onNavigate: (view: AppNavView) => void;
  pendingApprovalCount: number;
}
const ShellNavigationContext = createContext<ShellNavigation | null>(null);

/** Provides the same area navigation to existing context panels without moving their state. */
export function AppShell({ children, ...navigation }: ShellNavigation & { children: ReactNode }) {
  return (
    <ShellNavigationContext.Provider value={navigation}>
      <div className="shiba-app-shell h-dvh overflow-hidden bg-[var(--bg)] text-[var(--fg)] font-sans selection:bg-[var(--primary)] selection:text-[var(--primary-text)] flex pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
        {children}
      </div>
    </ShellNavigationContext.Provider>
  );
}

/** Rendered above the current surface's own filters, lists and actions. */
export function AppAreaNavigation() {
  const shell = useContext(ShellNavigationContext);
  if (!shell) return null;
  const area = areaForView(shell.activeView);
  return (
    <nav aria-label={`${area.label} destinations`} className="shiba-area-navigation">
      <p className="px-2 pb-1 text-xs font-semibold text-[var(--muted-foreground-2)]">
        {area.label}
      </p>
      {area.views.map((view) => (
        <button
          type="button"
          key={view}
          className="shiba-area-link"
          aria-label={navigationLabel(view)}
          aria-current={shell.activeView === view ? "page" : undefined}
          onClick={() => shell.onNavigate(view)}
        >
          <span className="min-w-0 flex-1 truncate">{navigationLabel(view)}</span>
          {view === "approvals" && shell.pendingApprovalCount > 0 ? (
            <span
              role="status"
              className="font-mono text-xs tabular-nums"
              aria-label={`${shell.pendingApprovalCount} pending approvals`}
            >
              {shell.pendingApprovalCount}
            </span>
          ) : null}
        </button>
      ))}
    </nav>
  );
}

export function AppAreaSidebar() {
  return (
    <aside
      id="app-area-panel"
      aria-label="Area navigation"
      className="shiba-destination-panel overflow-y-auto"
    >
      <AppAreaNavigation />
    </aside>
  );
}
