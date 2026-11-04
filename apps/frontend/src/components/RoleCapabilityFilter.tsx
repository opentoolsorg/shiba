import { EMPLOYEE_TEMPLATES } from "../employee-templates";
import type { CapabilityRoleFilter } from "../role-capability-recommendations";

export function RoleCapabilityFilter({ value, onChange, label = "Recommendations for role" }: {
  value: CapabilityRoleFilter;
  onChange: (role: CapabilityRoleFilter) => void;
  label?: string;
}) {
  return <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--muted-foreground-2)]">
    {label}
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value as CapabilityRoleFilter)} className="min-h-11 border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-xs text-[var(--fg)]">
      <option value="all">All roles</option>
      {EMPLOYEE_TEMPLATES.map((role) => <option key={role.id} value={role.id}>{role.label}</option>)}
    </select>
  </label>;
}
