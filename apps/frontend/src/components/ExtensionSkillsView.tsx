import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type MouseEvent } from "react";
import {
  Archive,
  Check,
  ChevronRight,
  Eye,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Users,
  UserRound,
  X,
} from "lucide-react";
import type { ExtensionSkillRecord, ExtensionSkillScope, ExtensionSkillView } from "@shiba/shared";
import {
  ExtensionSkillRequestError,
  archiveExtensionSkill,
  createExtensionSkill,
  deleteExtensionSkill,
  fetchExtensionSkills,
  moveExtensionSkill,
  restoreExtensionSkill,
  updateExtensionSkill,
} from "../extension-skills";
import { EmptyState, type Scope } from "./ui/ContextPanel";

const VIEWS: Array<{ id: ExtensionSkillView; label: string }> = [
  { id: "personal", label: "Personal" },
  { id: "workspace", label: "Workspace" },
  { id: "archived", label: "Archived" },
];

interface FormValues {
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
}

interface DialogState {
  mode: "create" | "edit";
  skill?: ExtensionSkillRecord;
}


export function ExtensionSkillsView({
  onOpenRunSkills,
  embedded = false,
  scope = "personal",
  workspaceId,
  canManage = true,
}: {
  onOpenRunSkills?: () => void;
  embedded?: boolean;
  scope?: Scope;
  workspaceId?: string;
  canManage?: boolean;
} = {}): JSX.Element {
  const [view, setView] = useState<ExtensionSkillView>(workspaceId || scope === "workspace" ? "workspace" : "personal");
  const [skills, setSkills] = useState<ExtensionSkillRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const controller = useRef(new AbortController());
  const requestScope = () => ({ workspaceId, signal: controller.current.signal });
  useEffect(() => { const abort = new AbortController(); controller.current = abort; return () => { abort.abort(); }; }, []);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await fetchExtensionSkills(view, { workspaceId, signal: controller.current.signal });
      if (generation === loadGeneration.current) setSkills(rows);
    } catch (cause) {
      if (generation === loadGeneration.current) {
        setSkills([]);
        setDialog(null);
        setLoadError(cause instanceof Error ? cause.message : "Skills could not be loaded.");
      }
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [view, workspaceId]);

  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current += 1;
    };
  }, [load]);

  const filteredSkills = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) =>
      [skill.name, skill.description, skill.instructions]
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle)
    );
  }, [skills, query]);

  const clearRevoked = (cause: unknown) => {
    if (workspaceId && cause instanceof ExtensionSkillRequestError && [401, 403, 404].includes(cause.status)) { setSkills([]); setDialog(null); }
  };

  const save = async (values: FormValues) => {
    if (!dialog) return;
    setMutationError(null);
    try {
      if (dialog.mode === "create") {
        await createExtensionSkill({
          name: values.name || "New Skill",
          description: values.description,
          instructions: values.instructions,
          enabled: workspaceId ? false : values.enabled,
          scope: view === "workspace" ? "workspace" : "personal",
        }, requestScope());
      } else if (dialog.skill) {
        await updateExtensionSkill(dialog.skill._id, { ...values, ...(workspaceId ? { expectedVersion: dialog.skill.version } : {}) }, requestScope());
      }
      await load();
      setNotice(dialog.mode === "create" ? workspaceId ? "Team skill created disabled. Review its instructions, then enable it separately." : "Skill created." : "Skill saved.");
    } catch (cause) {
      clearRevoked(cause);
      setMutationError(cause instanceof Error ? cause.message : "Skill could not be saved.");
      throw cause;
    }
  };

  const remove = async (skill: ExtensionSkillRecord) => {
    setMutationError(null);
    try {
      await deleteExtensionSkill(skill._id, requestScope());
      await load();
      setNotice("Skill deleted.");
    } catch (cause) {
      clearRevoked(cause);
      setMutationError(cause instanceof Error ? cause.message : "Skill could not be deleted.");
      throw cause;
    }
  };

  const perform = async (skill: ExtensionSkillRecord, operation: () => Promise<void>, message: string) => {
    setBusyId(skill._id);
    setMutationError(null);
    try {
      await operation();
      await load();
      setDialog(null);
      setNotice(message);
    } catch (cause) {
      clearRevoked(cause);
      setMutationError(cause instanceof Error ? cause.message : "Skill could not be updated.");
    } finally {
      setBusyId(null);
    }
  };

  const toggle = async (skill: ExtensionSkillRecord, event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const enabled = !skill.enabled;
    setBusyId(skill._id);
    setMutationError(null);
    setNotice(null);
    setSkills((current) => current.map((item) => (item._id === skill._id ? { ...item, enabled } : item)));
    try {
      await updateExtensionSkill(skill._id, { enabled, ...(workspaceId ? { expectedVersion: skill.version } : {}) }, requestScope());
      await load();
      setNotice(enabled ? `Enabled “${skill.name}”.` : `Disabled “${skill.name}”.`);
    } catch (cause) {
      setSkills((current) => current.map((item) => item._id === skill._id ? { ...item, enabled: skill.enabled } : item));
      clearRevoked(cause);
      setMutationError(cause instanceof Error ? cause.message : "Skill state could not be saved.");
    } finally {
      setBusyId(null);
    }
  };

  const canCreate = view !== "archived" && canManage;
  const scopeCrumb = scope === "workspace" || view === "workspace" ? "Workspace" : "Personal";
  const crumbs = [scopeCrumb, "Extensions", "Skills"];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-12 min-h-[48px] shrink-0 items-center justify-between border-b border-[#e4e4e7] px-4 select-none dark:border-zinc-800">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 min-w-0">
          <ol className="flex items-center gap-1.5 min-w-0">
            {crumbs.map((crumb, idx) => {
              const isLast = idx === crumbs.length - 1;
              return (
                <li key={`${crumb}-${idx}`} className="flex items-center gap-1.5 min-w-0">
                  {idx > 0 ? (
                    <ChevronRight className="size-3.5 text-[#71717a] shrink-0 dark:text-zinc-500" strokeWidth={1.5} aria-hidden="true" />
                  ) : null}
                  <span
                    className={isLast ? "truncate text-[14px] font-medium text-[#0a0a0a] dark:text-zinc-100" : "truncate text-[14px] text-[#71717a] dark:text-zinc-400"}
                    aria-current={isLast ? "page" : undefined}
                  >
                    {crumb}
                  </span>
                </li>
              );
            })}
          </ol>
        </nav>

        <div className="flex items-center gap-2">
          {onOpenRunSkills ? (
            <button
              type="button"
              onClick={onOpenRunSkills}
              className="inline-flex min-h-11 items-center rounded-md border border-[#e4e4e7] px-2.5 text-xs font-medium text-[#71717a] hover:bg-[#f4f4f5] hover:text-[#0a0a0a] dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            >
              Run-attached skills
            </button>
          ) : null}
          {canCreate ? (
            <button
              type="button"
              onClick={() => {
                setMutationError(null);
                setDialog({ mode: "create" });
              }}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-[#0a0a0a] px-3 text-xs font-medium text-white shadow-sm hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            >
              <Plus className="size-3.5" /> New Skill
            </button>
          ) : null}
        </div>
      </header>

      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#e4e4e7] px-4 py-2.5 dark:border-zinc-800">
        <div role="tablist" aria-label="Skill scope" className="flex items-center gap-0.5 rounded-md bg-[#f4f4f5] p-0.5 dark:bg-zinc-800/80">
          {VIEWS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={view === item.id}
              className={`flex min-h-11 items-center rounded px-3 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] ${
                view === item.id
                  ? "bg-white text-[#0a0a0a] shadow-sm dark:bg-zinc-900 dark:text-zinc-100"
                  : "text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-200"
              }`}
              onClick={() => {
                setView(item.id);
                setNotice(null);
                setMutationError(null);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2.5 size-3.5 text-[#71717a] dark:text-zinc-400" />
          <input
            aria-label="Search skills"
            placeholder="Search skills…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-h-11 w-48 rounded-md border border-[#e4e4e7] bg-[#f4f4f5] pl-8 pr-2.5 text-xs text-[#0a0a0a] placeholder:text-[#71717a] focus:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 lg:px-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
          <aside aria-label="Using skills with employees" className="rounded-lg border border-[#e4e4e7] bg-[#fafafa] p-3.5 text-xs text-[#71717a] dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
            <p className="font-medium text-[#0a0a0a] dark:text-zinc-100">Skills for your employees</p>
            <p className="mt-1">
              Enabled skills can be discovered and read during Work, including connected app tasks. Personal skills stay with your account; Workspace skills are shared with workspace members. Disabled and archived skills are unavailable to agents.
            </p>
            <p className="mt-1.5">
              Review instructions before enabling them. Skills provide guidance; app connections, tool grants and human approvals are configured separately. For an approved coding run, use Run-attached skills to review, activate and pin a specific version.
            </p>
          </aside>

          {notice ? <p role="status" className="text-xs font-medium text-emerald-600 dark:text-emerald-400">{notice}</p> : null}
          {mutationError ? <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">{mutationError}</p> : null}
          {loadError ? (
            <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
              <p role="alert" className="flex-1">{loadError}</p>
              <button type="button" className="font-semibold underline min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]" disabled={loading} onClick={() => void load()}>Retry</button>
            </div>
          ) : null}

          {loading ? (
            <div role="status" className="flex min-h-52 items-center justify-center text-[#71717a]">
              <Loader2 className="size-5 animate-spin" />
              <span className="sr-only">Loading skills…</span>
            </div>
          ) : filteredSkills.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title={skills.length === 0 ? "No skills yet" : "No matching skills"}
              description={
                skills.length === 0
                  ? "Create reusable instructions that are automatically injected into every conversation"
                  : "Try another name, description, or instruction keyword."
              }
              action={
                skills.length === 0 && canCreate ? (
                  <button
                    type="button"
                    onClick={() => {
                      setMutationError(null);
                      setDialog({ mode: "create" });
                    }}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-[#0a0a0a] px-3 text-xs font-medium text-white shadow-sm hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
                  >
                    <Plus className="size-3.5" /> New Skill
                  </button>
                ) : null
              }
            />
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredSkills.map((skill) => (
                <SkillCard
                  key={skill._id}
                  skill={skill}
                  busy={busyId === skill._id}
                  onEdit={() => {
                    setMutationError(null);
                    setDialog({ mode: "edit", skill });
                  }}
                  onToggle={(event) => void toggle(skill, event)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {dialog ? (
        <SkillDialog
          key={`${dialog.mode}:${dialog.skill?._id ?? "new"}`}
          state={dialog}
          error={mutationError}
          disabledDraft={Boolean(workspaceId)}
          onClose={() => setDialog(null)}
          onSave={save}
          onDelete={remove}
          onMove={(skill, to) => perform(skill, () => moveExtensionSkill(skill._id, to, requestScope()), to === "workspace" ? "Shared with your workspace." : "Moved to Personal.")}
          onArchive={(skill) => perform(skill, () => archiveExtensionSkill(skill._id, requestScope()), "Skill archived.")}
          onRestore={(skill) => perform(skill, () => restoreExtensionSkill(skill._id, requestScope()), "Skill restored.")}
        />
      ) : null}
    </div>
  );
}

function SkillCard({
  skill,
  busy,
  onEdit,
  onToggle,
}: {
  skill: ExtensionSkillRecord;
  busy: boolean;
  onEdit: () => void;
  onToggle: (event: MouseEvent<HTMLButtonElement>) => void;
}): JSX.Element {
  const archivedScope = skill.archivedAt !== undefined ? skill.archivedFromScope ?? skill.scope ?? "personal" : skill.scope ?? "personal";
  const scopeLabel = skill.archivedAt !== undefined ? `Archived · ${archivedScope}` : archivedScope === "workspace" ? "Workspace" : "Personal";
  return (
    <li className="group relative flex min-h-48 flex-col rounded-xl border border-[#e4e4e7] bg-white p-4 shadow-sm transition-all hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400">
          <Sparkles className="size-4" strokeWidth={1.75} />
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="min-w-0 flex-1 text-left min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
        >
          <span className="block truncate text-sm font-semibold text-[#0a0a0a] dark:text-zinc-100">{skill.name || "Untitled"}</span>
          <span className="mt-0.5 line-clamp-2 block text-xs text-[#71717a] dark:text-zinc-400">{skill.description || "No description provided."}</span>
        </button>
        <span
          title={skill.enabled ? "Enabled" : "Disabled"}
          className={`mt-1 size-2 shrink-0 rounded-full ${skill.enabled ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-600"}`}
        />
      </div>

      <div className="mt-3 flex-1 rounded-md bg-[#f4f4f5] p-2.5 dark:bg-zinc-800/60">
        <p className="line-clamp-3 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[#52525b] dark:text-zinc-400">
          {skill.instructions || "No instructions yet."}
        </p>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-[#e4e4e7] pt-2.5 dark:border-zinc-800">
        <span className="truncate text-[11px] text-[#71717a] dark:text-zinc-500">
          {scopeLabel}
          {skill.version > 1 ? ` · v${skill.version}` : ""}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {skill.archivedAt === undefined && skill.permissions?.canEdit !== false ? (
            <button
              type="button"
              aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
              title={skill.enabled ? "Disable" : "Enable"}
              disabled={busy}
              onClick={onToggle}
              className="flex min-h-11 min-w-11 items-center justify-center rounded text-[#71717a] hover:bg-[#f4f4f5] hover:text-[#0a0a0a] disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            >
              {skill.enabled ? <ToggleRight className="size-4 text-emerald-600 dark:text-emerald-400" /> : <ToggleLeft className="size-4" />}
            </button>
          ) : null}
          <button
            type="button"
            aria-label={`${skill.permissions?.canEdit === false ? "View" : "Edit"} ${skill.name}`}
            title={skill.permissions?.canEdit === false ? "View" : "Edit"}
            onClick={onEdit}
            className="flex min-h-11 min-w-11 items-center justify-center rounded text-[#71717a] hover:bg-[#f4f4f5] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
          >
            {skill.permissions?.canEdit === false ? <Eye className="size-3.5" /> : <Pencil className="size-3.5" />}
          </button>
        </div>
      </div>
    </li>
  );
}

function SkillDialog({
  state,
  error,
  onClose,
  onSave,
  onDelete,
  onMove,
  onArchive,
  onRestore,
  disabledDraft = false,
}: {
  state: DialogState;
  error: string | null;
  disabledDraft?: boolean;
  onClose: () => void;
  onSave: (values: FormValues) => Promise<void>;
  onDelete: (skill: ExtensionSkillRecord) => Promise<void>;
  onMove: (skill: ExtensionSkillRecord, to: ExtensionSkillScope) => Promise<void>;
  onArchive: (skill: ExtensionSkillRecord) => Promise<void>;
  onRestore: (skill: ExtensionSkillRecord) => Promise<void>;
}): JSX.Element {
  const skill = state.skill;
  const [values, setValues] = useState<FormValues>(() => ({
    name: skill?.name ?? "",
    description: skill?.description ?? "",
    instructions: skill?.instructions ?? "",
    enabled: skill ? skill.enabled !== false : !disabledDraft,
  }));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const archived = skill?.archivedAt !== undefined;
  const scope = archived ? skill?.archivedFromScope ?? skill?.scope ?? "personal" : skill?.scope ?? "personal";
  const canEdit = !skill || skill.permissions?.canEdit !== false;
  const canMove = skill?.permissions?.canMove ?? true;
  const canArchive = skill?.permissions?.canArchive ?? true;
  const canRestore = skill?.permissions?.canRestore ?? true;
  const canDelete = skill?.permissions?.canDelete ?? true;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    if (nameRef.current?.disabled) dialogRef.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
    else { nameRef.current?.focus(); nameRef.current?.select(); }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
        .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      const first = items[0], last = items[items.length - 1];
      if (!first || !last) { event.preventDefault(); root.focus(); return; }
      if (!root.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      if (opener?.isConnected && opener !== document.body && opener !== document.documentElement) opener.focus();
    };
  }, []);

  const update = <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(values);
      setSaved(true);
      window.setTimeout(onClose, 250);
    } catch {
      // The error is handled by mutation state
    } finally {
      setSaving(false);
    }
  };

  const deleteSkill = async () => {
    if (!skill || deleting) return;
    setDeleting(true);
    try {
      await onDelete(skill);
      onClose();
    } catch {
      // Error handled by parent
    } finally {
      setDeleting(false);
    }
  };

  const scopeAction = async (operation: () => Promise<void>) => {
    if (actionBusy || !skill) return;
    setActionBusy(true);
    await operation();
    setActionBusy(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-[1px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="extension-skill-dialog-title"
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-xl flex-col rounded-xl border border-[#e4e4e7] bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-[#e4e4e7] px-5 py-3.5 dark:border-zinc-800">
          <div className="flex items-center gap-2.5">
            <div className="flex size-7 items-center justify-center rounded-md bg-[#f4f4f5] text-[#71717a] dark:bg-zinc-800 dark:text-zinc-300">
              <Pencil className="size-3.5" />
            </div>
            <div>
              <h3 id="extension-skill-dialog-title" className="text-sm font-semibold text-[#0a0a0a] dark:text-zinc-100">
                {!canEdit ? "View Skill" : state.mode === "edit" ? "Edit Skill" : "New Skill"}
              </h3>
              <p className="text-[11px] text-[#71717a] dark:text-zinc-400">
                Instructions your agents can use.
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-[#71717a] hover:bg-[#f4f4f5] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </header>

        {skill ? (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[#e4e4e7] px-5 py-2.5 bg-[#fafafa] dark:border-zinc-800 dark:bg-zinc-900/60">
            <span className="text-xs text-[#71717a] dark:text-zinc-400">
              {archived ? "Archived" : scope === "workspace" ? "Shared with the workspace" : "Only you"}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {!archived && canMove ? (
                <button
                  type="button"
                  disabled={actionBusy}
                  onClick={() =>
                    void scopeAction(() => onMove(skill, scope === "workspace" ? "personal" : "workspace"))
                  }
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-[#e4e4e7] bg-white px-2.5 text-xs text-[#0a0a0a] hover:bg-[#f4f4f5] disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
                >
                  {scope === "workspace" ? <UserRound className="size-3.5" /> : <Users className="size-3.5" />}
                  {scope === "workspace" ? "Move to Personal" : "Share to Workspace"}
                </button>
              ) : null}
              {archived
                ? canRestore ? (
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={() => void scopeAction(() => onRestore(skill))}
                      className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-[#e4e4e7] bg-white px-2.5 text-xs text-[#0a0a0a] hover:bg-[#f4f4f5] disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
                    >
                      <RotateCcw className="size-3.5" /> Restore
                    </button>
                  ) : null
                : canArchive ? (
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={() => void scopeAction(() => onArchive(skill))}
                      className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-[#e4e4e7] bg-white px-2.5 text-xs text-[#0a0a0a] hover:bg-[#f4f4f5] disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
                    >
                      <Archive className="size-3.5" /> Archive
                    </button>
                  ) : null}
            </div>
          </div>
        ) : null}

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-[#0a0a0a] dark:text-zinc-200">Name</span>
            <input
              ref={nameRef}
              aria-label="Name"
              disabled={!canEdit}
              value={values.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="My skill"
              className="min-h-11 w-full rounded-md border border-[#e4e4e7] bg-[#f4f4f5] px-2.5 text-xs text-[#0a0a0a] placeholder:text-[#71717a] focus:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-[#0a0a0a] dark:text-zinc-200">Description</span>
            <input
              aria-label="Description"
              disabled={!canEdit}
              value={values.description}
              onChange={(e) => update("description", e.target.value)}
              placeholder="What should this skill help with?"
              className="min-h-11 w-full rounded-md border border-[#e4e4e7] bg-[#f4f4f5] px-2.5 text-xs text-[#0a0a0a] placeholder:text-[#71717a] focus:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            />
          </label>

          <label className="block space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[#0a0a0a] dark:text-zinc-200">Instructions</span>
              <span className="text-[11px] text-[#71717a] dark:text-zinc-500">Markdown supported</span>
            </div>
            <textarea
              aria-label="Instructions"
              disabled={!canEdit}
              rows={8}
              value={values.instructions}
              onChange={(e) => update("instructions", e.target.value)}
              placeholder="Markdown is supported."
              className="w-full resize-y rounded-md border border-[#e4e4e7] bg-[#f4f4f5] p-2.5 font-mono text-xs leading-relaxed text-[#0a0a0a] placeholder:text-[#71717a] focus:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            />
          </label>

          <div className="flex items-center justify-between rounded-lg border border-[#e4e4e7] p-3 dark:border-zinc-800">
            <div>
              <span className="text-xs font-medium text-[#0a0a0a] dark:text-zinc-200">Active</span>
              <p className="text-[11px] text-[#71717a] dark:text-zinc-400">
                Make this skill available to your agents.
              </p>
            </div>
            {canEdit ? (
              <button
                type="button"
                role="switch"
                aria-checked={values.enabled}
                aria-label={values.enabled ? "Enabled" : "Disabled"}
                disabled={disabledDraft && !skill}
                onClick={() => update("enabled", !values.enabled)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-100 min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
              >
                {values.enabled ? (
                  <ToggleRight className="size-6 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <ToggleLeft className="size-6" />
                )}
                <span>{values.enabled ? "Enabled" : "Disabled"}</span>
              </button>
            ) : (
              <span className="text-xs text-[#71717a]">{values.enabled ? "Enabled" : "Disabled"}</span>
            )}
          </div>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[#e4e4e7] px-5 py-3 dark:border-zinc-800">
          <div>
            {skill && canDelete ? (
              <button
                type="button"
                onClick={() => void deleteSkill()}
                disabled={deleting}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
              >
                {deleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                Delete
              </button>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            {error ? <span role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
            <button
              type="button"
              onClick={onClose}
              className="inline-flex min-h-11 items-center rounded-md border border-[#e4e4e7] px-3 text-xs font-medium text-[#71717a] hover:bg-[#f4f4f5] hover:text-[#0a0a0a] dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            >
              Cancel
            </button>
            {canEdit ? (
              <button
                type="button"
                aria-label={state.mode === "edit" ? "Save" : "Create"}
                onClick={() => void submit()}
                disabled={saving}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-[#0a0a0a] px-3 text-xs font-medium text-white shadow-sm hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
              >
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : saved ? <Check className="size-3.5" /> : null}
                {saving ? "Saving…" : saved ? "Saved" : state.mode === "edit" ? "Save" : "Create skill"}
              </button>
            ) : null}
          </div>
        </footer>
      </section>
    </div>
  );
}
