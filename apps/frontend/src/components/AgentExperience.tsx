import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ChevronRight, MessageSquare, PanelLeft, PanelRight, Plus, Users, X } from "lucide-react";
import type { CustomAgentWire } from "./CustomAgentsView";
import type { WebThread } from "../agent-threads";
import { threadAgentId } from "../agent-threads";
import { EMPLOYEE_TEMPLATES, employeeRole, employeeRoleLabel, type EmployeeTemplate, type EmployeeRole } from "../employee-templates";
import { RoleShiba } from "./RoleShiba";
import { ShibaMark } from "./ShibaMark";
import { ViewHeader, viewButtonClass } from "./ui/ViewChrome";
import { teamWorkspaceHeaders } from "../team-workspaces-client";

const quietButton = "inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-2 text-[var(--muted-foreground-2)] hover:bg-[var(--secondary)] hover:text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]";
export const ONBOARDING_DISMISSED_KEY = "shiba.employee-onboarding.dismissed";

export function employeeExamples(agent?: CustomAgentWire): readonly string[] {
  const role = employeeRole(agent?.slug, agent?.config.roleTemplateId);
  switch (role) {
    case "engineering": return ["Fix a small bug and add a regression test", "Review this repository and suggest three focused improvements"];
    case "marketing": return ["Draft a launch brief from the product documentation", "Write three landing page headlines for review"];
    case "sales": return ["Draft an account brief from my supplied notes", "Write a follow-up email draft for review"];
    case "product": return ["Turn this feedback into a scoped product brief", "Write acceptance criteria for the next release"];
    case "design": return ["Review this flow for accessibility gaps", "Draft empty and error states for this interface"];
    case "research": return ["Research my top three competitors and write a one-page brief", "Summarize the evidence in my supplied research"];
    case "operations": return ["Write a release runbook with rollback steps", "Review our setup instructions for missing checks"];
    case "gtm": return ["Draft a go-to-market plan from our supplied research", "Propose launch experiments and approval checkpoints"];
    case "hr": return ["Draft a new-hire onboarding checklist from our policies", "Prepare a job description draft for human review"];
    case "finance": return ["Analyze this supplied budget and document assumptions", "Reconcile these figures and flag missing evidence"];
    default: return [];
  }
}

export function AgentAvatar({ name, slug, role, large = false }: { name: string; slug?: string; role?: EmployeeRole; large?: boolean }) {
  if (slug === undefined) return <span aria-hidden="true" className="shrink-0"><ShibaMark className={large ? "size-20" : "size-8"} /></span>;
  return <RoleShiba slug={slug} role={role} label={name} decorative className={large ? "size-20" : "size-8"} />;
}

export function AgentSidebar({ agents, threads, selectedId, onOpenThread, onNewThread, onManage }: {
  agents: CustomAgentWire[]; threads: WebThread[]; selectedId?: string | null;
  onOpenThread: (id: string) => void; onNewThread: (agent?: CustomAgentWire) => void; onManage: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ shiba: true });
  const id = useId();
  const rows = [{ id: "shiba", name: "Shiba", agent: undefined as CustomAgentWire | undefined }, ...agents.map((agent) => ({ id: agent.id, name: agent.config.name, agent }))];
  return <section aria-label="Agents" className="min-h-0 overflow-y-auto border-t border-[var(--border-1)] py-2">
    <div className="flex items-center justify-between">
      <button type="button" className={`${quietButton} gap-2 text-xs`} aria-expanded={open} aria-controls={`${id}-agents`} onClick={() => setOpen(!open)}><ChevronDown aria-hidden="true" className={`size-3.5 ${open ? "" : "-rotate-90"}`} />Agents</button>
      <button type="button" className={quietButton} aria-label="Add agent" onClick={onManage}><Plus aria-hidden="true" className="size-4" /></button>
    </div>
    <div id={`${id}-agents`} hidden={!open}>{rows.map((row) => {
      const isExpanded = expanded[row.id] ?? false;
      const children = threads.filter((thread) => row.agent ? threadAgentId(thread) === row.id : !threadAgentId(thread) || !agents.some((agent) => agent.id === threadAgentId(thread)));
      return <div key={row.id}>
        <div className="flex items-center">
          <button type="button" className={`${quietButton} min-w-0 flex-1 justify-start gap-2 text-left text-[13px]`} onClick={() => { const latest = [...children].sort((a, b) => b.updatedAt - a.updatedAt)[0]; if (latest) onOpenThread(latest.id); else onNewThread(row.agent); }}><AgentAvatar name={row.name} slug={row.agent?.slug} role={employeeRole(row.agent?.slug, row.agent?.config.roleTemplateId)} /><span className="truncate">{row.name}</span></button>
          <button type="button" className={quietButton} aria-label={`New thread with ${row.name}`} onClick={() => onNewThread(row.agent)}><Plus aria-hidden="true" className="size-4" /></button>
          <button type="button" className={quietButton} aria-label={`${isExpanded ? "Collapse" : "Expand"} ${row.name} threads`} aria-expanded={isExpanded} aria-controls={`${id}-${row.id}`} onClick={() => setExpanded((current) => ({ ...current, [row.id]: !isExpanded }))}>{isExpanded ? <ChevronDown aria-hidden="true" className="size-3.5" /> : <ChevronRight aria-hidden="true" className="size-3.5" />}</button>
        </div>
        <div id={`${id}-${row.id}`} hidden={!isExpanded} className="pl-5">
          <button type="button" className={`${quietButton} w-full justify-start gap-2 text-xs`} onClick={() => onNewThread(row.agent)}><MessageSquare aria-hidden="true" className="size-3.5" />New thread</button>
          {children.map((thread) => <button key={thread.id} type="button" aria-current={thread.id === selectedId ? "page" : undefined} className={`${quietButton} w-full justify-start gap-2 text-left text-xs ${thread.id === selectedId ? "bg-[var(--secondary)] text-[var(--fg)]" : ""}`} onClick={() => onOpenThread(thread.id)}><MessageSquare aria-hidden="true" className="size-3.5 shrink-0" /><span className="truncate">{thread.name || "Untitled thread"}</span></button>)}
        </div>
      </div>;
    })}</div>
  </section>;
}

