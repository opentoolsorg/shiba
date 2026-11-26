import { Lock } from "lucide-react";
import type { JSX } from "react";
import { employeeRole, employeeRoleLabel } from "../employee-templates";
import type { OrganizationEmployee, OrganizationUser } from "./WorkOrganizationView";
import { AgentAvatar } from "./AgentAvatar";
import { SHIBA_BRAND_LOOK } from "./ShibaMark";
import { ChiefRenameForm } from "./ChiefRenameForm";

export interface ChiefOfStaffViewProps {
  employees?: readonly OrganizationEmployee[];
  user?: OrganizationUser;
  /** Name of the workspace chief of staff; defaults to "Shiba". */
  chiefName?: string;
  /** Persists a new chief name; omit to hide rename. Throws a readable Error on failure. */
  onRenameChief?: (name: string) => Promise<void>;
  onOpenChief?: () => void;
  /** Hidden where the approvals queue is unavailable (team scope). */
  onOpenApprovals?: () => void;
  onOpenOutputs?: () => void;
  onOpenEmployee?: (id: string) => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

const MUTED = "text-[var(--muted-foreground-2)]";
const CARD = "rounded-[var(--radius-card)] border border-[var(--border-1)] bg-[var(--card)] shadow-[var(--sh-card)]";
const PRIMARY = "inline-flex min-h-11 items-center justify-center rounded-[var(--radius-button)] border border-[var(--primary)] bg-[var(--primary)] px-4 text-xs font-medium text-[var(--primary-text)] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]";
const ACTION = "inline-flex min-h-11 items-center justify-center rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-4 text-xs font-medium text-[var(--fg)] hover:bg-[var(--card-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]";

export function ChiefOfStaffView({ employees = [], user, chiefName = "Shiba", onRenameChief, onOpenChief, onOpenApprovals, onOpenOutputs, onOpenEmployee, loading = false, error = null, onRetry }: ChiefOfStaffViewProps): JSX.Element {
  const userName = user?.name?.trim();
  const memberLabel = userName ? `${userName}’s Shiba` : "Your Shiba";
  return <section aria-label="Chief of staff" className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 sm:px-8">
    <header className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <AgentAvatar id="workspace-chief" name={chiefName} look={SHIBA_BRAND_LOOK} size={64} />
      <div className="min-w-0 flex-1">
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight text-[var(--fg)]">{chiefName}</h1>
        <p className={`text-sm ${MUTED}`}>Workspace chief of staff. Hands work to your employees; humans decide what runs.</p>
        {onRenameChief ? <ChiefRenameForm key={chiefName} name={chiefName} onSave={onRenameChief} /> : null}
      </div>
    </header>
    {onOpenChief || onOpenApprovals || onOpenOutputs ? <div className="flex flex-wrap gap-2">
      {onOpenChief ? <button type="button" className={PRIMARY} onClick={onOpenChief}>Open conversation</button> : null}
      {onOpenApprovals ? <button type="button" className={ACTION} onClick={onOpenApprovals}>Review human decisions</button> : null}
      {onOpenOutputs ? <button type="button" className={ACTION} onClick={onOpenOutputs}>Outputs &amp; handoffs</button> : null}
    </div> : null}
    <section aria-labelledby="chief-members-heading" className="flex flex-col gap-2">
      <h2 id="chief-members-heading" className={`text-[11px] font-semibold uppercase tracking-wider ${MUTED}`}>Member chiefs of staff</h2>
      <div data-testid="chief-member-card" className={`${CARD} flex items-center gap-3 p-4`}>
        <AgentAvatar id={`member-${user?.id ?? userName ?? "you"}`} name={memberLabel} look={SHIBA_BRAND_LOOK} size={44} decorative />
        <div className="min-w-0"><p className="truncate text-sm font-semibold text-[var(--fg)]">{memberLabel}</p><p className={`flex items-center gap-1.5 text-xs ${MUTED}`}><Lock className="size-3 shrink-0" aria-hidden="true" />Personal agents are private</p></div>
      </div>
    </section>
    <section aria-labelledby="chief-employees-heading" className="flex flex-col gap-2">
      <h2 id="chief-employees-heading" className={`text-[11px] font-semibold uppercase tracking-wider ${MUTED}`}>Workspace employees{employees.length ? ` (${employees.length})` : ""}</h2>
      {loading ? <p role="status" className={`text-xs ${MUTED}`}>Loading employees…</p>
        : error ? <div role="alert" className="flex flex-wrap items-center gap-3 text-xs text-[var(--fg)]"><p>{error}</p>{onRetry ? <button type="button" className={ACTION} onClick={onRetry}>Retry</button> : null}</div>
        : employees.length === 0 ? <p className={`text-xs ${MUTED}`}>No workspace employees yet.</p> : <ul aria-label="Workspace employees" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {employees.map((employee) => {
          const name = employee.name || employee.config?.name || employee.slug || employee.id;
          const role = employeeRole(employee.slug, employee.config?.roleTemplateId);
          const body = <>
            <AgentAvatar id={employee.slug ?? employee.id} name={name} mascotPreset={employee.config?.mascotPreset} look={employee.config?.look} role={role} size={36} decorative />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-[var(--fg)]">{name}</span><span className={`block truncate text-xs ${MUTED}`}>{employee.role || employeeRoleLabel(role)}</span></span>
          </>;
          return <li key={employee.id} className="min-w-0">{onOpenEmployee
            ? <button type="button" onClick={() => onOpenEmployee(employee.id)} className={`${CARD} flex min-h-11 w-full items-center gap-3 p-3 text-left hover:bg-[var(--card-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]`}>{body}</button>
            : <div className={`${CARD} flex min-h-11 items-center gap-3 p-3`}>{body}</div>}</li>;
        })}
      </ul>}
    </section>
  </section>;
}
