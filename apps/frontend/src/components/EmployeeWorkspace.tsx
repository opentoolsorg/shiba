import { useEffect, useId, useState, type JSX, type KeyboardEvent } from "react";
import { departmentForRoleTemplate, type EmployeeAccessLevel } from "@shiba/shared";
import { employeeRole, employeeRoleLabel } from "../employee-templates";
import { teamWorkspaceHeaders } from "../team-workspaces-client";
import { AgentAvatar } from "./AgentAvatar";
import type { CustomAgentWire } from "./CustomAgentsView";

export interface EmployeeWorkspaceProps {
  employee: CustomAgentWire;
  /** Saved employees of the same scope, only used to name who this employee reports to. */
  employees?: readonly CustomAgentWire[];
  actorId?: string;
  /** Tool policy is personal-only, so a team workspace passes its id and the policy is never fetched. */
  workspaceId?: string;
  onOpenConversation?: (employeeId: string) => void;
  /** Starts the approval-gated conversation with a direct report. */
  onDelegateTask?: (employee: CustomAgentWire) => void;
  /** Opens a direct report's own workspace. */
  onOpenEmployee?: (employee: CustomAgentWire) => void;
  /** Absent in team scope: the grant surface is not reachable there. */
  onOpenToolPolicy?: (employeeId: string) => void;
  onOpenOutputs?: (employeeId: string) => void;
}

const TABS = [["conversation", "Conversation"], ["role", "Role & workflow"], ["tools", "Tools & access"], ["outputs", "Outputs"]] as const;
type TabId = (typeof TABS)[number][0];

const MUTED = "text-[var(--muted-foreground-2)]";
const ACTION = "inline-flex min-h-11 items-center justify-center rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-4 text-xs font-medium text-[var(--fg)] hover:bg-[var(--card-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]";
const PRIMARY = "inline-flex min-h-11 items-center justify-center rounded-[var(--radius-button)] border border-[var(--primary)] bg-[var(--primary)] px-4 text-xs font-medium text-[var(--primary-text)] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]";

type PolicyState = { status: "loading" } | { status: "failed" } | { status: "ready"; tools: string[] };

function useActiveTools(employeeId: string, enabled: boolean): PolicyState {
  // Keyed by employee id so a result for a previous employee is never shown under a new one.
  const [result, setResult] = useState<{ employeeId: string; state: PolicyState } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setResult(null);
    void fetch(`/api/employee-tools/${encodeURIComponent(employeeId)}/policy`, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as { toolScopes?: string[]; grants?: { capabilityId: string; resourceId: string; lifecycle: string }[] };
        if (controller.signal.aborted) return;
        if (response.ok && Array.isArray(body.toolScopes) && Array.isArray(body.grants)) {
          setResult({ employeeId, state: { status: "ready", tools: body.grants.filter((grant) => grant.lifecycle === "active" && body.toolScopes?.includes(grant.capabilityId)).map((grant) => `${grant.capabilityId.replace(/^mcp:shiba:/, "")} · ${grant.resourceId}`) } });
        } else setResult({ employeeId, state: { status: "failed" } });
      }).catch(() => { if (!controller.signal.aborted) setResult({ employeeId, state: { status: "failed" } }); });
    return () => controller.abort();
  }, [employeeId, enabled]);
  return result?.employeeId === employeeId ? result.state : { status: "loading" };
}

