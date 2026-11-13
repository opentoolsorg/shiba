import { useCallback, useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { ChevronRight } from "lucide-react";
import { LoadErrorState } from "./LoadErrorState";
import { EmptyState, SkeletonLines, StatusNotice } from "./surface";
import { agentThreads, type WebThread } from "../agent-threads";
import { formatTimeAgo } from "../ui-helpers";
import { AGENT_MASCOT_ACCS, AGENT_MASCOT_EYES, AGENT_MASCOT_SHAPES, CUSTOM_AGENT_MASCOT_PRESETS, defaultLookFor, formLook, normalizeMascotColor, sanitizeCustomAgentSlug, type CustomAgentConfig, type CustomAgentRoleTemplateId } from "@shiba/shared";
import { AgentLookStyler } from "./AgentLookStyler";
import { codingModelOptions, type ConnectionOption } from "../live-status";
import { EMPLOYEE_TEMPLATES, employeeRole, employeeRoleLabel, type EmployeeTemplate } from "../employee-templates";
import { AgentAvatar as MascotAvatar } from "./AgentAvatar";
import { AgentTemplatesCatalog } from "./AgentTemplatesCatalog";
import { AgentAvatar } from "./AgentExperience";
import type { AgentTemplate } from "@shiba/shared";
import { teamWorkspaceHeaders } from "../team-workspaces-client";

const FIELD =
  "bg-[var(--panel)] border border-[var(--border-1)] rounded-[var(--radius-button)] text-[var(--fg)] px-2.5 py-1.5 text-xs focus:outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]/40 placeholder-[var(--muted-foreground-3)]/60 transition-colors w-full";

const SANDBOX_PROVIDERS = ["cloudflare", "docker-local", "computesdk", "e2b"] as const;

export interface CustomAgentWire {
  id: string;
  slug: string;
  version: number;
  archivedAt?: number;
  config: CustomAgentConfig;
}

const EMPTY_FORM = {
  slug: "",
  name: "",
  emoji: "",
  mascotPreset: "",
  lookShape: "",
  lookColor: "",
  lookEyes: "",
  lookAcc: "",
  roleTemplateId: "",
  instructions: "",
  harness: "opencode",
  codingModel: "",
  connectionId: "",
  sandboxProvider: "",
  defaultRepoUrl: "",
  expectedDeliverables: "",
};

function readRoleDraft(scope?: string): typeof EMPTY_FORM {
  if (!scope) return EMPTY_FORM;
  try {
    const draft = JSON.parse(localStorage.getItem(`shiba-role-draft-v1:${scope}`) ?? "null");
    if (draft && Object.keys(EMPTY_FORM).every((key) => key === "roleTemplateId" || key === "mascotPreset" || key.startsWith("look") || typeof draft[key] === "string")) {
      return {
        ...Object.fromEntries(Object.keys(EMPTY_FORM).map((key) => [key, draft[key]])),
        mascotPreset: CUSTOM_AGENT_MASCOT_PRESETS.includes(draft.mascotPreset) ? draft.mascotPreset : "",
        lookShape: (AGENT_MASCOT_SHAPES as readonly string[]).includes(draft.lookShape) ? draft.lookShape : "",
        lookColor: normalizeMascotColor(draft.lookColor) ?? "",
        lookEyes: (AGENT_MASCOT_EYES as readonly string[]).includes(draft.lookEyes) ? draft.lookEyes : "",
        lookAcc: (AGENT_MASCOT_ACCS as readonly string[]).includes(draft.lookAcc) ? draft.lookAcc : "",
        roleTemplateId: EMPLOYEE_TEMPLATES.some((template) => template.id === draft.roleTemplateId) ? draft.roleTemplateId : "",
      } as typeof EMPTY_FORM;
    }
  } catch { /* Storage unavailable or invalid: keep the editor usable. */ }
  return EMPTY_FORM;
}

const hasDraft = (form: typeof EMPTY_FORM) => Object.entries(EMPTY_FORM).some(([key, value]) => form[key as keyof typeof EMPTY_FORM] !== value);

export interface CustomAgentsViewProps {
  onStartThread?: (agent: CustomAgentWire) => Promise<void>;
  threads?: WebThread[];
  threadsLoading?: boolean;
  threadsUnavailable?: boolean;
  onOpenThread?: (id: string) => void;
  connections?: ConnectionOption[];
  modelSuggestions?: string[];
  initialTemplateId?: EmployeeTemplate["id"] | null;
  onInitialTemplateApplied?: () => void;
  /** Opens this saved employee for editing once the directory has loaded. */
  initialAgentId?: string | null;
  onInitialAgentApplied?: () => void;
  draftScope?: string;
  workspaceId?: string;
  actorId?: string;
}

/** Keep drafts and async callbacks in the account/workspace that created them. */
export function CustomAgentsView(props: CustomAgentsViewProps): JSX.Element {
  const scope = JSON.stringify([props.actorId?.trim().toLowerCase() ?? "", props.workspaceId ?? "", props.draftScope ?? ""]);
  const current = useRef({ scope, generation: 0 });
  if (current.current.scope !== scope) current.current = { scope, generation: current.current.generation + 1 };
  const generation = current.current.generation;
  return <ScopedCustomAgentsView key={generation} {...props} isCurrent={() => current.current.generation === generation} />;
}

function ScopedCustomAgentsView({
  onStartThread,
  threads = [],
  threadsLoading = false,
  threadsUnavailable = false,
  onOpenThread,
  connections = [],
  modelSuggestions = [],
  initialTemplateId = null,
  onInitialTemplateApplied,
  initialAgentId = null,
  onInitialAgentApplied,
  draftScope,
  workspaceId,
  isCurrent,
}: CustomAgentsViewProps & { isCurrent: () => boolean }): JSX.Element {
  const alive = useRef(true);
  const currentScope = useRef(isCurrent);
  currentScope.current = isCurrent;
  const isActive = useCallback(() => alive.current && currentScope.current(), []);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const [agents, setAgents] = useState<CustomAgentWire[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [directoryQuery, setDirectoryQuery] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const selectedAgent = agents?.find((agent) => agent.id === selectedAgentId);
  const rosterQuery = directoryQuery.trim().toLocaleLowerCase();
  const visibleAgents = agents?.filter((agent) => [agent.config.name, agent.slug, agent.config.harness,
    agent.config.codingModel ?? "", employeeRoleLabel(employeeRole(agent.slug, agent.config.roleTemplateId))]
    .some((value) => value.toLocaleLowerCase().includes(rosterQuery)));
  const [form, setForm] = useState(() => readRoleDraft(draftScope));
  const [draftStorageAvailable, setDraftStorageAvailable] = useState(true);
  const [expectedVersion, setExpectedVersion] = useState<number | undefined>(undefined);
  const [startingAgentId, setStartingAgentId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [editingConfig, setEditingConfig] = useState<CustomAgentConfig | null>(null);
  const [access, setAccess] = useState<"only-me" | "workspace">("workspace");
  const [conflict, setConflict] = useState(false);
  const directoryRequest = useRef(0);
  const startingThread = useRef(false);
  const savingAgent = useRef(false);
  const [pendingTemplate, setPendingTemplate] = useState<EmployeeTemplate | null>(null);
  const appliedInitialTemplate = useRef<EmployeeTemplate["id"] | null>(null);
  const templateTrigger = useRef<HTMLButtonElement | null>(null);
  const keepDraftButton = useRef<HTMLButtonElement | null>(null);
  const profileSection = useRef<HTMLElement | null>(null);
  const profileTrigger = useRef<HTMLButtonElement | null>(null);
  const focusProfile = useRef(false);
  useEffect(() => {
    if (!focusProfile.current || !selectedAgentId) return;
    focusProfile.current = false;
    profileSection.current?.scrollIntoView?.({ block: "start" });
    profileSection.current?.focus({ preventScroll: true });
  }, [selectedAgentId]);
  const nameInput = useRef<HTMLInputElement | null>(null);
  const [focusNameRequest, setFocusNameRequest] = useState(0);
  const focusName = useCallback(() => setFocusNameRequest((request) => request + 1), []);
  useEffect(() => {
    if (!focusNameRequest || showArchived) return;
    nameInput.current?.scrollIntoView?.({ block: "center", behavior: "auto" });
    nameInput.current?.focus({ preventScroll: true });
  }, [focusNameRequest, showArchived]);
  const templateTitleId = useId();
  const templateDescriptionId = useId();

  useEffect(() => {
    if (!draftScope || editingId) return;
    try {
      const key = `shiba-role-draft-v1:${draftScope}`;
      if (hasDraft(form)) localStorage.setItem(key, JSON.stringify(form));
      else localStorage.removeItem(key);
      setDraftStorageAvailable(true);
    } catch { setDraftStorageAvailable(false); }
  }, [draftScope, editingId, form]);

  useEffect(() => {
    if (pendingTemplate) keepDraftButton.current?.focus();
  }, [pendingTemplate]);

  const keepCurrentDraft = () => {
    setPendingTemplate(null);
    setNotice(null);
    templateTrigger.current?.focus();
  };

  const applyTemplate = useCallback((template: EmployeeTemplate) => {
    if (editingId || busy) return;
    setForm((current) => ({
      ...current,
      slug: template.slug,
      name: template.config.name,
      emoji: template.config.emoji ?? "",
      roleTemplateId: template.id,
      instructions: template.config.instructions,
      expectedDeliverables: template.config.expectedDeliverables?.join("\n") ?? "",
    }));
    setPendingTemplate(null);
    setConflict(false);
    focusName();
    setNotice({ tone: "ok", text: `${template.label} role loaded as an editable draft. Review it before creating a bot.` });
  }, [editingId, busy, focusName]);

  const chooseTemplate = (template: EmployeeTemplate, trigger: HTMLButtonElement) => {
    if (editingId || busy) return;
    templateTrigger.current = trigger;
    if ([form.slug, form.name, form.emoji, form.instructions, form.expectedDeliverables].some((value) => value.trim())) {
      setPendingTemplate(template);
      return;
    }
    applyTemplate(template);
  };

  const startThread = async (agent: CustomAgentWire) => {
    if (!isActive() || !onStartThread || startingThread.current) return;
    startingThread.current = true;
    setStartingAgentId(agent.id);
    setNotice(null);
    try {
      await onStartThread(agent);
    } catch (error) {
      if (isActive()) setNotice({ tone: "err", text: error instanceof Error ? error.message : "Could not start a thread." });
    } finally {
      if (isActive()) { startingThread.current = false; setStartingAgentId(null); }
    }
  };

  const refresh = useCallback(() => {
    if (!isActive()) return;
    const request = ++directoryRequest.current;
    setLoadError(null);
    fetch(showArchived ? "/api/custom-agents?archived=true" : "/api/custom-agents", { headers: teamWorkspaceHeaders(workspaceId) })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Bots could not be loaded (${r.status}).`);
        return (await r.json()) as { agents?: CustomAgentWire[] };
      })
      .then((body) => { if (isActive() && request === directoryRequest.current) setAgents(body.agents ?? []); })
      .catch((error: unknown) => {
        if (isActive() && request === directoryRequest.current) setLoadError(error instanceof Error ? error.message : "Bots could not be loaded.");
      });
  }, [showArchived, workspaceId, isActive]);

  useEffect(() => { setAgents(null); refresh(); return () => { directoryRequest.current++; }; }, [refresh]);

  useEffect(() => {
    if (!initialTemplateId || appliedInitialTemplate.current === initialTemplateId || editingId || busy) return;
    const template = EMPLOYEE_TEMPLATES.find((item) => item.id === initialTemplateId);
    if (!template) return;
    appliedInitialTemplate.current = initialTemplateId;
    if (hasDraft(form)) setPendingTemplate(template);
    else applyTemplate(template);
    onInitialTemplateApplied?.();
  }, [initialTemplateId, editingId, busy, applyTemplate, onInitialTemplateApplied, form]);

  const resetForm = (discardDraft = false) => {
    setPendingTemplate(null);
    setEditingId(null);
    setForm(discardDraft ? EMPTY_FORM : readRoleDraft(draftScope));
    setExpectedVersion(undefined);
    setEditingConfig(null);
    setConflict(false);
  };

  const startEdit = (agent: CustomAgentWire) => {
    focusName();
    setPendingTemplate(null);
    setEditingId(agent.id);
    setExpectedVersion(agent.version);
    setEditingConfig(agent.config);
    setConflict(false);
    setForm({
      slug: agent.slug,
      name: agent.config.name,
      emoji: agent.config.emoji ?? "",
      mascotPreset: agent.config.mascotPreset ?? "",
      lookShape: agent.config.look?.shape ?? "",
      lookColor: agent.config.look?.color ?? "",
      lookEyes: agent.config.look?.eyes ?? "",
      lookAcc: agent.config.look?.acc ?? "",
      roleTemplateId: agent.config.roleTemplateId ?? (employeeRole(agent.slug) === "custom" ? "" : employeeRole(agent.slug)),
      instructions: agent.config.instructions,
      harness: agent.config.harness,
      codingModel: agent.config.codingModel ?? "",
      connectionId: agent.config.connectionId ?? "",
      sandboxProvider: agent.config.sandboxProvider ?? "",
      defaultRepoUrl: agent.config.defaultRepoUrl ?? "",
      expectedDeliverables: agent.config.expectedDeliverables?.join("\n") ?? "",
    });
  };

  const appliedInitialAgent = useRef<string | null>(null);
  // startEdit only sets component state; it is intentionally not a dependency.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!initialAgentId || appliedInitialAgent.current === initialAgentId || !agents) return;
    const agent = agents.find((item) => item.id === initialAgentId);
    appliedInitialAgent.current = initialAgentId;
    if (agent) { setSelectedAgentId(agent.id); startEdit(agent); }
    onInitialAgentApplied?.();
  }, [initialAgentId, agents, onInitialAgentApplied]);

  const saveAgent = async () => {
    if (!isActive() || savingAgent.current || busy) return;
    if (pendingTemplate) {
      setNotice({ tone: "err", text: "Keep your current draft or confirm its replacement before saving." });
      return;
    }
    const slug = sanitizeCustomAgentSlug(form.slug.trim() || form.name.trim());
    const name = form.name.trim();
    const instructions = form.instructions.trim();
    const expectedDeliverables = form.expectedDeliverables.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (!name || !instructions) {
      setNotice({ tone: "err", text: "Name and instructions are required." });
      return;
    }
    if (!slug) {
      setNotice({ tone: "err", text: "Choose a slug of 1–48 letters, numbers, or hyphens in Advanced settings." });
      return;
    }
    if (expectedDeliverables.length > 8) {
      setNotice({ tone: "err", text: "Use at most 8 required deliverable paths, one per line." });
      return;
    }
    savingAgent.current = true;
    setBusy(true);
    setNotice(null);
    const look = formLook(form.lookShape, form.lookColor, form.lookEyes, form.lookAcc);
    const config: CustomAgentConfig = {
      ...editingConfig,
      name,
      instructions,
      harness: form.harness.trim() || "opencode",
      ...(EMPLOYEE_TEMPLATES.some((template) => template.id === form.roleTemplateId) ? { roleTemplateId: form.roleTemplateId as CustomAgentConfig["roleTemplateId"] } : {}),
      ...(form.emoji.trim() ? { emoji: form.emoji.trim() } : {}),
      ...(CUSTOM_AGENT_MASCOT_PRESETS.some((preset) => preset === form.mascotPreset) ? { mascotPreset: form.mascotPreset as CustomAgentConfig["mascotPreset"] } : {}),
      ...(look ? { look } : {}),
      ...(form.codingModel.trim() ? { codingModel: form.codingModel.trim() } : {}),
      ...(form.connectionId.trim() ? { connectionId: form.connectionId.trim() } : {}),
      ...(form.sandboxProvider ? { sandboxProvider: form.sandboxProvider as CustomAgentConfig["sandboxProvider"] } : {}),
      ...(form.defaultRepoUrl.trim() ? { defaultRepoUrl: form.defaultRepoUrl.trim() } : {}),
      ...(expectedDeliverables.length ? { expectedDeliverables } : {}),
    };
    // Clearing an optional field must clear its old value while other saved
    // settings survive an edit of the visible fields.
    for (const key of ["emoji", "mascotPreset", "roleTemplateId", "codingModel", "connectionId", "sandboxProvider", "defaultRepoUrl", "expectedDeliverables"] as const) {
      if (!form[key].trim()) delete config[key];
    }
    if (!look) delete config.look;
    try {
      const response = editingId
        ? await fetch(`/api/custom-agents/${encodeURIComponent(editingId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", ...teamWorkspaceHeaders(workspaceId) },
            body: JSON.stringify({ config, expectedVersion }),
          })
        : await fetch("/api/custom-agents", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...teamWorkspaceHeaders(workspaceId) },
            body: JSON.stringify({ slug, config }),
          });
      const body = (await response.json().catch(() => ({}))) as { error?: string; agent?: CustomAgentWire };
      if (!isActive()) return;
      if (!response.ok || !body.agent) {
        setConflict(response.status === 409);
        setNotice({ tone: "err", text: response.status === 409
          ? "This bot changed since you opened it. Your draft is preserved. Reload the latest version before saving."
          : body.error ?? `Save failed (${response.status}).` });
      } else {
        const saved = body.agent;
        setAgents((current) => {
          const rest = (current ?? []).filter((agent) => agent.id !== saved.id);
          return [saved, ...rest];
        });
        setNotice({ tone: "ok", text: editingId ? "Bot updated." : "Bot created." });
        resetForm(!editingId);
        refresh();
      }
    } catch {
      if (isActive()) setNotice({ tone: "err", text: "Save failed: the backend could not be reached." });
    } finally {
      if (isActive()) { savingAgent.current = false; setBusy(false); }
    }
  };

  const changeLifecycle = async (agent: CustomAgentWire, action: "archive" | "restore") => {
    if (!isActive() || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/custom-agents/${encodeURIComponent(agent.id)}/${action}`, {
        method: "POST", headers: { "content-type": "application/json", ...teamWorkspaceHeaders(workspaceId) }, body: JSON.stringify({}),
      });
      const body = await response.json().catch(() => ({})) as { error?: string; agent?: CustomAgentWire };
      if (!isActive()) return;
      if (!response.ok || !body.agent) throw new Error(body.error ?? `Could not ${action} bot (${response.status}).`);
      setAgents((current) => (current ?? []).filter((item) => item.id !== agent.id));
      if (editingId === agent.id) resetForm();
      setNotice({ tone: "ok", text: action === "archive" ? "Bot archived. Its conversation history is preserved." : "Bot restored." });
      refresh();
    } catch (error) {
      if (isActive()) setNotice({ tone: "err", text: error instanceof Error ? error.message : "Bot could not be updated." });
    } finally { if (isActive()) setBusy(false); }
  };

  const reloadEditingAgent = async () => {
    if (!isActive() || !editingId || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/custom-agents/${encodeURIComponent(editingId)}`, { headers: teamWorkspaceHeaders(workspaceId) });
      const body = await response.json() as { agent?: CustomAgentWire; error?: string };
      if (!isActive()) return;
      if (!response.ok || !body.agent) throw new Error(body.error ?? "Bot could not be reloaded.");
      startEdit(body.agent);
      setNotice({ tone: "ok", text: "Latest bot loaded. Review it before saving." });
    } catch (error) { if (isActive()) setNotice({ tone: "err", text: error instanceof Error ? error.message : "Bot could not be reloaded." }); }
    finally { if (isActive()) setBusy(false); }
  };

  const deleteAgent = async (id: string) => {
    if (!isActive() || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/custom-agents/${encodeURIComponent(id)}`, { method: "DELETE", headers: teamWorkspaceHeaders(workspaceId) });
      if (!isActive()) return;
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (!isActive()) return;
        setNotice({ tone: "err", text: body.error ?? `Delete failed (${response.status}).` });
      } else {
        setAgents((current) => (current ?? []).filter((agent) => agent.id !== id));
        setConfirmDeleteId(null);
        if (editingId === id) resetForm();
        setNotice({ tone: "ok", text: "Bot deleted." });
        refresh();
      }
    } catch {
      if (isActive()) setNotice({ tone: "err", text: "Delete failed: the backend could not be reached." });
    } finally {
      if (isActive()) setBusy(false);
    }
  };

  const onFormKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void saveAgent();
    }
  };

  return (
    <div className="employee-directory flex h-full min-w-0 flex-1 flex-col overflow-hidden border border-[var(--line)] bg-[var(--paper)] text-[var(--ink)]">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] bg-[var(--card)] px-4 py-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[14px]">
          <span className="text-[#71717a] dark:text-zinc-400">
            {workspaceId ? "Workspace" : "Personal"}
          </span>
          <ChevronRight className="size-3.5 text-[#a1a1aa] dark:text-zinc-600" aria-hidden="true" />
          <span className="text-[#71717a] dark:text-zinc-400">Agents</span>
          <ChevronRight className="size-3.5 text-[#a1a1aa] dark:text-zinc-600" aria-hidden="true" />
          <span className="font-medium text-[#0a0a0a] dark:text-zinc-100" aria-current="page">
            {showArchived ? "Archived" : "All"}
          </span>
        </nav>
        <div className="flex items-center gap-2">
          <button type="button" disabled={busy} className="min-h-11 rounded-md px-3 text-xs font-medium focus-visible:outline-2 focus-visible:outline-[var(--ring)]" onClick={() => { resetForm(); setShowArchived(false); focusName(); }}>New bot</button>
          <div className="flex gap-1" role="group" aria-label="Bot directory">
            {[false, true].map((archived) => (
              <button
                key={String(archived)}
                type="button"
                aria-pressed={showArchived === archived}
                disabled={busy}
                onClick={() => {
                  if (archived === showArchived) return;
                  setAgents(null);
                  resetForm();
                  setShowArchived(archived);
                }}
                className="rounded-md border border-[#e4e4e7] px-2.5 py-1 text-xs font-medium aria-pressed:bg-[#f4f4f5] aria-pressed:text-[#0a0a0a] dark:border-zinc-800 dark:aria-pressed:bg-zinc-800 dark:aria-pressed:text-zinc-100 text-[#71717a] dark:text-zinc-400"
              >
                {archived ? "Archived bots" : "Active bots"}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="max-w-6xl mx-auto flex flex-col gap-6">
          <section aria-label="Employee directory" className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <p className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-2)]">Team / Saved employees</p>
              <h1 className="font-serif text-2xl text-[var(--ink)]">Your employee roster</h1>
              <p className="mt-1 max-w-2xl text-sm text-[var(--ink-2)]">Find a saved employee, inspect its defaults, or launch a dedicated thread. Work still requires human approval.</p>
            </div>
            <label className="flex w-full flex-col gap-1 text-xs text-[var(--ink-2)] sm:w-72">
              Search employees
              <input type="search" value={directoryQuery} onChange={(event) => setDirectoryQuery(event.target.value)}
                placeholder="Name, role, harness or model" className="min-h-11 w-full border border-[var(--input-line)] bg-[var(--card)] px-3 text-sm text-[var(--ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]" />
            </label>
          </section>
          {selectedAgent ? (
            <section ref={profileSection} tabIndex={-1} aria-label={`${selectedAgent.config.name} overview`} className="border border-[var(--line)] bg-[var(--card)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <AgentAvatar agentId={selectedAgent.id} name={selectedAgent.config.name} mascotPreset={selectedAgent.config.mascotPreset} look={selectedAgent.config.look} slug={selectedAgent.slug} role={employeeRole(selectedAgent.slug, selectedAgent.config.roleTemplateId)} large />
                  <div className="min-w-0"><p className="font-mono text-[10px] uppercase text-[var(--ink-2)]">Saved profile · v{selectedAgent.version}</p><h2 className="break-words font-serif text-xl">{selectedAgent.config.name}</h2><p className="text-xs text-[var(--ink-2)]">{employeeRoleLabel(employeeRole(selectedAgent.slug, selectedAgent.config.roleTemplateId))}</p></div>
                </div>
                <button type="button" className="min-h-11 border border-[var(--line)] px-3 text-xs" onClick={() => { setSelectedAgentId(null); profileTrigger.current?.focus(); }}>Close profile</button>
              </div>
              <dl className="my-4 grid gap-3 text-xs sm:grid-cols-2">
                <div><dt className="text-[var(--ink-2)]">Harness</dt><dd className="break-words font-mono">{selectedAgent.config.harness}</dd></div>
                <div><dt className="text-[var(--ink-2)]">Model</dt><dd className="break-words font-mono">{selectedAgent.config.codingModel || "Workspace default"}</dd></div>
                <div><dt className="text-[var(--ink-2)]">Sandbox</dt><dd>{selectedAgent.config.sandboxProvider || "Organization default"}</dd></div>
                <div><dt className="text-[var(--ink-2)]">Repository</dt><dd className="break-all">{selectedAgent.config.defaultRepoUrl || "Choose when starting work"}</dd></div>
              </dl>
              <h3 className="text-xs font-medium">Instructions</h3>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-[var(--ink-2)]">{selectedAgent.config.instructions}</p>
              {!showArchived ? <button type="button" disabled={busy} onClick={() => startEdit(selectedAgent)} className="mt-3 min-h-11 border border-[var(--line)] px-3 text-xs disabled:opacity-50">Edit profile</button> : null}
            </section>
          ) : null}
          {loadError ? <LoadErrorState message={loadError} onRetry={refresh} /> : null}

          {agents === null && !loadError ? (
            <div role="status" aria-busy="true" aria-label="Loading bots">
              <SkeletonLines rows={4} />
            </div>
          ) : null}

          {agents && agents.length === 0 ? (
            <EmptyState
              title={showArchived ? "No archived bots" : "No bots"}
              detail={showArchived ? "Archived bots appear here and can be restored." : "Choose New bot to save an employee, then launch it to open a thread."}
            />
          ) : null}

          {agents && agents.length > 0 && visibleAgents?.length === 0 ? (
            <div className="border border-dashed border-[var(--line)] p-5 text-sm text-[var(--ink-2)]">
              <p>No employees match your search.</p>
              <button type="button" onClick={() => setDirectoryQuery("")} className="mt-2 min-h-11 border border-[var(--line)] px-3 text-[var(--ink)]">Clear employee search</button>
            </div>
          ) : null}
          {agents && agents.length > 0 ? (
            <ul aria-label="Saved employees" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {visibleAgents?.map((agent) => (
                <li
                  key={agent.id}
                  className="flex min-w-0 flex-col justify-between gap-4 border border-[var(--line)] bg-[var(--card)] p-4 shadow-[2px_2px_0_var(--paper-shadow)]"
                >
                  <div className="min-w-0">
                    <div className="mb-3 flex items-center gap-3"><AgentAvatar agentId={agent.id} name={agent.config.name} mascotPreset={agent.config.mascotPreset} look={agent.config.look} slug={agent.slug} role={employeeRole(agent.slug, agent.config.roleTemplateId)} /><span className="text-xs font-medium text-[var(--muted-foreground-2)]">{employeeRoleLabel(employeeRole(agent.slug, agent.config.roleTemplateId))}</span></div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" onClick={(event) => { profileTrigger.current = event.currentTarget; focusProfile.current = true; setSelectedAgentId(agent.id); }} aria-label={`View profile ${agent.config.name}`}
                        className="min-h-11 break-words text-left font-serif text-xl text-[var(--ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]">{agent.config.name}</button>
                      <span className="break-all text-[11px] font-mono text-[var(--muted-foreground-2)]">
                        {agent.slug}
                        {` · v${agent.version}`}
                      </span>
                    </div>
                    <div className="text-[11px] text-[var(--muted-foreground-2)] mt-0.5 line-clamp-2">
                      {agent.config.instructions}
                    </div>
                    <div className="break-words text-[10px] font-mono text-[var(--muted-foreground-3)] mt-1">
                      Runs on {agent.config.harness}
                      {agent.config.codingModel ? ` · ${agent.config.codingModel}` : " · Default model"}
                      {agent.config.sandboxProvider ? ` · ${agent.config.sandboxProvider}` : ""}
                    </div>
                    <p className="mt-1 break-all text-xs text-[var(--muted-foreground-2)]">Repository: {agent.config.defaultRepoUrl || "Choose a project repository when starting work"}</p>
                    {onOpenThread ? (
                      <div className="mt-3 border-t border-[var(--border-1)] pt-2">
                        <h3 className="text-[10px] font-mono text-[var(--muted-foreground-2)]">Threads started with this bot</h3>
                        {threadsLoading ? (
                          <p className="mt-1 text-xs text-[var(--muted-foreground-2)]">Loading threads…</p>
                        ) : threadsUnavailable ? (
                          <p className="mt-1 text-xs text-[var(--warning-fg)]">Thread history is unavailable. Try refreshing the page.</p>
                        ) : agentThreads(threads, agent.id).length === 0 ? (
                          <p className="mt-1 text-xs text-[var(--muted-foreground-2)]">No threads yet.</p>
                        ) : (
                          <ul aria-label={`${agent.config.name} threads`} className="mt-1 flex flex-col gap-1">
                            {agentThreads(threads, agent.id).map((thread) => (
                              <li key={thread.id}>
                                <button type="button" onClick={() => onOpenThread(thread.id)} className="flex w-full items-center gap-2 rounded-[var(--radius-button)] py-1 text-left text-xs text-[var(--fg)] hover:text-[var(--primary)]">
                                  <span className="truncate">{thread.name}</span>
                                  <span className="shrink-0 text-[10px] text-[var(--muted-foreground-3)]">{formatTimeAgo(thread.updatedAt)}</span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-2">
                    {onStartThread && !showArchived ? (
                      <button
                        type="button"
                        disabled={startingAgentId !== null || busy}
                        onClick={() => void startThread(agent)}
                        aria-label={`Launch bot ${agent.config.name}`}
                        className="min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)] text-[11px] border border-[var(--primary)] text-[var(--primary)] px-2 py-1 disabled:opacity-50"
                      >
                        {startingAgentId === agent.id ? "Launching…" : "Launch bot"}
                      </button>
                    ) : null}
                    <button type="button" disabled={busy} onClick={() => void changeLifecycle(agent, showArchived ? "restore" : "archive")}
                      aria-label={`${showArchived ? "Restore" : "Archive"} bot ${agent.config.name}`}
                      className="min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)] text-[11px] border border-[var(--border-1)] px-2 py-1 disabled:opacity-50">
                      {showArchived ? "Restore bot" : "Archive bot"}
                    </button>
                    {!showArchived ? <button
                      type="button"
                      onClick={() => startEdit(agent)}
                      className="min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)] text-[11px] border border-[var(--border-1)] px-2 py-1"
                    >
                      Edit bot
                    </button> : null}
                    {confirmDeleteId === agent.id ? (
                      <button
                        type="button"
                        onClick={() => void deleteAgent(agent.id)}
                        className="min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)] text-[11px] border border-[var(--destructive)]/40 text-[var(--destructive)] px-2 py-1"
                      >
                        Confirm delete bot
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(agent.id)}
                        className="min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)] text-[11px] border border-[var(--destructive)]/40 text-[var(--destructive)] px-2 py-1"
                      >
                        Delete bot
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {notice ? <StatusNotice tone={notice.tone}>{notice.text}</StatusNotice> : null}

          <AgentTemplatesCatalog workspaceId={workspaceId} onUse={async (template: AgentTemplate, savedConfig?: CustomAgentConfig) => {
            if (!isActive()) return;
            const response = await fetch("/api/custom-agents", { method: "POST", headers: { "Content-Type": "application/json", ...teamWorkspaceHeaders(workspaceId) }, body: JSON.stringify({ slug: savedConfig ? `${template.id.slice(0, 39)}-${crypto.randomUUID().slice(0, 8)}` : template.id, config: savedConfig ?? { name: template.name, look: defaultLookFor(template.id, template.roleTemplateId), instructions: template.instructions, harness: template.harness ?? "opencode", ...(template.roleTemplateId ? { roleTemplateId: template.roleTemplateId } : {}), ...(template.expectedDeliverables ? { expectedDeliverables: template.expectedDeliverables } : {}), ...(template.appearance ? { emoji: template.appearance } : {}) } }) });
            const body = await response.json().catch(() => ({})) as { error?: string };
            if (!isActive()) return;
            if (!response.ok) throw new Error(body.error ?? `Could not add template (${response.status}).`);
            refresh();
          }} />

          {!showArchived ? (
            <form
              className={`rounded-xl border border-[#e4e4e7] bg-white p-5 flex flex-col gap-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 ${editingId ? "" : "w-full max-w-xl self-center"}`}
              aria-busy={busy}
              onSubmit={(event) => {
                event.preventDefault();
                void saveAgent();
              }}
              onKeyDown={onFormKeyDown}
            >
              <div className="flex items-center justify-between gap-2 border-b border-[#e4e4e7] pb-3 dark:border-zinc-800">
                <div className="flex items-center gap-2.5">
                  <MascotAvatar id={editingId ?? (form.slug || form.name || "new-agent")} name={form.name || "New agent"} mascotPreset={(form.mascotPreset as CustomAgentConfig["mascotPreset"]) || undefined} look={formLook(form.lookShape, form.lookColor, form.lookEyes, form.lookAcc)} role={employeeRole(form.slug || form.name, (form.roleTemplateId as CustomAgentRoleTemplateId) || undefined)} size={32} decorative />
                  <div>
                    <h2 className="text-sm font-semibold text-[#0a0a0a] dark:text-zinc-100">
                      {editingId ? "Edit bot" : "New bot"}
                    </h2>
                    <p className="text-[11px] text-[#71717a] dark:text-zinc-400">
                      {editingId ? "Update your custom agent settings" : "Create a custom agent with standing instructions"}
                    </p>
                  </div>
                </div>
                {editingId ? (
                  <button type="button" onClick={() => resetForm()} className="text-xs text-[var(--primary)] hover:underline">
                    Cancel edit
                  </button>
                ) : hasDraft(form) ? (
                  <button type="button" disabled={busy} onClick={() => resetForm(true)} className="text-xs text-[var(--primary)] hover:underline">
                    Discard draft
                  </button>
                ) : null}
              </div>

              {!editingId && draftScope ? (
                <p role="status" className="text-xs text-[var(--muted-foreground-2)]">
                  {draftStorageAvailable ? "Draft saved only on this browser for your account. Return here after setup or reload to continue." : "Browser storage is unavailable. Keep this page open to retain your draft."}
                </p>
              ) : null}

              <fieldset disabled={busy} className="min-w-0">
              <AgentLookStyler
                id={form.slug || form.name || "new-agent"}
                role={employeeRole(form.slug || form.name, (form.roleTemplateId as CustomAgentRoleTemplateId) || undefined)}
                preset={(form.mascotPreset as CustomAgentConfig["mascotPreset"]) || undefined}
                shape={form.lookShape}
                color={form.lookColor}
                eyes={form.lookEyes}
                acc={form.lookAcc}
                onStarterPick={focusName}
                onAutomatic={() => setForm((current) => ({ ...current, mascotPreset: "", lookShape: "", lookColor: "", lookEyes: "", lookAcc: "" }))}
                onCustomize={(next) => setForm((current) => ({ ...current, mascotPreset: "", lookShape: next.shape, lookColor: next.color, lookEyes: next.eyes, lookAcc: next.acc }))}
              />
              </fieldset>

              <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                Name
                <input
                  type="text"
                  ref={nameInput}
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Research partner"
                  className={FIELD}
                />
              </label>

              <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                Instructions
                <textarea
                  value={form.instructions}
                  onChange={(e) => setForm((f) => ({ ...f, instructions: e.target.value }))}
                  placeholder="Finds evidence and challenges assumptions."
                  rows={4}
                  className={`${FIELD} resize-y min-h-[88px]`}
                />
              </label>

              {workspaceId ? (
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                    Access
                  </span>
                  <div role="radiogroup" aria-label="Agent access" className="flex h-8 w-fit items-center gap-0.5 rounded-md bg-[#f4f4f5] p-0.5 dark:bg-zinc-800/80">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={access === "only-me"}
                      onClick={() => setAccess("only-me")}
                      className={`flex h-7 items-center justify-center rounded px-3 text-[12px] font-medium transition-all ${
                        access === "only-me"
                          ? "bg-white text-[#0a0a0a] shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:bg-zinc-900 dark:text-zinc-100"
                          : "text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-200"
                      }`}
                    >
                      Only me
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={access === "workspace"}
                      onClick={() => setAccess("workspace")}
                      className={`flex h-7 items-center justify-center rounded px-3 text-[12px] font-medium transition-all ${
                        access === "workspace"
                          ? "bg-white text-[#0a0a0a] shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:bg-zinc-900 dark:text-zinc-100"
                          : "text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-200"
                      }`}
                    >
                      Everyone in this workspace
                    </button>
                  </div>
                </div>
              ) : null}

              <p className="text-xs text-[var(--muted-foreground-2)]">Create a profile first, then add a task. Creating a bot does not start a computer or a run; every task requires approval before execution.</p>

              {pendingTemplate ? (
                <div role="alertdialog" aria-modal="false" aria-labelledby={templateTitleId} aria-describedby={templateDescriptionId}
                  onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); keepCurrentDraft(); } }}
                  className="rounded-[var(--radius-button)] border border-[var(--border-2)] bg-[var(--panel)] p-3">
                  <h3 id={templateTitleId} className="text-sm font-semibold text-[var(--fg)]">Replace this draft with the {pendingTemplate.label} role?</h3>
                  <p id={templateDescriptionId} className="mt-1 text-xs text-[var(--muted-foreground-2)]">This replaces the name, slug, mark, instructions, and required deliverables in this unsaved draft. Your harness, model, connection, sandbox, and repository stay selected.</p>
                  <div className="mt-3 flex flex-wrap gap-3 text-xs">
                    <button ref={keepDraftButton} type="button" onClick={keepCurrentDraft}>Keep current draft</button>
                    <button type="button" onClick={() => applyTemplate(pendingTemplate)} className="text-[var(--primary)]">Replace draft</button>
                  </div>
                </div>
              ) : null}

              <details className="border-t border-[#e4e4e7] pt-3 dark:border-zinc-800">
                <summary className="cursor-pointer text-xs font-semibold text-[var(--fg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]">Use a role template</summary>
                <div className="mt-3 flex flex-col gap-3">
                  <fieldset className="flex flex-col gap-2">
                    <legend className="mb-1 text-xs font-semibold text-[var(--fg)]">Start from a role</legend>
                    <p className="text-xs text-[var(--muted-foreground-2)]">
                      Role templates fill an editable bot draft. Tasks produce files in an approved repository. External posting needs a supported connection and separate approval.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {EMPLOYEE_TEMPLATES.map((template) => (
                        <button key={template.id} type="button" aria-label={template.label} disabled={busy || editingId !== null}
                          onClick={(event) => chooseTemplate(template, event.currentTarget)}
                          className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--bg)] p-3 text-left disabled:opacity-50">
                          <MascotAvatar id={template.id} name={template.label} role={template.id} size={36} decorative className="mb-2" />
                          <span className="block text-xs font-medium text-[var(--fg)]">{template.label}</span>
                          <span className="mt-1 block text-[11px] text-[var(--muted-foreground-2)]">{template.description}</span>
                        </button>
                      ))}
                    </div>
                    {editingId ? <p className="text-xs text-[var(--muted-foreground-2)]">Role templates start new bots. Finish or cancel editing before choosing a role.</p> : null}
                  </fieldset>
                </div>
              </details>

              <details key={editingId ?? "new"} open={editingId ? true : undefined} className="border-t border-[#e4e4e7] pt-3 dark:border-zinc-800">
                <summary className="cursor-pointer text-xs font-semibold text-[var(--fg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)] flex items-center justify-between">
                  <span>Advanced settings</span>
                  <span className="text-[11px] font-normal text-[#71717a] dark:text-zinc-400">
                    {form.codingModel ? `${form.codingModel} · All tools` : "Default model · All tools"}
                  </span>
                </summary>
                <div className="mt-3 flex flex-col gap-3">
                  <p className="text-xs text-[var(--muted-foreground-2)]">Optional overrides. Model and sandbox availability are checked before a task is queued. Leave these settings unchanged to use existing defaults.</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                      Model
                      <input value={form.codingModel} list="custom-agent-models" placeholder="Use the harness default"
                        onChange={(event) => setForm((current) => ({ ...current, codingModel: event.target.value }))} className={FIELD} />
                      <datalist id="custom-agent-models">
                        {codingModelOptions(modelSuggestions, connections, form.connectionId).map((model) => <option key={model} value={model} />)}
                      </datalist>
                    </label>
                    <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                      Model connection
                      <select value={form.connectionId} onChange={(event) => setForm((current) => ({ ...current, connectionId: event.target.value }))} className={FIELD}>
                        <option value="">Use deployment default</option>
                        {form.connectionId && !connections.some((connection) => connection.id === form.connectionId)
                          ? <option value={form.connectionId}>Saved connection (unavailable)</option> : null}
                        {connections.filter((connection) => connection.status === "ready").map((connection) => <option key={connection.id} value={connection.id}>{connection.label}</option>)}
                      </select>
                    </label>
                  </div>
                  {editingConfig?.toolScopes?.length ? <button type="button" onClick={() => setEditingConfig((current) => current ? { ...current, toolScopes: [] } : current)} className="text-xs text-[var(--warning-fg)] text-left">
                    Custom tool grants are unsupported. Use default tool permissions to save this profile.
                  </button> : null}
                  <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                    Slug
                    <input
                      type="text"
                      value={form.slug}
                      disabled={Boolean(editingId)}
                      onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                      placeholder="security-reviewer"
                      className={FIELD}
                    />
                  </label>
                  <p className="text-xs text-[var(--muted-foreground-2)]">Slug is generated from the name when left blank. Choose a unique slug if that name is already in use.</p>
                  <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                    Mark
                    <input
                      type="text"
                      value={form.emoji}
                      onChange={(e) => setForm((f) => ({ ...f, emoji: e.target.value }))}
                      placeholder="Optional short mark"
                      className={FIELD}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                    Required deliverables
                    <textarea aria-label="Required deliverables" value={form.expectedDeliverables} onChange={(event) => setForm((current) => ({ ...current, expectedDeliverables: event.target.value }))}
                      placeholder={"reports/summary.md\nreports/sources.json"} rows={3} className={`${FIELD} resize-y`} />
                  </label>
                  <p className="text-xs text-[var(--muted-foreground-2)]">Optional: one repository path per line, up to 8 .md, .txt, .json, or .csv files. Presence and format checks confirm returned files; they do not guarantee accuracy or quality.</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                      Harness
                      <input
                        type="text"
                        value={form.harness}
                        onChange={(e) => setForm((f) => ({ ...f, harness: e.target.value }))}
                        className={FIELD}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                      Sandbox
                      <select
                        value={form.sandboxProvider}
                        onChange={(e) => setForm((f) => ({ ...f, sandboxProvider: e.target.value }))}
                        className={FIELD}
                      >
                        <option value="">Org default</option>
                        {SANDBOX_PROVIDERS.map((id) => (
                          <option key={id} value={id}>{id}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                    Default repository
                    <input
                      type="url"
                      value={form.defaultRepoUrl}
                      onChange={(e) => setForm((f) => ({ ...f, defaultRepoUrl: e.target.value }))}
                      placeholder="https://github.com/owner/repo"
                      className={`${FIELD} font-mono`}
                    />
                  </label>
                </div>
              </details>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#e4e4e7] dark:border-zinc-800">
                <button
                  type="button"
                  onClick={() => resetForm(!editingId)}
                  className="rounded-md border border-[#e4e4e7] px-3 py-1.5 text-xs font-medium text-[#71717a] hover:bg-[#f4f4f5] hover:text-[#0a0a0a] dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy || pendingTemplate !== null || !form.name.trim() || !form.instructions.trim()}
                  aria-label={editingId ? "Save changes" : "Create bot"}
                  className="rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-text)] shadow-sm hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {busy ? "Saving…" : editingId ? "Save changes" : "Create bot"}
                </button>
              </div>
              {conflict ? <button type="button" disabled={busy} onClick={() => void reloadEditingAgent()} className="self-start text-xs text-[var(--primary)]">Reload latest bot</button> : null}
            </form>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Picker options are isolated by the verified account and selected workspace. */
export function useCustomAgentOptions(enabled = true, workspaceId?: string, actorId?: string): {
  agents: CustomAgentWire[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const scope = enabled ? JSON.stringify([actorId?.trim().toLowerCase() ?? "", workspaceId ?? ""]) : "";
  const current = useRef({ scope, generation: 0 });
  const requestSequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  if (current.current.scope !== scope) {
    current.current = { scope, generation: current.current.generation + 1 };
    requestSequence.current++;
  }
  const generation = current.current.generation;
  const [state, setState] = useState<{
    scope: string; generation: number; agents: CustomAgentWire[]; loading: boolean; error: string | null;
  }>({ scope, generation, agents: [], loading: enabled, error: null });

  const refresh = useCallback(() => {
    if (!enabled || current.current.scope !== scope || current.current.generation !== generation) return;
    controller.current?.abort();
    const requestController = new AbortController();
    controller.current = requestController;
    const request = ++requestSequence.current;
    const active = () => !requestController.signal.aborted && request === requestSequence.current &&
      current.current.scope === scope && current.current.generation === generation;
    setState((previous) => ({ scope, generation,
      agents: previous.scope === scope && previous.generation === generation ? previous.agents : [],
      loading: true, error: null }));
    void fetch("/api/custom-agents", { headers: teamWorkspaceHeaders(workspaceId), signal: requestController.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return (await response.json()) as { agents?: CustomAgentWire[] };
      })
      .then((body) => {
        if (active()) setState({ scope, generation, agents: body.agents ?? [], loading: false, error: null });
      })
      .catch(() => {
        if (active()) setState({ scope, generation, agents: [], loading: false, error: "unavailable" });
      });
  }, [enabled, scope, generation, workspaceId]);

  useEffect(() => {
    if (enabled) refresh();
    return () => { controller.current?.abort(); requestSequence.current++; };
  }, [refresh, enabled]);

  const visible = enabled && state.scope === scope && state.generation === generation;
  return { agents: visible ? state.agents : [], loading: enabled && (!visible || state.loading), error: visible ? state.error : null, refresh };
}