export function EmployeeOnboarding({ onSelect, onSkip }: { onSelect: (template: EmployeeTemplate) => Promise<void>; onSkip: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const choose = async (template: EmployeeTemplate) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(template.id);
    setError(null);
    try { await onSelect(template); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not set up this agent. Try again."); }
    finally { pending.current = false; setBusy(null); }
  };
  return <section aria-label="Set up your AI employees" className="w-full border-b border-[var(--border-1)] bg-[var(--bg)] px-6 py-8 text-[var(--fg)]">
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-medium">Set up your AI employees</h2><p className="mt-2 text-sm text-[var(--muted-foreground-2)]">Choose a role to start a thread. Work stays a draft until you approve.</p></div><button type="button" disabled={busy !== null} className={quietButton} onClick={onSkip}>Skip for now</button></div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{EMPLOYEE_TEMPLATES.map((template) => <button type="button" key={template.id} disabled={busy !== null} aria-pressed={busy === template.id} onClick={() => void choose(template)} className="min-h-28 rounded-xl border border-[var(--border-1)] bg-[var(--card)] p-4 text-left hover:bg-[var(--secondary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] disabled:opacity-60"><RoleShiba role={template.id} decorative className="mb-3 size-12" /><span className="block text-sm font-medium">{busy === template.id ? `Setting up ${template.label.toLowerCase()}…` : template.label}</span><span className="mt-1 block text-xs leading-relaxed text-[var(--muted-foreground-2)]">{template.description}</span></button>)}</div>
      {error ? <p role="alert" className="mt-4 text-sm text-[var(--destructive)]">{error}</p> : null}
    </div>
  </section>;
}

export async function createEmployeeAgent(template: EmployeeTemplate, workspaceId?: string): Promise<CustomAgentWire> {
  const response = await fetch("/api/custom-agents", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", ...teamWorkspaceHeaders(workspaceId) }, body: JSON.stringify({ slug: template.slug, config: { ...template.config, harness: "opencode", approvalPolicy: "standard" } }) });
  const body = await response.json().catch(() => ({})) as { agent?: CustomAgentWire; error?: string };
  if (!response.ok || !body.agent) throw new Error(body.error ?? `Could not create agent (${response.status}).`);
  return body.agent;
}

export function AgentPageHeader({ name, slug, role, detailsOpen, onToggleDetails, onExpandSidebar, onShareWithTeam }: { name: string; slug?: string; role?: EmployeeRole; detailsOpen: boolean; onToggleDetails: () => void; onExpandSidebar?: () => void; onShareWithTeam?: () => void }) {
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!participantsOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!headerRef.current?.contains(event.target as Node)) setParticipantsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setParticipantsOpen(false);
      headerRef.current?.querySelector<HTMLButtonElement>('[aria-label="Participants"]')?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [participantsOpen]);
  return <div ref={headerRef} className="relative"><ViewHeader section="Agents" view={name} leading={<>{onExpandSidebar ? <button type="button" className={`${quietButton} hidden lg:inline-flex`} aria-label="Expand sidebar" onClick={onExpandSidebar}><PanelLeft aria-hidden="true" className="size-4" /></button> : null}<AgentAvatar name={name} slug={slug} role={role} /></>}>
    {onShareWithTeam ? <button type="button" className={`${quietButton} gap-2 text-xs`} onClick={() => onShareWithTeam()} aria-describedby={`${id}-share-context`}><Users aria-hidden="true" className="size-4" />Start shared conversation</button> : null}
    <button type="button" className={quietButton} aria-label="Participants" aria-expanded={participantsOpen} aria-controls={`${id}-participants`} onClick={() => setParticipantsOpen(!participantsOpen)}><Users aria-hidden="true" className="size-4" /><span className="ml-2 hidden sm:inline">You and agent</span></button>
    <button type="button" className={quietButton} aria-label="Toggle agent details" aria-expanded={detailsOpen} aria-controls="agent-details" onClick={onToggleDetails}><PanelRight aria-hidden="true" className="size-4" /></button>
  </ViewHeader>{onShareWithTeam ? <p id={`${id}-share-context`} className="border-b border-[var(--border-1)] px-4 py-2 text-xs text-[var(--muted-foreground-2)]">A shared conversation starts separately. Your private history is not automatically included; choose what to share in the team chat.</p> : null}{participantsOpen ? <div id={`${id}-participants`} className="absolute right-4 top-full z-20 w-60 rounded-xl border border-[var(--border-1)] bg-[var(--popover)] p-4 text-sm text-[var(--fg)] shadow-overlay"><p className="font-medium">Participants</p><p className="mt-3">You</p><p className="mt-2">{name}</p><p className="mt-3 text-xs text-[var(--muted-foreground-2)]">You and this agent work in your Shiba workspace.</p></div> : null}</div>;
}

export function AgentConversationEmpty({ name, slug, role, examples = [], onPrefill, prefillDisabled = false }: { name: string; slug?: string; role?: EmployeeRole; examples?: readonly string[]; onPrefill: (prompt: string) => void; prefillDisabled?: boolean }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center"><AgentAvatar name={name} slug={slug} role={role} large /><h2 className="text-base font-medium text-[var(--fg)]">{name}</h2><p className="max-w-md text-sm leading-relaxed text-[var(--muted-foreground-2)]">This is the beginning of your conversation. Messages are stored in your Shiba workspace.</p><p className="max-w-md text-xs leading-relaxed text-[var(--muted-foreground-2)]">Planning can start now. Every sandbox execution requires human approval. Publishing completed changes requires a separate approval.</p>{examples.length ? <div className="mt-4 flex max-w-xl flex-wrap justify-center gap-2">{examples.map((prompt) => <button type="button" key={prompt} disabled={prefillDisabled} title={prefillDisabled ? "Clear your draft to use an example" : undefined} className={`${viewButtonClass} text-left font-normal disabled:cursor-not-allowed disabled:opacity-50`} onClick={() => onPrefill(prompt)}>{prompt}</button>)}</div> : null}</div>;
}

export function AgentDetailsPanel({
  agent,
  onClose,
  onEdit,
  ownerName,
  computerInfo,
  initialTab = "details",
}: {
  agent?: CustomAgentWire;
  onClose: () => void;
  onEdit: () => void;
  ownerName?: string;
  computerInfo?: string;
  initialTab?: "details" | "library" | "computer";
}) {
  const panelRef = useRef<HTMLElement>(null);
  const [activeTab, setActiveTab] = useState<"details" | "library" | "computer">(initialTab);
  useEffect(() => {
    if (window.innerWidth < 1280) panelRef.current?.scrollIntoView?.({ block: "nearest", behavior: "instant" });
  }, []);
  const name = agent?.config.name ?? "Shiba";
  const role = employeeRole(agent?.slug, agent?.config.roleTemplateId);
  const template = EMPLOYEE_TEMPLATES.find((item) => item.id === role);
  const rows = [
    { label: "Model", preview: agent?.config.codingModel || "Workspace default", value: agent?.config.codingModel || "Uses the workspace model default." },
    { label: "Instructions", preview: agent?.config.instructions ? agent.config.instructions.slice(0, 70) : "Workspace instructions", value: agent?.config.instructions || "Use the workspace instructions." },
    { label: "Tools", preview: agent?.config.toolScopes?.length ? `${agent.config.toolScopes.length} scopes` : "Harness defaults", value: agent?.config.toolScopes?.length ? agent.config.toolScopes.join(", ") : "Tools are provided by the selected harness and workspace. No fixed tool count is available." },
    { label: "Advanced", preview: "Human approval", value: `Harness: ${agent?.config.harness ?? "Workspace default"}\nSandbox: ${agent?.config.sandboxProvider ?? "Workspace default"}\nApproval policy: Explicit human approval` },
  ];
  return (
    <aside
      ref={panelRef}
      id="agent-details"
      aria-label="Agent details"
      className="flex w-full min-w-0 shrink-0 flex-col border-t border-[var(--border-1)] bg-[var(--chrome)] p-5 text-[var(--fg)] xl:w-[370px] xl:overflow-y-auto xl:border-l xl:border-t-0"
    >
      <button type="button" className={`${quietButton} self-end`} aria-label="Close agent details" onClick={onClose}>
        <X aria-hidden="true" className="size-4" />
      </button>
      <div className="flex flex-col items-center gap-3 py-5 text-center">
        <AgentAvatar name={name} slug={agent?.slug} role={role} large />
        <h2 className="text-lg font-medium tracking-tight">{name}</h2>
        <p className="text-xs font-medium text-[var(--muted-foreground-2)]">
          {ownerName ? `${ownerName} · ` : ""}
          {agent ? employeeRoleLabel(role) : "Shiba"} · Runs on {agent?.config.harness ?? "workspace default"}
        </p>
        <p className="line-clamp-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--muted-foreground-2)]">
          {agent?.config.instructions || template?.description || "Add a description"}
        </p>
      </div>

      <div role="tablist" aria-label="Agent details tabs" className="flex w-full border-b border-[var(--border-1)]">
        {(["details", "library", "computer"] as const).map((tab) => {
          const label = tab === "details" ? "Details" : tab === "library" ? "Library" : "Computer";
          const isSelected = activeTab === tab;
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`agent-tab-${tab}`}
              aria-selected={isSelected}
              aria-controls={`agent-panel-${tab}`}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 pb-2 text-[13px] font-medium transition-colors border-b-2 -mb-px ${
                isSelected
                  ? "border-[var(--primary)] text-[var(--fg)] font-semibold"
                  : "border-transparent text-[var(--muted-foreground-2)] hover:text-[var(--fg)]"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto">
        {activeTab === "details" ? (
          <div role="tabpanel" id="agent-panel-details" aria-labelledby="agent-tab-details" className="pt-4 flex flex-col gap-4">
            <section aria-label="Agent information">
              <h3 className="mb-2 text-xs font-medium text-[var(--muted-foreground-2)]">Configuration</h3>
              <div className="divide-y divide-[var(--border-1)] text-sm">
                {rows.map((row) => (
                  <details key={row.label} className="group">
                    <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-lg py-3 focus-visible:outline-2 focus-visible:outline-[var(--ring)] [&::-webkit-details-marker]:hidden">
                      <span>{row.label}</span>
                      <span className="ml-auto max-w-40 truncate text-xs text-[var(--muted-foreground-2)]">{row.preview}</span>
                      <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-[var(--icon-muted)] group-open:rotate-90" />
                    </summary>
                    <p className="whitespace-pre-wrap break-words pb-4 text-xs leading-relaxed text-[var(--muted-foreground-2)]">{row.value}</p>
                  </details>
                ))}
              </div>
            </section>
          </div>
        ) : null}

        {activeTab === "library" ? (
          <div role="tabpanel" id="agent-panel-library" aria-labelledby="agent-tab-library" className="pt-4 flex flex-col gap-2">
            <h3 className="text-xs font-medium text-[var(--muted-foreground-2)]">Library</h3>
            {agent?.config.expectedDeliverables && agent.config.expectedDeliverables.length > 0 ? (
              <ul className="flex flex-col gap-1.5" aria-label="Agent deliverables">
                {agent.config.expectedDeliverables.map((item) => (
                  <li key={item} className="flex items-center gap-2 rounded-md border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-xs font-mono text-[var(--fg)]">
                    <span className="truncate">{item}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-6 text-center text-xs text-[var(--muted-foreground-2)]">No files yet</p>
            )}
          </div>
        ) : null}

        {activeTab === "computer" ? (
          <div role="tabpanel" id="agent-panel-computer" aria-labelledby="agent-tab-computer" className="pt-4 flex flex-col gap-2">
            <h3 className="text-xs font-medium text-[var(--muted-foreground-2)]">Computer</h3>
            {computerInfo || agent?.config.sandboxProvider ? (
              <div className="rounded-md border border-[var(--border-1)] bg-[var(--card)] p-3 text-xs text-[var(--fg)]">
                <div className="font-medium">{computerInfo ?? `Sandbox: ${agent?.config.sandboxProvider ?? "default"}`}</div>
                <div className="mt-1 text-[11px] text-[var(--muted-foreground-2)]">Harness: {agent?.config.harness ?? "opencode"}</div>
                {agent?.config.connectionId ? <div className="mt-1 text-[11px] text-[var(--muted-foreground-2)]">Connection: {agent.config.connectionId}</div> : null}
              </div>
            ) : (
              <p className="py-6 text-center text-xs text-[var(--muted-foreground-2)]">No computer</p>
            )}
          </div>
        ) : null}
      </div>

      <button type="button" className={`${viewButtonClass} mt-4 w-full`} onClick={onEdit}>Manage agents</button>
    </aside>
  );
}
