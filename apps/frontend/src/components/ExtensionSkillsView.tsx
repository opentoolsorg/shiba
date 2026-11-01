import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type MouseEvent } from "react";
import { Archive, Check, Eye, Loader2, Pencil, Plus, RotateCcw, Search, Sparkles, ToggleLeft, ToggleRight, Trash2, Users, UserRound, X } from "lucide-react";
import type { ExtensionSkillRecord, ExtensionSkillScope, ExtensionSkillView } from "@shiba/shared";
import {
  archiveExtensionSkill,
  createExtensionSkill,
  deleteExtensionSkill,
  fetchExtensionSkills,
  moveExtensionSkill,
  restoreExtensionSkill,
  updateExtensionSkill,
} from "../extension-skills";

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

const CONTROL = "min-h-11 inline-flex items-center justify-center gap-2 border border-[var(--border-1)] bg-[var(--card)] px-3 text-xs font-medium text-[var(--fg)] hover:bg-[var(--secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50";
const FIELD = "min-h-11 w-full border border-[var(--border-1)] bg-[var(--input)] px-3 py-2 text-sm text-[var(--fg)] placeholder:text-[var(--muted-foreground-2)] focus:outline focus:outline-2 focus:outline-[var(--ring)]";

export function ExtensionSkillsView({ onOpenRunSkills }: { onOpenRunSkills?: () => void } = {}): JSX.Element {
  const [view, setView] = useState<ExtensionSkillView>("personal");
  const [skills, setSkills] = useState<ExtensionSkillRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await fetchExtensionSkills(view);
      if (generation === loadGeneration.current) setSkills(rows);
    } catch (cause) {
      if (generation === loadGeneration.current) {
        setLoadError(cause instanceof Error ? cause.message : "Skills could not be loaded.");
      }
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [view]);

  useEffect(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]);

  const filteredSkills = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) => [skill.name, skill.description, skill.instructions]
      .join(" ").toLocaleLowerCase().includes(needle));
  }, [skills, query]);

  const save = async (values: FormValues) => {
    if (!dialog) return;
    setMutationError(null);
    try {
      if (dialog.mode === "create") {
        await createExtensionSkill({
          name: values.name || "New Skill",
          description: values.description,
          instructions: values.instructions,
          enabled: values.enabled,
          scope: view === "workspace" ? "workspace" : "personal",
        });
      } else if (dialog.skill) {
        await updateExtensionSkill(dialog.skill._id, values);
      }
      await load();
      setNotice(dialog.mode === "create" ? "Skill created." : "Skill saved.");
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "Skill could not be saved.");
      throw cause;
    }
  };

  const remove = async (skill: ExtensionSkillRecord) => {
    setMutationError(null);
    try {
      await deleteExtensionSkill(skill._id);
      await load();
      setNotice("Skill deleted.");
    } catch (cause) {
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
      setMutationError(cause instanceof Error ? cause.message : "Skill could not be updated.");
    } finally {
      setBusyId(null);
    }
  };

  const toggle = async (skill: ExtensionSkillRecord, event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const enabled = !skill.enabled;
    setSkills((current) => current.map((item) => item._id === skill._id ? { ...item, enabled } : item));
    try {
      await updateExtensionSkill(skill._id, { enabled });
      setNotice(enabled ? `Enabled “${skill.name}”.` : `Disabled “${skill.name}”.`);
    } catch (cause) {
      // Match Overlay's optimistic toggle behavior; keep the selected state visible.
      setMutationError(cause instanceof Error ? cause.message : "Skill state could not be saved.");
    }
  };

  const canCreate = view !== "archived";

  return (
    <section aria-labelledby="extension-skills-title" className="flex min-h-0 flex-1 flex-col bg-[var(--bg)] text-[var(--fg)]">
      <header className="shrink-0 border-b border-[var(--border-1)] bg-[var(--panel)] px-4 py-4 lg:px-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="extension-skills-title" className="text-xl text-[var(--fg)]">Skills</h2>
            <p className="mt-1 max-w-2xl text-xs text-[var(--muted-foreground-2)]">
              Reusable instructions for Shiba agents. Keep skills personal or share them with your workspace.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onOpenRunSkills ? <button type="button" className={CONTROL} onClick={onOpenRunSkills}>Run-attached skills</button> : null}
            {canCreate ? (
              <button type="button" className={`${CONTROL} border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-text)] hover:opacity-90`} onClick={() => { setMutationError(null); setDialog({ mode: "create" }); }}>
                <Plus size={14} /> New Skill
              </button>
            ) : null}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div role="tablist" aria-label="Skill scope" className="flex border border-[var(--border-1)] bg-[var(--bg)]">
            {VIEWS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={view === item.id}
                className={`min-h-11 px-3 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)] ${view === item.id ? "bg-[var(--card)] font-semibold text-[var(--fg)] shadow-[var(--sh-card)]" : "text-[var(--muted-foreground-2)] hover:bg-[var(--secondary)]"}`}
                onClick={() => { setView(item.id); setNotice(null); setMutationError(null); }}
              >
                {item.label}
              </button>
            ))}
          </div>
          <label className="relative flex min-w-0 flex-1 items-center sm:max-w-xs">
            <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-3 text-[var(--muted-foreground-2)]" />
            <input aria-label="Search skills" placeholder="Search skills…" value={query} onChange={(event) => setQuery(event.target.value)} className={`${FIELD} pl-9`} />
          </label>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 lg:px-8 lg:py-7">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-3">
          {notice ? <p role="status" className="text-xs text-[var(--success)]">{notice}</p> : null}
          {mutationError ? <p role="alert" className="text-xs text-[var(--destructive)]">{mutationError}</p> : null}
          {loadError ? (
            <div className="flex items-center gap-3 border border-[var(--destructive)]/40 bg-[var(--destructive-soft)] p-3 text-xs">
              <p role="alert" className="flex-1">{loadError}</p>
              <button type="button" className="min-h-11 px-3 underline" disabled={loading} onClick={() => void load()}>Retry</button>
            </div>
          ) : null}

          {loading ? (
            <div role="status" className="flex min-h-52 items-center justify-center text-[var(--muted-foreground-2)]"><Loader2 size={20} className="animate-spin" /> <span className="sr-only">Loading skills…</span></div>
          ) : filteredSkills.length === 0 ? (
            <div className="flex min-h-64 flex-col items-center justify-center gap-3 border border-dashed border-[var(--border-2)] bg-[var(--section)] px-6 text-center">
              <Sparkles size={36} strokeWidth={1.25} className="text-[var(--muted-foreground-3)]" />
              <div>
                <p className="text-sm font-medium">{skills.length === 0 ? "No skills yet" : "No matching skills"}</p>
                <p className="mt-1 max-w-sm text-xs text-[var(--muted-foreground-2)]">
                  {skills.length === 0 ? "Create reusable instructions that Shiba agents can load when they apply." : "Try another name, description, or instruction keyword."}
                </p>
              </div>
              {skills.length === 0 && canCreate ? <button type="button" className={CONTROL} onClick={() => { setMutationError(null); setDialog({ mode: "create" }); }}><Plus size={14} /> New Skill</button> : null}
            </div>
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredSkills.map((skill) => (
                <SkillCard key={skill._id} skill={skill} busy={busyId === skill._id} onEdit={() => { setMutationError(null); setDialog({ mode: "edit", skill }); }} onToggle={(event) => void toggle(skill, event)} />
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
          onClose={() => setDialog(null)}
          onSave={save}
          onDelete={remove}
          onMove={(skill, to) => perform(skill, () => moveExtensionSkill(skill._id, to), to === "workspace" ? "Shared with your workspace." : "Moved to Personal.")}
          onArchive={(skill) => perform(skill, () => archiveExtensionSkill(skill._id), "Skill archived.")}
          onRestore={(skill) => perform(skill, () => restoreExtensionSkill(skill._id), "Skill restored.")}
        />
      ) : null}
    </section>
  );
}

