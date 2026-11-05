import { useState } from "react";
import { agentMascot } from "../agent-mascots";
import { employeeRole, type EmployeeRole } from "../employee-templates";

export type AgentAvatarStatus = "idle" | "working" | "waiting";

const statusColor: Record<AgentAvatarStatus, string> = { idle: "bg-slate-400", working: "bg-emerald-500", waiting: "bg-amber-500" };

const initialsClass = "inline-flex size-full items-center justify-center rounded-full bg-slate-200 font-semibold text-slate-700 dark:bg-slate-700 dark:text-slate-100";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "")).toUpperCase();
}

export function AgentAvatar({ id, name, size = 40, status, role, decorative = false, className = "" }: {
  id: string; name: string; size?: number; status?: AgentAvatarStatus; role?: EmployeeRole; decorative?: boolean; className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const known = role ?? employeeRole(id);
  const src = agentMascot(id, known === "custom" ? undefined : known);
  return (
    <span className={`agent-avatar relative inline-flex shrink-0 ${className}`} style={{ width: size, height: size }} data-status={status} data-employee-role={known}>
      {failed ? (
        decorative ? <span aria-hidden="true" className={initialsClass} style={{ fontSize: Math.max(10, size * 0.38) }}>{initials(name)}</span>
        : <span role="img" aria-label={name} className={initialsClass} style={{ fontSize: Math.max(10, size * 0.38) }}>{initials(name)}</span>
      ) : (
        <img src={src} alt={decorative ? "" : name} aria-hidden={decorative || undefined} onError={() => setFailed(true)} className="size-full rounded-full object-cover" />
      )}
      {status ? <span role="img" aria-label={status} className={`absolute bottom-0 right-0 size-2.5 rounded-full ring-2 ring-white dark:ring-slate-900 ${statusColor[status]} ${status === "working" ? "motion-safe:animate-pulse" : ""}`} /> : null}
    </span>
  );
}