export function EmployeeWorkspace({ employee, employees = [], actorId, workspaceId, onOpenConversation, onOpenEmployee, onDelegateTask, onOpenToolPolicy, onOpenOutputs }: EmployeeWorkspaceProps): JSX.Element {
  const [tab, setTab] = useState<TabId>("conversation");
  const baseId = useId();
  const { config } = employee;
  const role = employeeRole(employee.slug, config.roleTemplateId);
  const department = config.department ?? departmentForRoleTemplate(config.roleTemplateId);
  const policy = useActiveTools(employee.id, !workspaceId && tab === "tools");
  // Team conversations need chat or manage access; hidden while loading or on failure.
  const [teamLevel, setTeamLevel] = useState<{ employeeId: string; level: EmployeeAccessLevel | null } | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void fetch(`/api/governance/employees/${encodeURIComponent(employee.id)}/access`, { headers: teamWorkspaceHeaders(workspaceId) })
      .then(async (response) => response.ok ? ((await response.json()) as { level?: EmployeeAccessLevel }).level ?? null : null)
      .catch(() => null)
      .then((level) => { if (!cancelled) setTeamLevel({ employeeId: employee.id, level }); });
    return () => { cancelled = true; };
  }, [workspaceId, employee.id]);
  const canConverse = !workspaceId || (teamLevel?.employeeId === employee.id && (teamLevel.level === "chat" || teamLevel.level === "manage"));
  const reports = employees.filter((item) => item.config.reportsTo?.kind === "agent" && item.config.reportsTo.agentId === employee.id);
  // Delegating is a conversation with the report, so team scope needs the same chat or manage access.
  const reportIds = reports.map((item) => item.id).join("|");
  const [reportLevels, setReportLevels] = useState<Record<string, EmployeeAccessLevel | null>>({});
  useEffect(() => {
    if (!workspaceId || !reportIds) return;
    let cancelled = false;
    void Promise.all(reportIds.split("|").map(async (id) => {
      const level = await fetch(`/api/governance/employees/${encodeURIComponent(id)}/access`, { headers: teamWorkspaceHeaders(workspaceId) })
        .then(async (response) => response.ok ? ((await response.json()) as { level?: EmployeeAccessLevel }).level ?? null : null)
        .catch(() => null);
      return [id, level] as const;
    })).then((levels) => { if (!cancelled) setReportLevels(Object.fromEntries(levels)); });
    return () => { cancelled = true; };
  }, [workspaceId, reportIds]);
  const canDelegateTo = (id: string) => !workspaceId || reportLevels[id] === "chat" || reportLevels[id] === "manage";
  const manager = config.reportsTo?.kind === "agent" ? employees.find((item) => item.id === (config.reportsTo as { agentId: string }).agentId)?.config.name
    : config.reportsTo?.kind === "user" ? (config.reportsTo.userId === actorId ? "You" : config.reportsTo.userId) : undefined;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = TABS[(TABS.findIndex(([id]) => id === tab) + step + TABS.length) % TABS.length]![0];
    setTab(next);
    document.getElementById(`${baseId}-tab-${next}`)?.focus();
  };

  return <section aria-label={`${config.name} workspace`} className="flex flex-col gap-5 p-4 lg:p-8">
    <header className="flex items-center gap-4">
      <AgentAvatar id={employee.slug} name={config.name} mascotPreset={config.mascotPreset} look={config.look} avatar={config.avatar} role={role} size={56} decorative />
      <div className="min-w-0">
        <h2 className="break-words font-[family-name:var(--font-display)] text-xl font-semibold tracking-tight text-[var(--fg)]">{config.name}</h2>
        <p className={`text-xs ${MUTED}`}>{[config.title, employeeRoleLabel(role)].filter(Boolean).join(" · ")}</p>
        {department && department.toLowerCase() !== employeeRoleLabel(role).toLowerCase() ? <p className={`text-xs capitalize ${MUTED}`}>{department} department</p> : null}
      </div>
    </header>
    <div role="tablist" aria-label={`${config.name} workspace sections`} onKeyDown={onKeyDown} className="-mx-1 flex gap-1 overflow-x-auto border-b border-[var(--border-1)] px-1">
      {TABS.map(([id, label]) => <button key={id} type="button" role="tab" id={`${baseId}-tab-${id}`} aria-selected={tab === id} aria-controls={`${baseId}-panel`} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}
        className={`min-h-11 shrink-0 border-b-2 px-3 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)] ${tab === id ? "border-[var(--primary)] text-[var(--fg)]" : `border-transparent ${MUTED}`}`}>{label}</button>)}
    </div>
    <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${tab}`} className="flex flex-col gap-3 text-sm">
      {tab === "conversation" ? <>
        <p className={MUTED}>Each task starts in a dedicated thread and needs your approval of the exact task before anything runs.</p>
        {onOpenConversation && canConverse ? <div><button type="button" className={PRIMARY} onClick={() => onOpenConversation(employee.id)}>Open conversation</button></div> : <p className={`text-xs ${MUTED}`}>Conversations are not available from here.</p>}
      </> : null}
      {tab === "role" ? <>
      <dl className="grid gap-3 text-xs sm:grid-cols-2">
        <div className="sm:col-span-2"><dt className={MUTED}>Instructions</dt><dd className="mt-1 whitespace-pre-wrap break-words text-sm text-[var(--fg)]">{config.instructions}</dd></div>
        <div className="sm:col-span-2"><dt className={MUTED}>Expected deliverables</dt><dd className="break-all font-mono">{config.expectedDeliverables?.length ? config.expectedDeliverables.join(", ") : "None required"}</dd></div>
        <div><dt className={MUTED}>Model</dt><dd className="break-words font-mono">{config.codingModel || "Workspace default"}</dd></div>
        <div><dt className={MUTED}>Reports to</dt><dd>{manager ?? "Not set"}</dd></div>
      </dl>
      {reports.length ? <section aria-labelledby={`${baseId}-team`} className="flex flex-col gap-2">
        <h3 id={`${baseId}-team`} className={`text-[11px] font-semibold uppercase tracking-wider ${MUTED}`}>Team ({reports.length})</h3>
        <p className={`text-xs ${MUTED}`}>Delegating opens a conversation with that employee. The task still needs your approval before anything runs.</p>
        <ul aria-label="Direct reports" className="flex flex-col gap-2">
          {reports.map((report) => <li key={report.id} className="flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-[var(--border-1)] bg-[var(--card)] p-3">
            <AgentAvatar id={report.slug} name={report.config.name} mascotPreset={report.config.mascotPreset} look={report.config.look} avatar={report.config.avatar} role={employeeRole(report.slug, report.config.roleTemplateId)} size={32} decorative />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-[var(--fg)]">{report.config.name}</span><span className={`block truncate text-xs ${MUTED}`}>{report.config.title || employeeRoleLabel(employeeRole(report.slug, report.config.roleTemplateId))}</span></span>
            {onOpenEmployee ? <button type="button" className={ACTION} aria-label={`Open ${report.config.name}`} onClick={() => onOpenEmployee(report)}>Open</button> : null}
            {onDelegateTask && canDelegateTo(report.id) ? <button type="button" className={ACTION} aria-label={`Delegate task to ${report.config.name}`} onClick={() => onDelegateTask(report)}>Delegate task</button> : null}
          </li>)}
        </ul>
      </section> : null}
      </> : null}
      {tab === "tools" ? <>
        <p className={`text-xs ${MUTED}`}>Hiring or connecting an employee never grants tool access.</p>
        {workspaceId ? <p className={`text-xs ${MUTED}`}>Tool grants are managed in a personal workspace.</p>
          : policy.status === "loading" ? <p className={`text-xs ${MUTED}`}>Loading tool policy…</p>
          : policy.status === "failed" ? <p className={`text-xs ${MUTED}`}>Tool policy is unavailable; no tool access is implied.</p>
          : policy.tools.length ? <ul aria-label="Active tools" className="flex flex-col gap-1 font-mono text-xs">{policy.tools.map((tool) => <li key={tool} className="break-all">{tool}</li>)}</ul>
          : <p className={`text-xs ${MUTED}`}>No active tool grants are configured.</p>}
        {onOpenToolPolicy && !workspaceId ? <div><button type="button" className={ACTION} onClick={() => onOpenToolPolicy(employee.id)}>Manage in Tool policy</button></div>
          : !workspaceId ? <p className={`text-xs ${MUTED}`}>Tool grants are managed in a personal workspace.</p> : null}
      </> : null}
      {tab === "outputs" ? <>
        <p className={`text-xs ${MUTED}`}>Outputs and handoffs are listed in the Outputs page.</p>
        {onOpenOutputs ? <div><button type="button" className={ACTION} onClick={() => onOpenOutputs(employee.id)}>Open outputs</button></div> : null}
      </> : null}
    </div>
  </section>;
}
