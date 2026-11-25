import { Lock, Pin, Users } from "lucide-react";
import type { AgentMascotLook, CustomAgentMascotPreset, CustomAgentRoleTemplateId } from "@shiba/shared";
import type { JSX } from "react";
import { employeeRole, employeeRoleLabel } from "../employee-templates";
import { avatarStatusFromTask } from "../agent-mascots";
import { AgentAvatar } from "./AgentAvatar";
import { SHIBA_BRAND_LOOK } from "./ShibaMark";

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
    mascotPreset?: CustomAgentMascotPreset;
    look?: AgentMascotLook;
    roleTemplateId?: CustomAgentRoleTemplateId;
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
  /** Client-side navigation to the approvals queue; the link is hidden where that queue is unavailable (team scope). */
  onOpenApprovals?: () => void;
  onOpenChief?: () => void;
  onHireEmployee?: () => void;
  onOpenOutputs?: () => void;
  user?: OrganizationUser;
  /** Name of the workspace chief of staff; defaults to "Shiba". */
  chiefName?: string;
  className?: string;
}

function getEmployeeName(emp: OrganizationEmployee): string {
  return emp.name || emp.config?.name || emp.slug || emp.id;
}

const CARD =
  "rounded-[var(--radius-card)] border border-[var(--border-1)] bg-[var(--card)] shadow-[var(--sh-card)]";
const MUTED = "text-[var(--muted-foreground-2)]";

/** Vertical stem joining a parent card to the rail below it. */
function Stem(): JSX.Element {
  return <div aria-hidden="true" className="mx-auto h-6 w-px bg-[var(--border-3)]" />;
}

/**
 * A child slot on the rail draws its own half rails and drop, so connectors follow the cards;
 * below `sm` the row stacks and only the vertical drops remain, forming a single spine.
 */
function RailSlot({ children }: { children: JSX.Element }): JSX.Element {
  return (
    <li
      className={
        "relative flex flex-col items-center px-2 pt-6 " +
        "before:absolute before:left-1/2 before:top-0 before:h-6 before:w-px before:bg-[var(--border-3)] before:content-[''] " +
        "after:absolute after:inset-x-0 after:top-0 after:hidden after:h-px after:bg-[var(--border-3)] after:content-[''] sm:after:block " +
        "first:after:left-1/2 last:after:right-1/2 only:after:!hidden"
      }
    >
      {children}
    </li>
  );
}

/**
 * Org chart: workspace chief of staff on top, member chiefs of staff connected below,
 * then the remaining workspace agents. Lines are decorative, never access rules.
 */