function SkillCard({ skill, busy, onEdit, onToggle }: {
  skill: ExtensionSkillRecord;
  busy: boolean;
  onEdit: () => void;
  onToggle: (event: MouseEvent<HTMLButtonElement>) => void;
}): JSX.Element {
  const archivedScope = skill.archivedAt !== undefined ? skill.archivedFromScope ?? skill.scope ?? "personal" : skill.scope ?? "personal";
  const scopeLabel = skill.archivedAt !== undefined ? `Archived · ${archivedScope}` : archivedScope === "workspace" ? "Workspace" : "Personal";
  return (
    <li className="group relative flex min-h-52 flex-col border border-[var(--border-1)] bg-[var(--card)] p-4 shadow-[var(--sh-card)] transition-colors hover:border-[var(--border-2)]">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center border border-[var(--border-1)] bg-[var(--section)] text-[var(--primary)]"><Sparkles size={15} strokeWidth={1.75} /></div>
        <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]">
          <span className="block truncate text-sm font-medium text-[var(--fg)]">{skill.name || "Untitled"}</span>
          <span className="mt-1 line-clamp-2 block min-h-8 text-xs leading-relaxed text-[var(--muted-foreground-2)]">{skill.description}</span>
        </button>
        <span title={skill.enabled ? "Enabled" : "Disabled"} className={`mt-1.5 size-2 shrink-0 rounded-full ${skill.enabled ? "bg-[var(--success)]" : "bg-[var(--muted-foreground-3)]"}`} />
      </div>
      <div className="mt-3 flex-1 border-t border-[var(--border-1)] pt-3">
        <p className="line-clamp-3 whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-[var(--muted-foreground-2)]">{skill.instructions || "No instructions yet."}</p>
      </div>
      <div className="mt-3 flex min-h-11 items-center justify-between gap-2 border-t border-[var(--border-1)] pt-2">
        <span className="truncate text-[10px] text-[var(--muted-foreground-2)]">{scopeLabel}{skill.version > 1 ? ` · v${skill.version}` : ""}</span>
        <div className="flex shrink-0 items-center gap-1">
          {skill.archivedAt === undefined && skill.permissions?.canEdit !== false ? (
            <button type="button" aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`} title={skill.enabled ? "Disable" : "Enable"} disabled={busy} onClick={onToggle} className="min-h-11 min-w-11 inline-flex items-center justify-center text-[var(--muted-foreground-2)] hover:bg-[var(--secondary)] hover:text-[var(--fg)] disabled:opacity-50">
              {skill.enabled ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
            </button>
          ) : null}
          <button type="button" aria-label={`${skill.permissions?.canEdit === false ? "View" : "Edit"} ${skill.name}`} title={skill.permissions?.canEdit === false ? "View" : "Edit"} onClick={onEdit} className="min-h-11 min-w-11 inline-flex items-center justify-center text-[var(--muted-foreground-2)] hover:bg-[var(--secondary)] hover:text-[var(--fg)]">{skill.permissions?.canEdit === false ? <Eye size={14} /> : <Pencil size={14} />}</button>
        </div>
      </div>
    </li>
  );
}

function SkillDialog({ state, error, onClose, onSave, onDelete, onMove, onArchive, onRestore }: {
  state: DialogState;
  error: string | null;
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
    enabled: skill?.enabled !== false,
  }));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const archived = skill?.archivedAt !== undefined;
  const scope = archived ? skill?.archivedFromScope ?? skill?.scope ?? "personal" : skill?.scope ?? "personal";
  const canEdit = !skill || skill.permissions?.canEdit !== false;
  const canMove = skill?.permissions?.canMove ?? true;
  const canArchive = skill?.permissions?.canArchive ?? true;
  const canRestore = skill?.permissions?.canRestore ?? true;
  const canDelete = skill?.permissions?.canDelete ?? true;

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const update = <K extends keyof FormValues>(key: K, value: FormValues[K]) => setValues((current) => ({ ...current, [key]: value }));
  const submit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(values);
      setSaved(true);
      window.setTimeout(onClose, 250);
    } catch {
      // The inline error is supplied by the parent mutation state.
    } finally {
      setSaving(false);
    }
  };
  const deleteSkill = async () => {
    if (!skill || deleting) return;
    setDeleting(true);
    try { await onDelete(skill); onClose(); } catch { /* Parent displays the request error. */ }
    finally { setDeleting(false); }
  };
  const scopeAction = async (operation: () => Promise<void>) => {
    if (actionBusy || !skill) return;
    setActionBusy(true);
    await operation();
    setActionBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-[var(--overlay)] p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="extension-skill-dialog-title" className="flex max-h-[calc(100dvh-2rem)] w-full max-w-xl flex-col border border-[var(--border-2)] bg-[var(--card)] shadow-[var(--sh-sheet)]">
        <header className="flex shrink-0 items-center justify-between border-b border-[var(--border-1)] px-5 py-4">
          <h3 id="extension-skill-dialog-title" className="text-sm font-semibold">{!canEdit ? "View Skill" : state.mode === "edit" ? "Edit Skill" : "New Skill"}</h3>
          <button type="button" aria-label="Close" className="min-h-11 min-w-11 inline-flex items-center justify-center text-[var(--muted-foreground-2)] hover:bg-[var(--secondary)]" onClick={onClose}><X size={16} /></button>
        </header>

        {skill ? (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--border-1)] px-5 py-3">
            <span className="text-xs text-[var(--muted-foreground-2)]">
              {archived ? "Archived" : scope === "workspace" ? "Shared with the workspace" : "Only you"}
            </span>
            <div className="flex flex-wrap gap-2">
              {!archived && canMove ? <button type="button" disabled={actionBusy} onClick={() => void scopeAction(() => onMove(skill, scope === "workspace" ? "personal" : "workspace"))} className="min-h-11 inline-flex items-center gap-1.5 border border-[var(--border-1)] px-3 text-xs hover:bg-[var(--secondary)] disabled:opacity-50">{scope === "workspace" ? <UserRound size={13} /> : <Users size={13} />}{scope === "workspace" ? "Move to Personal" : "Share to Workspace"}</button> : null}
              {archived
                ? canRestore ? <button type="button" disabled={actionBusy} onClick={() => void scopeAction(() => onRestore(skill))} className="min-h-11 inline-flex items-center gap-1.5 border border-[var(--border-1)] px-3 text-xs hover:bg-[var(--secondary)] disabled:opacity-50"><RotateCcw size={13} /> Restore</button> : null
                : canArchive ? <button type="button" disabled={actionBusy} onClick={() => void scopeAction(() => onArchive(skill))} className="min-h-11 inline-flex items-center gap-1.5 border border-[var(--border-1)] px-3 text-xs hover:bg-[var(--secondary)] disabled:opacity-50"><Archive size={13} /> Archive</button> : null}
            </div>
          </div>
        ) : null}

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          <label className="block space-y-1.5">
            <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">Name</span>
            <input ref={nameRef} aria-label="Name" disabled={!canEdit} value={values.name} onChange={(event) => update("name", event.target.value)} placeholder="e.g. Concise Responder" className={FIELD} />
          </label>
          <label className="block space-y-1.5">
            <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">Description</span>
            <input aria-label="Description" disabled={!canEdit} value={values.description} onChange={(event) => update("description", event.target.value)} placeholder="Brief description of what this skill does" className={FIELD} />
          </label>
          <label className="block space-y-1.5">
            <span className="flex items-center justify-between gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]"><span>Instructions</span><span className="font-normal normal-case tracking-normal">Markdown supported</span></span>
            <textarea aria-label="Instructions" disabled={!canEdit} rows={12} value={values.instructions} onChange={(event) => update("instructions", event.target.value)} placeholder={"Describe what the AI should do differently when this skill is active.\n\nExample:\n- Keep answers concise\n- Use a formal tone"} className="min-h-48 w-full resize-y border border-[var(--border-1)] bg-[var(--input)] px-3 py-2.5 font-mono text-xs leading-relaxed text-[var(--fg)] placeholder:text-[var(--muted-foreground-2)] focus:outline focus:outline-2 focus:outline-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-70" />
          </label>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[var(--border-1)] px-5 py-3">
          <div className="flex flex-wrap items-center gap-3">
            {canEdit ? <button type="button" role="switch" aria-checked={values.enabled} onClick={() => update("enabled", !values.enabled)} className="min-h-11 inline-flex items-center gap-2 px-2 text-xs text-[var(--muted-foreground-2)] hover:text-[var(--fg)]">
              {values.enabled ? <ToggleRight size={18} className="text-[var(--primary)]" /> : <ToggleLeft size={18} />}{values.enabled ? "Enabled" : "Disabled"}
            </button> : <span className="min-h-11 inline-flex items-center gap-2 px-2 text-xs text-[var(--muted-foreground-2)]">{values.enabled ? "Enabled" : "Disabled"}</span>}
            {skill && canDelete ? <button type="button" onClick={() => void deleteSkill()} disabled={deleting} className="min-h-11 inline-flex items-center gap-1.5 px-2 text-xs text-[var(--muted-foreground-2)] hover:text-[var(--destructive)] disabled:opacity-50">{deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}Delete</button> : null}
          </div>
          <div className="flex items-center gap-3">
            {error ? <span role="alert" className="max-w-48 text-xs text-[var(--destructive)]">{error}</span> : null}
            {canEdit ? <button type="button" onClick={() => void submit()} disabled={saving} className={`${CONTROL} border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-text)] hover:opacity-90`}>
              {saving ? <Loader2 size={13} className="animate-spin" /> : saved ? <Check size={13} /> : null}
              {saving ? "Saving…" : saved ? "Saved" : state.mode === "edit" ? "Save" : "Create"}
            </button> : null}
          </div>
        </footer>
      </section>
    </div>
  );
}
