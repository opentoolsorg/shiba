import { useMemo, type JSX } from "react";
import { Bot, Briefcase, CheckCircle2, Network, Users } from "lucide-react";

export interface OrganizationEmployee {
  id: string;
  name: string;
  role: string;
  department?: string;
  avatar?: string;
  emoji?: string;
  openTaskCount?: number;
  openTasks?: number;
  slug?: string;
  status?: "idle" | "working" | "active" | "offline" | string;
  description?: string;
  config?: {
    name?: string;
    emoji?: string;
    instructions?: string;
    expectedDeliverables?: readonly string[];
  };
}

export interface OrganizationUser {
  id?: string;
  name?: string;
  role?: string;
  avatar?: string;
  email?: string;
  /** Set only when the app knows the user is currently active. */
  active?: boolean;
}

export interface WorkOrganizationViewProps {
  employees: OrganizationEmployee[];
  onOpen?: (id: string) => void;
  user?: OrganizationUser;
  className?: string;
}

/** Extracts the display name for an employee. */
function getEmployeeName(emp: OrganizationEmployee): string {
  return emp.name || emp.config?.name || emp.slug || emp.id;
}

/** Extracts a 1-2 character uppercase initial from a name. */
function getInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length > 1 && parts[0] && parts[1]) {
    return (parts[0][0]! + parts[1][0]!).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

/** Resolves the department/group for an employee. */
function getDepartment(emp: OrganizationEmployee): string {
  if (emp.department && emp.department.trim()) {
    return emp.department.trim();
  }
  if (emp.role && emp.role.trim()) {
    const roleLower = emp.role.toLowerCase();
    if (roleLower.includes("engineer")) return "Engineering";
    if (roleLower.includes("market")) return "Marketing";
    if (roleLower.includes("research")) return "Research";
    if (roleLower.includes("operation")) return "Operations";
    if (roleLower.includes("sales")) return "Sales";
    if (roleLower.includes("product")) return "Product";
    if (roleLower.includes("design")) return "Design";
    return emp.role.trim();
  }
  return "General";
}

/**
 * Presentational Organization View:
 * Renders the workspace user at the top and Shiba AI employees grouped by department/role in a tree hierarchy.
 */
export function WorkOrganizationView({
  employees,
  onOpen,
  user,
  className = "",
}: WorkOrganizationViewProps): JSX.Element {
  const userName = user?.name || "You";
  const userRole = user?.role;
  const userInitial = getInitial(userName);

  const grouped = useMemo(() => {
    const map = new Map<string, OrganizationEmployee[]>();
    for (const emp of employees) {
      const dept = getDepartment(emp);
      const list = map.get(dept) || [];
      list.push(emp);
      map.set(dept, list);
    }
    // Return sorted groups
    return Array.from(map.entries())
      .map(([department, members]) => ({
        department,
        members,
      }))
      .sort((a, b) => a.department.localeCompare(b.department));
  }, [employees]);

  return (
    <div
      data-testid="work-organization-view"
      className={`w-full h-full overflow-y-auto px-4 py-8 sm:px-8 flex flex-col items-center select-none ${className}`.trim()}
    >
      <div className="w-full max-w-4xl flex flex-col items-center">
        {/* User Card at the top */}
        <div
          data-testid="organization-user-card"
          className="w-full max-w-md rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 shadow-sm"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div
                aria-hidden="true"
                className="size-11 rounded-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 flex items-center justify-center font-semibold text-sm shrink-0 shadow-inner"
              >
                {userInitial}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                    {userName}
                  </h3>
                </div>
                {userRole ? (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
                    {userRole}
                  </p>
                ) : null}
              </div>
            </div>

            {user?.active ? (
              <div className="text-right shrink-0">
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--success-fg)] bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-full border border-emerald-200/60 dark:border-emerald-800/40">
                  <CheckCircle2 className="size-3" />
                  Active
                </span>
              </div>
            ) : null}
          </div>
        </div>

        {/* Tree Trunk Connector */}
        <div className="flex flex-col items-center">
          <div className="w-0.5 h-6 bg-zinc-200 dark:bg-zinc-800" />
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 text-[11px] font-medium text-zinc-500 dark:text-zinc-400 shadow-2xs">
            <Network className="size-3" />
            <span>AI Coworkers ({employees.length})</span>
          </div>
          <div className="w-0.5 h-6 bg-zinc-200 dark:bg-zinc-800" />
        </div>

        {/* Empty State or Department Tree List */}
        {employees.length === 0 ? (
          <div
            data-testid="organization-empty-state"
            className="w-full max-w-md rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/40 p-10 text-center flex flex-col items-center justify-center gap-2"
          >
            <div className="size-10 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-400 dark:text-zinc-500 mb-1">
              <Users className="size-5" />
            </div>
            <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              No AI employees yet
            </h4>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-xs leading-relaxed">
              Custom agents and employee bots will appear here grouped by department.
            </p>
          </div>
        ) : (
          <div className="w-full space-y-8">
            {grouped.map(({ department, members }) => (
              <section
                key={department}
                data-testid={`department-group-${department.toLowerCase()}`}
                className="w-full flex flex-col gap-3"
              >
                {/* Department Header */}
                <div className="flex items-center gap-2 border-b border-zinc-100 dark:border-zinc-800 pb-2">
                  <Briefcase className="size-3.5 text-zinc-400 dark:text-zinc-500 shrink-0" />
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-300">
                    {department}
                  </h4>
                  <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                    ({members.length})
                  </span>
                </div>

                {/* Employees Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
                  {members.map((employee) => {
                    const name = getEmployeeName(employee);
                    const initial = getInitial(name);
                    const emoji = employee.emoji || employee.config?.emoji;
                    const taskCount = employee.openTaskCount ?? employee.openTasks;
                    const hasTasks = typeof taskCount === "number";

                    return (
                      <button
                        key={employee.id}
                        type="button"
                        data-testid={`employee-card-${employee.id}`}
                        onClick={() => onOpen?.(employee.id)}
                        className="group rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 shadow-sm hover:border-zinc-300 dark:hover:border-zinc-700 hover:shadow-md transition-all text-left flex flex-col justify-between gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
                      >
                        <div className="flex items-start gap-3 w-full min-w-0">
                          {/* Avatar with initial & optional emoji */}
                          <div className="relative shrink-0">
                            <div
                              aria-hidden="true"
                              className="size-10 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 font-semibold text-xs flex items-center justify-center border border-zinc-200/80 dark:border-zinc-700/80 shadow-2xs group-hover:scale-105 transition-transform"
                            >
                              {initial}
                            </div>
                            {emoji ? (
                              <span
                                role="img"
                                aria-label="bot emoji"
                                className="absolute -bottom-1 -right-1 size-5 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 flex items-center justify-center text-[10px] shadow-2xs"
                              >
                                {emoji}
                              </span>
                            ) : null}
                          </div>

                          {/* Info */}
                          <div className="min-w-0 flex-1">
                            <h5 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate group-hover:text-zinc-950 dark:group-hover:text-white transition-colors">
                              {name}
                            </h5>
                            <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
                              {employee.role}
                            </p>
                          </div>
                        </div>

                        {/* Description snippet if present */}
                        {employee.description ? (
                          <p className="text-xs text-zinc-500 dark:text-zinc-400 line-clamp-2 leading-relaxed">
                            {employee.description}
                          </p>
                        ) : null}

                        {/* Footer: Open Tasks Count & Status */}
                        <div className="flex items-center justify-between gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800/80 text-xs">
                          {hasTasks ? (
                            <span
                              data-testid={`employee-task-count-${employee.id}`}
                              className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full ${
                                taskCount > 0
                                  ? "bg-amber-50 text-amber-700 border border-amber-200/70 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/50"
                                  : "bg-zinc-100 text-zinc-500 border border-zinc-200/70 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700"
                              }`}
                            >
                              <span className="size-1.5 rounded-full bg-current opacity-80" />
                              {taskCount} {taskCount === 1 ? "task" : "tasks"}
                            </span>
                          ) : employee.status ? (
                            <span className="text-[11px] text-zinc-500 dark:text-zinc-400 inline-flex items-center gap-1 capitalize">
                              <Bot className="size-3" aria-hidden="true" />
                              {employee.status}
                            </span>
                          ) : (
                            <span />
                          )}

                          <span className="text-[11px] font-medium text-zinc-400 group-hover:text-zinc-600 dark:group-hover:text-zinc-300 transition-colors">
                            View details →
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
