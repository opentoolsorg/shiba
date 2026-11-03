import type { ReactNode } from "react";
import { employeeRole, employeeRoleLabel, type EmployeeRole } from "../employee-templates";

const accessories: Record<EmployeeRole, ReactNode> = {
  engineering: <><path d="M13 23h34M17 22a13 13 0 0 1 26 0M28 10v10M34 10v10" /><path d="m42 48 8-8a5 5 0 0 0 6-6l-4 3-3-3 3-4a5 5 0 0 0-6 6l-8 8" /></>,
  marketing: <><path d="m39 39 15-6v18l-15-6zM39 39h-5v6h5M42 46l2 8h5l-3-7M58 37l3-2M58 47l3 2" /></>,
  sales: <><path d="m27 44 5 4 5-4-3 13h-4z" /><rect x="43" y="40" width="14" height="11" rx="2" /><path d="M46 44h8M46 47h4" /></>,
  product: <><rect x="38" y="34" width="20" height="21" rx="3" /><path d="M43 39h10v5H43v6h10" /><circle cx="43" cy="39" r="1" /><circle cx="53" cy="50" r="1" /></>,
  design: <><path d="m35 50 13-18 4 3-13 18-5 2zM46 35l4 3" /><path d="M48 44h10v12H48zM48 48h10M53 48v8" /></>,
  research: <><circle cx="47" cy="39" r="9" /><path d="m53 46 7 9M43 39a4 4 0 0 1 4-4" /></>,
  operations: <><path d="M12 32v-5a20 20 0 0 1 40 0v8M12 30h5v9h-5zM47 30h5v9h-5zM50 39v4h-9" /><rect x="36" y="43" width="19" height="15" rx="2" /><path d="m40 49 2 2 4-4M48 49h3M40 55h11" /></>,
  custom: <><path d="m25 43 7 7 7-7" /><rect x="22" y="48" width="20" height="10" rx="2" /><path d="M27 53h10" /></>,
};

export function RoleShiba({ role, slug, label, decorative = false, className = "size-9" }: {
  role?: EmployeeRole; slug?: string; label?: string; decorative?: boolean; className?: string;
}) {
  const resolved = role ?? employeeRole(slug);
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role={decorative ? undefined : "img"} aria-hidden={decorative || undefined} aria-label={decorative ? undefined : label ?? `${employeeRoleLabel(resolved)} Shiba`} focusable="false" data-employee-role={resolved} className={`shrink-0 ${className}`}>
    <circle cx="32" cy="32" r="31" fill="var(--secondary)" />
    <g stroke="var(--fg)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 29 12 12l15 8M37 20l15-8-3 17" fill="var(--warning)" />
      <path d="m16 23-1-6 6 5M43 22l6-5-1 7" fill="var(--card)" />
      <path d="M13 31c0-12 9-17 19-17s19 5 19 17c0 14-8 21-19 21S13 45 13 31Z" fill="var(--warning)" />
      <path d="M14 34c5 0 9 3 12 6 2-4 10-4 12 0 3-3 7-6 12-6-1 11-8 18-18 18S15 45 14 34Z" fill="var(--card)" stroke="none" />
      <path d="m21 29 4-1M39 28l4 1" />
      <circle cx="24" cy="33" r="1.5" fill="var(--fg)" stroke="none" /><circle cx="40" cy="33" r="1.5" fill="var(--fg)" stroke="none" />
      <path d="m29 39 3 2 3-2z" fill="var(--fg)" /><path d="M32 41v3m-4-1c1 3 7 3 8 0" fill="none" />
    </g>
    <g fill="var(--card)" stroke="var(--fg)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{accessories[resolved]}</g>
  </svg>;
}
