import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, MessageSquare, PanelLeft, PanelRight, Plus, Users, X } from "lucide-react";
import { botLibraryFileIds, type BotConfigEdit } from "../bot-library";
import { defaultAgentToolRows, botToolRows, type BotToolPolicy } from "../bot-tools";
import type { AgentAvatarChoice, AgentMascotLook, CustomAgentMascotPreset } from "@shiba/shared";
import type { CustomAgentWire } from "./CustomAgentsView";
import type { WebThread } from "../agent-threads";
import { threadAgentId } from "../agent-threads";
import { EMPLOYEE_TEMPLATES, employeeRole, employeeRoleLabel, type EmployeeTemplate, type EmployeeRole } from "../employee-templates";
import { AgentAvatar as BaseAvatar } from "./AgentAvatar";
import { ShibaMark } from "./ShibaMark";
import { ViewHeader, viewButtonClass } from "./ui/ViewChrome";
import { teamWorkspaceHeaders } from "../team-workspaces-client";
import { BotNotice, BotTabList, QUIET_BUTTON, type BotNoticeTone, type BotPanelTab, type BotRunsScope } from "./bot/BotPanel";
import { BotDetailsTab, type BotModelEdit } from "./bot/BotDetailsTab";
import { BotLibraryTab, type BotRunOutput } from "./bot/BotLibraryTab";
import { BotComputerTab, type BotRunRow } from "./bot/BotComputerTab";

const quietButton = QUIET_BUTTON;
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

export function AgentAvatar({ name, slug, role, agentId, mascotPreset, look, avatar, large = false, size = large ? 112 : 40 }: { name: string; slug?: string; role?: EmployeeRole; agentId?: string; mascotPreset?: CustomAgentMascotPreset; look?: AgentMascotLook; avatar?: AgentAvatarChoice; large?: boolean; size?: number }) {
  if (slug === undefined) return <span className="inline-flex shrink-0" style={{ width: size, height: size }}><ShibaMark className="size-full" decorative /></span>;
  return <BaseAvatar id={agentId ?? slug} name={name} mascotPreset={mascotPreset} look={look} avatar={avatar} role={role ?? employeeRole(slug)} size={size} decorative />;
}

/**
 * A bot page with no thread behind it. The panel is open on a bot that has never
 * been messaged, so the surface shows that bot and one action: it never borrows
 * the previous bot's conversation, title editor, drafts or composer.
 */
export function BotThreadlessState({ name, slug, role, agentId, mascotPreset, look, avatar, busy = false, state = "empty", message, onStart }: {
  name: string; slug?: string; role?: EmployeeRole; agentId?: string;
  mascotPreset?: CustomAgentMascotPreset; look?: AgentMascotLook; avatar?: AgentAvatarChoice;
  busy?: boolean;
  /** `pending` is inert while the bot's thread opens; `unavailable` says it did not open. */
  state?: "empty" | "pending" | "unavailable";
  /** A specific reason to show instead of the generic body. */
  message?: string;
  onStart: () => void;
}) {
  const text = state === "pending"
    ? { heading: `Opening ${name}…`, body: "Its newest thread is loading. Nothing from another bot is shown or sent while this finishes." }
    : state === "unavailable"
      ? { heading: `${name}'s thread could not be opened`, body: "Nothing from this bot's conversation is shown, and this bot's composer is not open. Reload to try again, or start a new thread." }
      : { heading: `${name} has no thread yet`, body: "Details, Library and Computer show what this bot is and what it has done. A thread is where you give it work to start." };
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center" aria-busy={state === "pending"}>
      <AgentAvatar agentId={agentId} name={name} mascotPreset={mascotPreset} avatar={avatar} look={look} slug={slug} role={role} large />
      <h2 className="text-base font-medium text-[var(--fg)]">{text.heading}</h2>
      <p className="max-w-md text-sm leading-relaxed text-[var(--muted-foreground-2)]">{message ?? text.body}</p>
      {state === "pending" ? (
        <p role="status" className="text-[11px] text-[var(--muted-foreground-2)]">Loading…</p>
      ) : (
        <button type="button" disabled={busy} onClick={onStart} className={viewButtonClass}>
          Start a thread with {name}
        </button>
      )}
    </div>
  );
}