export function WorkOrganizationView({
  employees,
  onOpen,
  onOpenApprovals,
  onOpenChief,
  onHireEmployee,
  onOpenOutputs,
  user,
  chiefName = "Shiba",
  className = "",
}: WorkOrganizationViewProps): JSX.Element {
  const userName = user?.name?.trim();
  const workspaceLabel = userName ? `${userName}’s workspace` : "Your workspace";
  const memberLabel = userName ? `${userName}’s Shiba` : "Your Shiba";
  // Map.groupBy is not in this project's TS lib target, so group by hand (insertion order kept).
  const roleGroups = new Map<string, OrganizationEmployee[]>();
  for (const employee of employees) {
    const label = employeeRoleLabel(employeeRole(employee.slug, employee.config?.roleTemplateId));
    roleGroups.set(label, [...(roleGroups.get(label) ?? []), employee]);
  }
  const approvalsLinkClass = "mt-3 inline-flex min-h-11 items-center text-sm text-[var(--primary)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]";

  return (
    <div
      data-testid="work-organization-view"
      className={`flex h-full w-full flex-col items-center overflow-y-auto px-4 py-10 sm:px-8 ${className}`.trim()}
    >
      <div className="flex w-full max-w-4xl flex-col items-center">
        <header className="mb-8 text-center">
          <h2 className="break-words font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight text-[var(--fg)] sm:text-3xl">
            {workspaceLabel}
          </h2>
          <p className={`mt-1.5 text-sm ${MUTED}`}>Workspace agents and member chiefs of staff.</p>
          <div className="flex flex-wrap justify-center gap-x-3">
            {onOpenApprovals ? <button type="button" onClick={onOpenApprovals} className={approvalsLinkClass}>Review human decisions</button> : null}
            {onOpenOutputs ? <button type="button" onClick={onOpenOutputs} className={approvalsLinkClass}>Outputs &amp; handoffs</button> : null}
          </div>
        </header>

        <div
          data-testid="organization-chief-card"
          className={`${CARD} flex w-full max-w-xs items-center gap-3 p-4`}
        >
          <AgentAvatar id="workspace-chief" name={chiefName} look={SHIBA_BRAND_LOOK} size={44} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h3 className="truncate text-sm font-semibold text-[var(--fg)]">{chiefName}</h3>
              <Pin className={`size-3 shrink-0 ${MUTED}`} role="img" aria-label="Pinned" />
            </div>
            <p className={`truncate text-xs ${MUTED}`}>{workspaceLabel}</p>
            <p className={`truncate text-xs ${MUTED}`}>Workspace chief of staff</p>
            {onOpenChief ? <button type="button" onClick={onOpenChief} className="mt-1 inline-flex min-h-11 items-center text-xs text-[var(--primary)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]">Open conversation</button> : null}
          </div>
        </div>

        <Stem />
        <ul
          aria-label="Member chiefs of staff"
          className="flex flex-col items-center sm:flex-row sm:flex-wrap sm:justify-center"
        >
          <RailSlot>
            <div
              data-testid="organization-user-card"
              className={`${CARD} flex w-64 max-w-full flex-col gap-3 p-4`}
            >
              <div className="flex items-center gap-3">
                <AgentAvatar
                  id={`member-${user?.id ?? userName ?? "you"}`}
                  name={memberLabel}
                  look={SHIBA_BRAND_LOOK}
                  size={44}
                />
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-semibold text-[var(--fg)]">{memberLabel}</h3>
                  <p className={`truncate text-xs ${MUTED}`}>
                    {userName ? `${userName} - You` : "You"}
                  </p>
                  <p className={`truncate text-xs ${MUTED}`}>Personal chief of staff</p>
                </div>
              </div>
              <p
                className={`flex items-center gap-1.5 border-t border-[var(--border-1)] pt-2.5 text-[11px] ${MUTED}`}
              >
                <Lock className="size-3 shrink-0" aria-hidden="true" />
                Personal agents are private
              </p>
            </div>
          </RailSlot>
        </ul>

        <section
          aria-labelledby="organization-agents-heading"
          className="mt-10 flex w-full flex-col items-center"
        >
          <div className="mb-3 flex flex-wrap items-center justify-center gap-3">
            <h4
              id="organization-agents-heading"
              className={`text-[11px] font-semibold uppercase tracking-wider ${MUTED}`}
            >
              Workspace agents{employees.length > 0 ? ` (${employees.length})` : ""}
            </h4>
            {onHireEmployee && employees.length > 0 ? <button type="button" onClick={onHireEmployee} className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] border border-[var(--border-2)] px-3 text-xs font-medium text-[var(--fg)] hover:bg-[var(--card-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]">Hire employee</button> : null}
          </div>
          {employees.length === 0 ? (
            <div
              data-testid="organization-empty-state"
              className="flex w-full max-w-md flex-col items-center gap-2 rounded-[var(--radius-card)] border border-dashed border-[var(--border-2)] p-8 text-center"
            >
              <Users className={`size-5 ${MUTED}`} aria-hidden="true" />
              <p className="text-sm font-semibold text-[var(--fg)]">No workspace agents yet</p>
              <p className={`max-w-xs text-xs leading-relaxed ${MUTED}`}>
                Agents you add to this workspace are listed here.
              </p>
              {onHireEmployee ? <button type="button" onClick={onHireEmployee} className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] border border-[var(--border-2)] px-3 text-xs font-medium text-[var(--fg)] hover:bg-[var(--card-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]">Hire employee</button> : null}
            </div>
          ) : (
            <ul
              aria-label="Workspace agents"
              className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
            >
              {[...roleGroups].map(([roleLabel, agents]) => (
                <li key={roleLabel} className="col-span-full">
                  <h5 className={`mb-2 text-[11px] font-semibold uppercase tracking-wider ${MUTED}`}>{roleLabel} ({agents.length})</h5>
                  <ul aria-label={`${roleLabel} agents`} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {agents.map((employee) => {
                      const name = getEmployeeName(employee);
                      const taskCount = employee.openTaskCount ?? employee.openTasks;
                      const meta = typeof taskCount === "number" ? `${taskCount} ${taskCount === 1 ? "task" : "tasks"}` : employee.status;
                      return (
                        <li key={employee.id} className="min-w-0">
                          <button type="button" data-testid={`employee-card-${employee.id}`} onClick={() => onOpen?.(employee.id)} className={`${CARD} flex min-h-11 w-full items-center gap-3 p-3 text-left hover:bg-[var(--card-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] motion-safe:transition-colors`}>
                            <AgentAvatar id={employee.slug ?? employee.id} name={name} mascotPreset={employee.config?.mascotPreset} look={employee.config?.look} role={employeeRole(employee.slug, employee.config?.roleTemplateId)} status={avatarStatusFromTask(employee.status)} size={36} decorative />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-semibold text-[var(--fg)]">{name}</span>
                              <span className={`block truncate text-xs ${MUTED}`}>{employee.role}</span>
                              {meta ? <span data-testid={`employee-task-count-${employee.id}`} className="block text-[11px] capitalize text-[var(--muted-foreground-3)]">{meta}</span> : null}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className={`mt-10 max-w-md text-center text-xs leading-relaxed ${MUTED}`}>
          Lines show grouping and ownership, not access permissions. Personal agents and private threads are
          not exposed here.
        </p>
      </div>
    </div>
  );
}
