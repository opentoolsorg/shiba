/** Authenticated, versioned skill library. Source URLs are provenance only. */
import { useRef, useState, type JSX } from "react";
import { SkillLibraryCards } from "./SkillLibraryCards";
import {
  activateSkill,
  getSkillVersions,
  importLegacySkills,
  loadMoreSavedSkills,
  removeSkill,
  reloadSavedSkills,
  reviewSkill,
  saveSkill,
  updateSkill,
  useSavedSkills,
} from "../saved";
import { FounderSkillLibrary } from "./FounderSkillLibrary";
import { ExtensionSkillsView } from "./ExtensionSkillsView";

const FIELD =
  "bg-[var(--panel)] border border-[var(--border-1)] rounded-[var(--radius-button)] text-[var(--fg)] px-2.5 py-1.5 text-xs focus:outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]/40 placeholder-[var(--muted-foreground-3)]/60 transition-colors";

export function SkillsView({ embedded = false }: { embedded?: boolean } = {}): JSX.Element {
  const [surface, setSurface] = useState<"extensions" | "run">("extensions");
  return (
    <div className="flex h-full min-h-0 flex-1 bg-[var(--bg)] text-[var(--fg)]">
      {surface === "extensions"
        ? <ExtensionSkillsView embedded={embedded} onOpenRunSkills={() => setSurface("run")} />
        : <RunAttachedSkillsView onOpenExtensions={() => setSurface("extensions")} />}
    </div>
  );
}

