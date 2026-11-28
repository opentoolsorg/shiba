import { BookOpen, Brain, FileText, Folder, Images, LayoutGrid } from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";
import { type AppNavView, areaForView, navigationLabel } from "../app-navigation";

interface ShellNavigation {
  activeView: AppNavView;
  onNavigate: (view: AppNavView) => void;
  pendingApprovalCount: number;
}
const ShellNavigationContext = createContext<ShellNavigation | null>(null);
const AREA_VIEW_ICONS: Partial<Record<AppNavView, typeof FileText>> = {
  memory: Brain,
  files: FileText,
  notes: BookOpen,
  projects: Folder,
  outputs: Images,
  spaces: LayoutGrid,
};

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
      <p className="flex h-12 min-h-12 items-center pl-3 pr-1.5 text-[15px] font-semibold capitalize tracking-tight text-[var(--fg)]">
        {area.label}
      </p>
      {area.views.map((view) => {
        const Icon = AREA_VIEW_ICONS[view];
        return (
          <button
            type="button"
            key={view}
            className="shiba-area-link"
            aria-label={navigationLabel(view)}
            aria-current={shell.activeView === view ? "page" : undefined}
            onClick={() => shell.onNavigate(view)}
          >
            {Icon ? (
              <Icon
                className="size-4 shrink-0 text-[var(--muted-foreground-2)]"
                aria-hidden="true"
              />
            ) : null}
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
        );
      })}
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