export function AgentSidebar({ agents, threads, selectedId, onOpenThread, onNewThread, onManage, onOpenAgent }: {
  agents: CustomAgentWire[]; threads: WebThread[]; selectedId?: string | null;
  onOpenThread: (id: string) => void; onNewThread: (agent?: CustomAgentWire) => void; onManage: () => void;
  /** Opens this bot's page with its panel; falls back to its newest thread. */
  onOpenAgent?: (agent?: CustomAgentWire) => void;
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
      const hasSelectedThread = children.some((thread) => thread.id === selectedId);
      return <div key={row.id}>
        <div className="flex items-center">
          <button type="button" aria-current={hasSelectedThread ? "true" : undefined} className={`${quietButton} min-w-0 flex-1 justify-start gap-2 text-left text-[13px]`} onClick={() => { if (onOpenAgent) { onOpenAgent(row.agent); return; } const latest = [...children].sort((a, b) => b.updatedAt - a.updatedAt)[0]; if (latest) onOpenThread(latest.id); else onNewThread(row.agent); }}><AgentAvatar agentId={row.agent?.id} name={row.name} mascotPreset={row.agent?.config.mascotPreset} avatar={row.agent?.config.avatar} look={row.agent?.config.look} slug={row.agent?.slug} role={employeeRole(row.agent?.slug, row.agent?.config.roleTemplateId)} size={28} /><span className="truncate">{row.name}</span></button>
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
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{EMPLOYEE_TEMPLATES.map((template) => <button type="button" key={template.id} disabled={busy !== null} aria-pressed={busy === template.id} onClick={() => void choose(template)} className="min-h-28 rounded-xl border border-[var(--border-1)] bg-[var(--card)] p-4 text-left hover:bg-[var(--secondary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] disabled:opacity-60"><BaseAvatar id={template.id} name={template.label} role={template.id} size={48} decorative className="mb-3" /><span className="block text-sm font-medium">{busy === template.id ? `Setting up ${template.label.toLowerCase()}…` : template.label}</span><span className="mt-1 block text-xs leading-relaxed text-[var(--muted-foreground-2)]">{template.description}</span></button>)}</div>
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

export function AgentPageHeader({ name, slug, role, agentId, mascotPreset, look, detailsOpen, onToggleDetails, onExpandSidebar, onShareWithTeam }: { name: string; slug?: string; role?: EmployeeRole; agentId?: string; mascotPreset?: CustomAgentMascotPreset; look?: AgentMascotLook; detailsOpen: boolean; onToggleDetails: () => void; onExpandSidebar?: () => void; onShareWithTeam?: () => void }) {
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
  return <div ref={headerRef} className="relative"><ViewHeader section="Agents" view={name} leading={<>{onExpandSidebar ? <button type="button" className={`${quietButton} hidden lg:inline-flex`} aria-label="Expand sidebar" onClick={onExpandSidebar}><PanelLeft aria-hidden="true" className="size-4" /></button> : null}<AgentAvatar agentId={agentId} name={name} mascotPreset={mascotPreset} look={look} slug={slug} role={role} size={28} /></>}>
    {onShareWithTeam ? <button type="button" className={`${quietButton} gap-2 text-xs`} onClick={() => onShareWithTeam()} aria-describedby={`${id}-share-context`}><Users aria-hidden="true" className="size-4" />Start shared conversation</button> : null}
    <button type="button" className={quietButton} aria-label="Participants" aria-expanded={participantsOpen} aria-controls={`${id}-participants`} onClick={() => setParticipantsOpen(!participantsOpen)}><Users aria-hidden="true" className="size-4" /><span className="ml-2 hidden sm:inline">You and agent</span></button>
    <button type="button" className={quietButton} aria-label="Toggle agent details" aria-expanded={detailsOpen} aria-controls="agent-details" onClick={onToggleDetails}><PanelRight aria-hidden="true" className="size-4" /></button>
  </ViewHeader>{onShareWithTeam ? <p id={`${id}-share-context`} className="border-b border-[var(--border-1)] px-4 py-2 text-xs text-[var(--muted-foreground-2)]">A shared conversation starts separately. Your private history is not automatically included; choose what to share in the team chat.</p> : null}{participantsOpen ? <div id={`${id}-participants`} className="absolute right-4 top-full z-20 w-60 rounded-xl border border-[var(--border-1)] bg-[var(--popover)] p-4 text-sm text-[var(--fg)] shadow-overlay"><p className="font-medium">Participants</p><p className="mt-3">You</p><p className="mt-2">{name}</p><p className="mt-3 text-xs text-[var(--muted-foreground-2)]">You and this agent work in your Shiba workspace.</p></div> : null}</div>;
}

export function AgentConversationEmpty({ name, slug, role, agentId, mascotPreset, look, examples = [], onPrefill, prefillDisabled = false }: { name: string; slug?: string; role?: EmployeeRole; agentId?: string; mascotPreset?: CustomAgentMascotPreset; look?: AgentMascotLook; examples?: readonly string[]; onPrefill: (prompt: string) => void; prefillDisabled?: boolean }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center"><AgentAvatar agentId={agentId} name={name} mascotPreset={mascotPreset} look={look} slug={slug} role={role} large /><h2 className="text-base font-medium text-[var(--fg)]">{name}</h2><p className="max-w-md text-sm leading-relaxed text-[var(--muted-foreground-2)]">This is the beginning of your conversation. Messages are stored in your Shiba workspace.</p><p className="max-w-md text-xs leading-relaxed text-[var(--muted-foreground-2)]">Planning can start now. Every sandbox execution requires human approval. Publishing completed changes requires a separate approval.</p>{examples.length ? <div className="mt-4 flex max-w-xl flex-wrap justify-center gap-2">{examples.map((prompt) => <button type="button" key={prompt} disabled={prefillDisabled} title={prefillDisabled ? "Clear your draft to use an example" : undefined} className={`${viewButtonClass} text-left font-normal disabled:cursor-not-allowed disabled:opacity-50`} onClick={() => onPrefill(prompt)}>{prompt}</button>)}</div> : null}</div>;
}

/** Every computer paired with the workspace, with the reason it can or cannot run now. */

/** Every computer paired with the workspace, with the reason it can or cannot run now. */
export interface BotPairedComputer {
  machineId: string;
  hostname?: string;
  state: "ready" | "busy" | "offline" | "incompatible";
}

export interface BotRuntimeInfo {
  harness: string;
  /** Cloud sandbox provider configured for this bot, if any. */
  sandboxProvider?: string;
  /** Whether this workspace can run the bot on a paired computer right now. */
  localAvailable: boolean;
  /** Paired computers, including ones that are busy, offline or unable to run this harness. */
  paired: readonly BotPairedComputer[];
  loading: boolean;
  error: string | null;
}

export interface AgentDetailsPanelProps {
  agent?: CustomAgentWire;
  /** True while the directory is still resolving the selected bot: the panel must not fall back to another bot's data. */
  directoryLoading?: boolean;
  onClose: () => void;
  onEdit: () => void;
  ownerName?: string;
  workspaceName?: string;
  runtime?: BotRuntimeInfo;
  initialTab?: BotPanelTab;
  /** False for a shared room or a profile this viewer may not change. */
  editing?: boolean;
  modelEdit?: BotModelEdit | null;
  /** Persists a versioned config edit; rejects with a message the panel shows. */
  onConfigSave?: (edit: BotConfigEdit) => Promise<void>;
  /** Saves the bot's required output paths. */
  onLibrarySave?: (deliverables: string[]) => Promise<void>;
  /** Runs this bot started, newest first. */
  runs?: readonly BotRunRow[];
  /** Queued tasks for this bot waiting on a person. */
  pendingApprovals?: number;
  /** Captured files from those runs. */
  runOutputs?: readonly BotRunOutput[];
  /** Which conversation the run lists cover, and whether that read has landed. */
  runsScope?: BotRunsScope;
  onOpenRun?: (runId: string) => void;
  onOpenApprovals?: () => void;
  onManageTools?: () => void;
  webSearchReady?: boolean | null;
}

interface ToolPolicyState {
  policy: BotToolPolicy | null;
  loading: boolean;
  error: string | null;
}

function useBotToolPolicy(agentId: string | undefined): ToolPolicyState {
  const [state, setState] = useState<ToolPolicyState>({ policy: null, loading: Boolean(agentId), error: null });
  useEffect(() => {
    if (!agentId) { setState({ policy: null, loading: false, error: null }); return; }
    let active = true;
    setState({ policy: null, loading: true, error: null });
    void fetch(`/api/employee-tools/${encodeURIComponent(agentId)}/policy`, { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as Partial<BotToolPolicy> & { error?: string };
        if (!active) return;
        if (!response.ok || !Array.isArray(body.toolScopes) || !Array.isArray(body.grants)) {
          setState({ policy: null, loading: false, error: body.error ?? `Tool grants are unavailable (${response.status}).` });
          return;
        }
        setState({ policy: { employeeVersion: Number(body.employeeVersion ?? 0), toolScopes: body.toolScopes, grants: body.grants }, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (active) setState({ policy: null, loading: false, error: error instanceof Error ? error.message : "Tool grants are unavailable." });
      });
    return () => { active = false; };
  }, [agentId]);
  return state;
}

/**
 * The bot panel: one hero, three pill tabs. Every field it can change is a
 * versioned config edit for the bot it is showing, and every list it shows comes
 * from a request scoped to that bot — so switching bots can never leave the
 * previous bot's files, runs or controls on screen.
 */
export function AgentDetailsPanel({
  agent,
  directoryLoading = false,
  onClose,
  onEdit,
  ownerName,
  runtime,
  workspaceName,
  initialTab = "details",
  editing = true,
  modelEdit = null,
  onConfigSave,
  onLibrarySave,
  runs = [],
  pendingApprovals = 0,
  runOutputs = [],
  runsScope,
  onOpenRun,
  onOpenApprovals,
  onManageTools,
  webSearchReady = null,
}: AgentDetailsPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const [activeTab, setActiveTab] = useState<BotPanelTab>(initialTab);
  const [instructions, setInstructions] = useState(agent?.config.instructions ?? "");
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveNotice, setSaveNotice] = useState<{ tone: BotNoticeTone; text: string } | null>(null);
  const [libraryNotice, setLibraryNotice] = useState<{ tone: BotNoticeTone; text: string } | null>(null);
  const [deliverables, setDeliverables] = useState<string[]>(() => [...(agent?.config.expectedDeliverables ?? [])]);
  const [openInstructionsSignal, setOpenInstructionsSignal] = useState(0);
  const savedInstructions = agent?.config.instructions ?? "";
  const linkedFileIds = useMemo(() => botLibraryFileIds(agent?.config), [agent?.config]);
  const toolPolicy = useBotToolPolicy(agent?.id);

  // A different bot is a different editor; nothing carries across the switch.
  const syncedBotId = useRef(agent?.id);
  const syncedInstructions = useRef(savedInstructions);
  useEffect(() => {
    const switchedBot = syncedBotId.current !== agent?.id;
    syncedBotId.current = agent?.id;
    if (switchedBot) {
      setSaveNotice(null);
      setLibraryNotice(null);
      setOpenInstructionsSignal(0);
    }
    // A directory refresh must never discard what this person is typing, and it
    // must not overwrite a draft this panel has not saved yet. Only an unchanged
    // draft follows the stored value.
    if (switchedBot || instructions.trim() === syncedInstructions.current.trim()) {
      setInstructions(savedInstructions);
    }
    syncedInstructions.current = savedInstructions;
  }, [agent?.id, savedInstructions, instructions]);
  useEffect(() => {
    setDeliverables([...(agent?.config.expectedDeliverables ?? [])]);
  }, [agent?.config.expectedDeliverables]);
  useEffect(() => {
    if (window.innerWidth < 1280) panelRef.current?.scrollIntoView?.({ block: "nearest", behavior: "instant" });
  }, []);

  const canEdit = Boolean(agent && editing && onConfigSave);
  const name = agent?.config.name ?? "Shiba";
  const role = employeeRole(agent?.slug, agent?.config.roleTemplateId);
  const template = EMPLOYEE_TEMPLATES.find((item) => item.id === role);
  const toolRows = useMemo(() => {
    if (!agent) return defaultAgentToolRows({ webSearchReady });
    const rows = botToolRows({ policy: toolPolicy.policy, policyError: toolPolicy.error, webSearchReady });
    return rows;
  }, [agent, toolPolicy.policy, toolPolicy.error, webSearchReady]);

  const saveEdit = async (edit: BotConfigEdit, ok: string) => {
    if (!onConfigSave) return;
    setSaveBusy(true);
    setSaveNotice(null);
    try {
      await onConfigSave(edit);
      setSaveNotice({ tone: "ok", text: ok });
    } catch (error) {
      setSaveNotice({ tone: "err", text: error instanceof Error ? error.message : "Could not save this bot." });
    } finally {
      setSaveBusy(false);
    }
  };

  const advanced = [
    { label: "Harness", value: agent?.config.harness ?? "Workspace default" },
    { label: "Sandbox", value: agent?.config.sandboxProvider ?? "Workspace default" },
    { label: "Approval policy", value: "Explicit human approval" },
    { label: "Version", value: agent ? `v${agent.version}` : "Shiba" },
  ];

  return (
    <aside
      ref={panelRef}
      id="agent-details"
      aria-label="Agent details"
      className="flex w-full min-w-0 shrink-0 flex-col border-t border-[var(--border-1)] bg-[var(--chrome)] p-5 text-[var(--fg)] xl:w-[370px] xl:overflow-y-auto xl:border-l xl:border-t-0"
    >
      <button type="button" className={`${QUIET_BUTTON} self-end`} aria-label="Close agent details" onClick={onClose}>
        <X aria-hidden="true" className="size-4" />
      </button>

      <div className="flex flex-col items-center gap-3 pb-5 pt-1 text-center">
        <AgentAvatar agentId={agent?.id} name={name} mascotPreset={agent?.config.mascotPreset} avatar={agent?.config.avatar} look={agent?.config.look} slug={agent?.slug} role={role} large />
        <div className="flex flex-col items-center gap-1">
          <h2 className="text-lg font-medium tracking-tight">{name}</h2>
          <p className="text-xs font-medium text-[var(--muted-foreground-2)]">
            {workspaceName ? `${workspaceName} · ` : ""}
            {ownerName ? `${ownerName} · ` : ""}
            {agent ? employeeRoleLabel(role) : "Shiba"} · Runs on {agent?.config.harness ?? "workspace default"}
          </p>
          {agent ? null : <p className="font-mono text-[10px] uppercase tracking-wide text-[var(--muted-foreground-2)]">Pinned</p>}
        </div>
        {directoryLoading ? (
          <p role="status" className="text-[11px] text-[var(--muted-foreground-2)]">Loading this bot…</p>
        ) : (
          <div className="w-full">
            <p className="line-clamp-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--muted-foreground-2)]">
              {agent ? (instructions || template?.description || "Add a description") : (template?.description || DEFAULT_AGENT_DESCRIPTION)}
            </p>
            {canEdit ? (
              <button
                type="button"
                onClick={() => { setActiveTab("details"); setOpenInstructionsSignal((value) => value + 1); }}
                className="mt-1 inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-[11px] text-[var(--primary)] underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
              >
                Edit description
              </button>
            ) : null}
            {agent ? null : (
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
                Shiba is the workspace's default agent. It follows the workspace instructions and model defaults, and its
                threads stay in this workspace.
              </p>
            )}
          </div>
        )}
      </div>

      <BotTabList active={activeTab} onChange={setActiveTab} />

      <div className="flex-1 overflow-y-auto pt-2">
        {activeTab === "details" ? (
          <BotDetailsTab
            editing={canEdit}
            modelEdit={modelEdit}
            instructions={instructions}
            instructionsSaved={savedInstructions}
            onInstructionsChange={setInstructions}
            onInstructionsSave={() => void saveEdit({ instructions: instructions.trim() }, "Instructions saved for this bot.")}
            notice={saveNotice}
            saveBusy={saveBusy}
            toolsRows={toolRows}
            toolsLoading={agent ? toolPolicy.loading : false}
            toolsError={agent ? toolPolicy.error : null}
            onManageTools={onManageTools}
            advanced={advanced}
            openInstructionsSignal={openInstructionsSignal}
          />
        ) : activeTab === "library" ? (
          <BotLibraryTab
            canEdit={canEdit}
            linkedFileIds={linkedFileIds}
            onLinkFiles={onConfigSave ? async (ids) => { await onConfigSave({ libraryFileIds: [...ids] }); } : undefined}
            deliverables={deliverables}
            onDeliverablesSave={agent && onLibrarySave ? async (paths) => {
              await onLibrarySave([...paths]);
              setDeliverables([...paths]);
            } : undefined}
            runs={runOutputs}
            runsScope={runsScope}
            onOpenRun={onOpenRun}
            onLibraryNotice={setLibraryNotice}
          />
        ) : (
          <BotComputerTab
            runtime={runtime}
            configuredHarness={agent?.config.harness}
            configuredSandbox={agent?.config.sandboxProvider}
            connectionId={agent?.config.connectionId}
            runs={runs}
            runsScope={runsScope}
            pendingApprovals={pendingApprovals}
            onOpenRun={onOpenRun}
            onOpenApprovals={onOpenApprovals}
          />
        )}
        {activeTab !== "details" ? <div className="pt-2"><BotNotice notice={libraryNotice ?? saveNotice} /></div> : null}
      </div>

      {agent ? (
        <button type="button" className={`${viewButtonClass} mt-4 w-full`} onClick={onEdit}>Manage agents</button>
      ) : null}
    </aside>
  );
}

const DEFAULT_AGENT_DESCRIPTION = "The workspace's default agent. Plan work, queue an approval, and review the result.";