function RunAttachedSkillsView({ onOpenExtensions }: { onOpenExtensions: () => void }): JSX.Element {
  const savedSkills = useSavedSkills();
  const skills = savedSkills.skills;
  const [name, setName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [instructions, setInstructions] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<{ version: number; name: string; instructions: string; sourceUrl?: string; createdAt: number }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [legacyImported, setLegacyImported] = useState<number | null>(null);
  const draftRevision = useRef(0);
  const historyGeneration = useRef(0);

  const resetForm = () => {
    draftRevision.current += 1;
    setName("");
    setSourceUrl("");
    setInstructions("");
    setEditingId(null);
    setError(null);
  };

  const saveDraft = async () => {
    if (!name.trim() || !instructions.trim()) {
      setError("Add a name and reviewed instruction text before saving a draft.");
      return;
    }
    const submittedRevision = draftRevision.current;
    const submittedDraft = { editingId, name, instructions, sourceUrl };
    setSaving(true);
    try {
      if (submittedDraft.editingId) {
        const current = skills.find((skill) => skill.id === submittedDraft.editingId);
        if (!current) throw new Error("Skill no longer exists. Reload and try again.");
        await updateSkill(submittedDraft.editingId, current.version, { name: submittedDraft.name, instructions: submittedDraft.instructions, sourceUrl: submittedDraft.sourceUrl || undefined });
      } else {
        await saveSkill({ name: submittedDraft.name, instructions: submittedDraft.instructions, sourceUrl: submittedDraft.sourceUrl || undefined });
      }
      if (draftRevision.current === submittedRevision) resetForm();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Skill could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const perform = async (id: string, operation: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try { await operation(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Skill update failed."); }
    finally { setBusyId(null); }
  };

  const toggleHistory = async (id: string) => {
    if (historyId === id) { historyGeneration.current += 1; setHistoryId(null); setHistory([]); return; }
    const generation = ++historyGeneration.current;
    setHistoryId(id);
    setHistory([]);
    setBusyId(id);
    setError(null);
    try {
      const versions = await getSkillVersions(id);
      if (historyGeneration.current === generation) setHistory(versions);
    } catch (cause) {
      if (historyGeneration.current === generation) setError(cause instanceof Error ? cause.message : "Skill history could not be loaded.");
    } finally {
      if (historyGeneration.current === generation) setBusyId(null);
    }
  };

  const loadMore = async () => {
    setSaving(true);
    try { await loadMoreSavedSkills(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "More skills could not be loaded."); }
    finally { setSaving(false); }
  };

  const retryLoad = async () => { try { await reloadSavedSkills(); } catch { /* Error is exposed by the subscribed snapshot. */ } };
  const importLegacy = async () => {
    setSaving(true);
    setError(null);
    try { setLegacyImported(await importLegacySkills()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Legacy skills could not be imported."); }
    finally { setSaving(false); }
  };

  const loadError = savedSkills.error;
  const showLoadMore = savedSkills.hasMore;

  return (
    <div className="min-h-0 flex-1 flex flex-col h-full overflow-hidden bg-[var(--bg)] text-[var(--fg)]">
      <div className="border-b border-[var(--border-1)] bg-[var(--panel)] px-4 lg:px-8 py-4 shrink-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[var(--fg)]">Run-attached skills</h2>
            <p className="text-xs text-[var(--muted-foreground-2)]">
              Versioned instruction bundles scoped to your signed-in account or workspace. Review a draft before activating it. Source links are labels only; Shiba never downloads or executes their contents.
            </p>
          </div>
          <button type="button" onClick={onOpenExtensions} className="min-h-11 border border-[var(--border-1)] bg-[var(--card)] px-3 text-xs hover:bg-[var(--secondary)]">Workspace skills</button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="max-w-3xl mx-auto flex flex-col gap-4">
          <SkillLibraryCards />
          <FounderSkillLibrary />
          <div className="rounded-[var(--radius-button)] border border-[var(--border-2)] bg-[var(--card)] p-4 flex flex-col gap-2.5 shadow-[var(--sh-overlay)]">
            <div className="text-xs font-semibold text-[var(--fg)]">{editingId ? "Create a new draft version" : "Add a draft skill"}</div>
            <input type="text" value={name} onChange={(event) => { draftRevision.current += 1; setName(event.target.value); }} placeholder="Skill name" aria-label="Skill name" className={`${FIELD} w-full`} />
            <input type="url" value={sourceUrl} onChange={(event) => { draftRevision.current += 1; setSourceUrl(event.target.value); }} placeholder="Optional HTTPS source link (provenance only)" aria-label="Skill source URL" className={`${FIELD} w-full font-mono`} />
            <textarea value={instructions} onChange={(event) => { draftRevision.current += 1; setInstructions(event.target.value); }} placeholder="Reviewed instructions to attach to runs" aria-label="Skill instructions" rows={5} maxLength={16000} className={`${FIELD} w-full resize-y`} />
            <div className="flex items-center gap-3">
              <button type="button" disabled={saving} onClick={() => void saveDraft()} className="text-[11px] bg-[var(--primary-soft)] border border-[var(--primary)]/15 text-[var(--primary)] font-medium py-1.5 px-3 rounded-[var(--radius-button)] disabled:opacity-50">
                {saving ? "Saving…" : editingId ? "Save new version" : "Save draft"}
              </button>
              {editingId ? <button type="button" onClick={resetForm} className="text-[11px] text-[var(--muted-foreground-2)]">Cancel</button> : null}
              {error ? <span role="alert" className="text-[11px] text-[var(--destructive)]">{error}</span> : null}
            </div>
          </div>

          {savedSkills.legacySkills.length > 0 ? (
            <div className="rounded-[var(--radius-button)] border border-[var(--border-2)] bg-[var(--section)] p-3 flex flex-wrap items-center gap-2 text-xs">
              <span>{savedSkills.legacySkills.length} browser-local skill{savedSkills.legacySkills.length === 1 ? "" : "s"} can be imported as unreviewed drafts. Their original local records will be kept.</span>
              <button type="button" disabled={saving} onClick={() => void importLegacy()} className="text-[11px] border border-[var(--border-1)] rounded px-2 py-1 disabled:opacity-50">Import legacy skills as drafts</button>
            </div>
          ) : null}
          {legacyImported !== null ? <p role="status" className="text-xs">Imported {legacyImported} legacy skill{legacyImported === 1 ? "" : "s"} as drafts. Review them before activation.</p> : null}
          {loadError ? <div className="flex items-center gap-2 text-xs text-[var(--destructive)]"><p role="alert">{loadError}</p><button type="button" disabled={savedSkills.loading} onClick={() => void retryLoad()} className="underline disabled:opacity-50">Retry</button></div> : null}
          {savedSkills.loading && skills.length === 0 && !loadError ? <p role="status" className="text-xs text-[var(--muted-foreground-2)]">Loading skills…</p> : null}
          {skills.length === 0 ? (
            <div className="rounded-[var(--radius-button)] border border-dashed border-[var(--border-2)] bg-[var(--section)] p-6 text-center text-xs text-[var(--muted-foreground-2)]">No skills available yet. Add one above to create a private draft.</div>
          ) : (
            <ul className="flex flex-col gap-2">
              {skills.map((skill) => (
                <li key={skill.id} className="rounded-[var(--radius-button)] border border-[var(--border-2)] bg-[var(--card)] px-4 py-3 flex flex-col gap-3 shadow-[var(--sh-card)]">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-[var(--fg)]">{skill.name}</span>
                        <span className="text-[10px] rounded-full border border-[var(--border-1)] px-2 py-0.5">{skill.status} · v{skill.version}</span>
                        {!skill.owned ? <span className="text-[10px] text-[var(--muted-foreground-2)]">Workspace</span> : null}
                      </div>
                      {skill.sourceUrl ? <div className="text-[11px] font-mono text-[var(--muted-foreground-2)] truncate mt-1">Source: {skill.sourceUrl}</div> : null}
                      {skill.activeVersion !== undefined && skill.activeVersion !== skill.version ? <div className="text-[10px] text-[var(--muted-foreground-2)]">Active version v{skill.activeVersion}</div> : null}
                    </div>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {skill.owned && skill.status !== "disabled" ? <button type="button" onClick={() => { draftRevision.current += 1; setEditingId(skill.id); setName(skill.name); setSourceUrl(skill.sourceUrl ?? ""); setInstructions(skill.instructions); }} className="text-[10px] border border-[var(--border-1)] rounded px-2 py-1">Edit</button> : null}
                      <button type="button" onClick={() => void toggleHistory(skill.id)} className="text-[10px] border border-[var(--border-1)] rounded px-2 py-1">{historyId === skill.id ? "Hide history" : "Versions"}</button>
                      {skill.owned && skill.status === "draft" ? <button type="button" disabled={busyId === skill.id} onClick={() => void perform(skill.id, () => reviewSkill(skill.id, skill.version, skill.instructions))} className="text-[10px] border border-[var(--border-1)] rounded px-2 py-1 disabled:opacity-50">Mark reviewed</button> : null}
                      {skill.owned && skill.status === "review" ? <button type="button" disabled={busyId === skill.id} onClick={() => void perform(skill.id, () => activateSkill(skill.id, skill.version, skill.instructions))} className="text-[10px] border border-[var(--primary)]/30 text-[var(--primary)] rounded px-2 py-1 disabled:opacity-50">Activate reviewed version</button> : null}
                      {skill.owned && skill.status !== "disabled" ? <button type="button" disabled={busyId === skill.id} onClick={() => void perform(skill.id, () => removeSkill(skill.id))} className="text-[10px] border border-[var(--border-1)] rounded px-2 py-1 disabled:opacity-50">Disable</button> : null}
                    </div>
                  </div>
                  <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">{skill.instructions || "No instructions saved."}</pre>
                  {historyId === skill.id ? <ol className="border-t border-[var(--border-1)] pt-2 flex flex-col gap-2">{history.map((version) => <li key={version.version} className="text-[10px]"><strong>v{version.version} · {version.name}</strong><pre className="whitespace-pre-wrap break-words mt-1 text-[var(--muted-foreground-2)]">{version.instructions}</pre></li>)}</ol> : null}
                </li>
              ))}
            </ul>
          )}
          {showLoadMore ? <button type="button" disabled={saving} onClick={() => void loadMore()} className="self-center text-[11px] border border-[var(--border-1)] rounded px-3 py-1.5 disabled:opacity-50">Load more skills</button> : null}
        </div>
      </div>
    </div>
  );
}
