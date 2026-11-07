import { useState } from "react";
import type { AgentMascotLook, CustomAgentMascotPreset } from "@shiba/shared";
import { mascotExpression, resolveAgentLook, type AgentAvatarStatus } from "../agent-mascots";
import { employeeRole, type EmployeeRole } from "../employee-templates";
import { AgentMascot } from "./AgentMascot";

export type { AgentAvatarStatus };

const statusColor: Record<AgentAvatarStatus, string> = {
  idle: "bg-slate-400",
  working: "bg-emerald-500",
  waiting: "bg-amber-500",
  "needs-approval": "bg-amber-500",
  failed: "bg-red-500",
  asleep: "bg-slate-400",
};

const initialsClass = "inline-flex size-full items-center justify-center rounded-full bg-slate-200 font-semibold text-slate-700 dark:bg-slate-700 dark:text-slate-100";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "")).toUpperCase();
}

export function AgentAvatar({ id, name, size = 40, status, role, mascotPreset, look, live = true, imageSrc, decorative = false, className = "" }: {
  id: string;
  name: string;
  size?: number;
  status?: AgentAvatarStatus;
  role?: EmployeeRole;
  mascotPreset?: CustomAgentMascotPreset;
  look?: AgentMascotLook;
  /** Blink and a small gaze when motion is allowed. */
  live?: boolean;
  /** Optional uploaded portrait. A failed image falls back to initials. */
  imageSrc?: string;
  decorative?: boolean;
  className?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const known = role ?? employeeRole(id);
  const resolved = resolveAgentLook({
    id,
    role: known === "custom" ? undefined : known,
    fallbackId: id,
    preset: mascotPreset,
    look,
  });
  const expression = mascotExpression(status, resolved.eyes);
  const showImage = Boolean(imageSrc) && failedSrc !== imageSrc;
  return (
    <span className={`agent-avatar relative inline-flex shrink-0 ${className}`} style={{ width: size, height: size }} data-status={status} data-employee-role={known}>
      {showImage ? (
        <img src={imageSrc} alt={decorative ? "" : name} aria-hidden={decorative || undefined} onError={() => setFailedSrc(imageSrc ?? null)} className="size-full rounded-full object-cover" />
      ) : imageSrc ? (
        decorative ? <span aria-hidden="true" className={initialsClass} style={{ fontSize: Math.max(10, size * 0.38) }}>{initials(name)}</span>
        : <span role="img" aria-label={name} className={initialsClass} style={{ fontSize: Math.max(10, size * 0.38) }}>{initials(name)}</span>
      ) : (
        <AgentMascot look={resolved} expression={expression} live={live} label={decorative ? undefined : name} />
      )}
      {status ? <span role="img" aria-label={status} className={`absolute bottom-0 right-0 size-2.5 rounded-full ring-2 ring-white dark:ring-slate-900 ${statusColor[status]} ${status === "working" ? "motion-safe:animate-pulse" : ""}`} /> : null}
    </span>
  );
}
