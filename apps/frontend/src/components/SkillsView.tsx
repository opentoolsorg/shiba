/** Authenticated, versioned skill library. Source URLs are provenance only. */
import { useEffect, useEffectEvent, useRef, useState, type JSX } from "react";
import { teamWorkspaceHeaders, TeamWorkspaceRequestError } from "../team-workspaces-client";
import type { LibrarySkillCard, SavedSkill } from "../saved";
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

export function SkillsView({ embedded = false, workspaceId, actorId, workspaceRole }: { embedded?: boolean; workspaceId?: string; actorId?: string | null; workspaceRole?: "owner" | "admin" | "member" } = {}): JSX.Element {
  const scope = `${actorId ?? ""}\0${workspaceId ?? ""}`;
  const current = useRef(scope); current.current = scope;
  return workspaceId ? <TeamSkillsSurface key={scope} workspaceId={workspaceId} isCurrent={() => current.current === scope} canManage={workspaceRole === "owner" || workspaceRole === "admin"} /> : <PersonalSkillsView key={scope} embedded={embedded} />;
}

function TeamSkillsSurface({ workspaceId, isCurrent, canManage }: { workspaceId: string; isCurrent: () => boolean; canManage: boolean }): JSX.Element {
  const [surface, setSurface] = useState<"run" | "extensions">("run");
  return <div className="flex h-full min-h-0 flex-1 flex-col"><nav aria-label="Team skill types" className="flex flex-wrap gap-2 border-b border-[var(--line)] p-3"><button type="button" aria-pressed={surface === "run"} className={TEAM_CONTROL} onClick={() => setSurface("run")}>Run-attached skills</button><button type="button" aria-pressed={surface === "extensions"} className={TEAM_CONTROL} onClick={() => setSurface("extensions")}>Team instruction skills</button></nav>{surface === "run" ? <TeamSkillReview workspaceId={workspaceId} isCurrent={isCurrent} canManage={canManage} /> : <ExtensionSkillsView workspaceId={workspaceId} canManage={canManage} />}</div>;
}

function PersonalSkillsView({ embedded }: { embedded: boolean }): JSX.Element {
  const [surface, setSurface] = useState<"extensions" | "run">("extensions");
  return (
    <div className="flex h-full min-h-0 min-w-0 w-full flex-1 bg-[var(--bg)] text-[var(--fg)]">
      {surface === "extensions"
        ? <ExtensionSkillsView embedded={embedded} onOpenRunSkills={() => setSurface("run")} />
        : <RunAttachedSkillsView onOpenExtensions={() => setSurface("extensions")} />}
    </div>
  );
}

interface TeamSkillVersion { version: number; name: string; instructions: string }
const TEAM_CONTROL = "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 text-xs text-[var(--ink)] hover:bg-[var(--panel-2)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
const TEAM_FIELD = "min-h-11 w-full border border-[var(--input-line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";

/** Team drafts never enter the legacy module-global personal skill cache. */
function TeamSkillReview({ workspaceId, isCurrent, canManage }: { workspaceId: string; isCurrent: () => boolean; canManage: boolean }): JSX.Element {
  const [skills, setSkills] = useState<SavedSkill[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [editing, setEditing] = useState<SavedSkill | null>(null);
  const [library, setLibrary] = useState<LibrarySkillCard[] | null>(null);
  const draftRevision = useRef(0);
  const [history, setHistory] = useState<{ id: string; versions: TeamSkillVersion[] } | null>(null);
  const historyEpoch = useRef(0);
  const requestEpoch = useRef(0);
  const alive = useRef(true);
  const controller = useRef(new AbortController());
  const active = () => alive.current && isCurrent() && !controller.current.signal.aborted;

  const request = async <T,>(url: string, method = "GET", body?: unknown): Promise<T> => {
    if (!active()) throw new DOMException("Workspace changed.", "AbortError");
    const response = await fetch(url, { method, credentials: "same-origin", cache: "no-store", signal: controller.current.signal,
      headers: { ...teamWorkspaceHeaders(workspaceId), ...body !== undefined ? { "Content-Type": "application/json" } : {} },
      ...body !== undefined ? { body: JSON.stringify(body) } : {} });
    const payload = await response.json().catch(() => ({})) as T & { error?: unknown };
    if (!active()) throw new DOMException("Workspace changed.", "AbortError");
    if (!response.ok) throw new TeamWorkspaceRequestError(typeof payload.error === "string" ? payload.error : `Skill request failed (${response.status}).`, response.status);
    return payload;
  };
  const load = async (nextCursor?: string) => {
    const epoch = ++requestEpoch.current;
    setLoading(true);
    try {
      const body = await request<{ skills: SavedSkill[]; nextCursor?: string }>(`/api/skills?limit=25${nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : ""}`);
      if (!active() || epoch !== requestEpoch.current) return;
      if (!Array.isArray(body.skills)) throw new Error("Invalid skill response.");
      setSkills((previous) => nextCursor ? [...new Map([...previous, ...body.skills].map((skill) => [skill.id, skill])).values()] : body.skills);
      setCursor(typeof body.nextCursor === "string" ? body.nextCursor : null); setError(null);
    } catch (cause) {
      if (active() && epoch === requestEpoch.current) { setSkills([]); setCursor(null); setHistory(null); setError(cause instanceof Error ? cause.message : "Skills unavailable."); }
    } finally { if (active() && epoch === requestEpoch.current) setLoading(false); }
  };
  const initialLoad = useEffectEvent(() => { void load(); });
  useEffect(() => {
    alive.current = true; const abort = new AbortController(); controller.current = abort;
    initialLoad();
    return () => { alive.current = false; requestEpoch.current++; historyEpoch.current++; abort.abort(); };
    // A keyed mount owns the workspace's local data and all pending requests.
  }, []);

  const perform = async (operation: () => Promise<void>) => {
    if (!active() || pending.current) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null); requestEpoch.current++;
    try { await operation(); }
    catch (cause) {
      if (active()) {
        setHistory(null);
        if (cause instanceof TeamWorkspaceRequestError && [401, 403, 404].includes(cause.status)) { setSkills([]); setCursor(null); setLibrary(null); setEditing(null); setName(""); setInstructions(""); }
        setError(cause instanceof Error ? cause.message : "Skill update failed.");
      }
    } finally { if (active()) { pending.current = false; setBusy(false); setLoading(false); } }
  };
  const changeStatus = (skill: SavedSkill, action: "review" | "activate" | "disable") => {
    if (!canManage || !skill.owned) return;
    void perform(async () => {
      const body = await request<{ skill?: SavedSkill }>(`/api/skills/${encodeURIComponent(skill.id)}/${action}`, "POST", action === "disable" ? undefined : { version: skill.version, reviewedInstructions: skill.instructions });
      if (!active()) return;
      if (action !== "disable" && (!body.skill || body.skill.id !== skill.id)) throw new Error("The skill update could not be verified. Refresh before continuing.");
      setSkills((previous) => previous.map((item) => item.id === skill.id ? body.skill ?? { ...item, status: "disabled", activeVersion: undefined } : item));
      setNotice(action === "activate" ? "Reviewed version activated. No app permissions or external actions were granted." : action === "review" ? "Instructions marked reviewed. Activation still requires a separate click." : "Skill disabled.");
    });
  };
  const save = () => {
    if (!canManage || !name.trim() || !instructions.trim()) return;
    const revision = draftRevision.current;
    void perform(async () => {
      const body = await request<{ skill: SavedSkill }>(editing ? `/api/skills/${encodeURIComponent(editing.id)}` : "/api/skills", editing ? "PATCH" : "POST", {
        name: name.trim(), instructions: instructions.trim(),
        ...(editing ? { expectedVersion: editing.version, ...(editing.sourceUrl ? { sourceUrl: editing.sourceUrl } : {}) } : {}),
      });
      if (!active()) return;
      if (!body.skill?.id || body.skill.status !== "draft") throw new Error("A draft skill could not be verified. Refresh before continuing.");
      setSkills((previous) => editing ? previous.map((skill) => skill.id === body.skill.id ? body.skill : skill) : [...previous, body.skill]);
      if (revision === draftRevision.current) { setEditing(null); setName(""); setInstructions(""); }
      setNotice("Draft saved in this workspace. Review its instructions before activation.");
    });
  };
  const browseLibrary = () => { void perform(async () => {
    const body = await request<{ skills: LibrarySkillCard[] }>("/api/skills/library");
    if (!Array.isArray(body.skills)) throw new Error("Skill library unavailable.");
    if (active()) setLibrary(body.skills);
  }); };
  const installTemplate = (slug: string) => { void perform(async () => {
    const body = await request<{ skill?: { status: string } }>(`/api/skills/library/${encodeURIComponent(slug)}/install`, "POST");
    if (body.skill?.status !== "draft") throw new Error("The installed skill must be reviewed in Saved skills before use.");
    await load();
    const refreshed = await request<{ skills: LibrarySkillCard[] }>("/api/skills/library");
    if (active()) { setLibrary(refreshed.skills); setNotice("Template installed as a team draft. Review and activate it separately."); }
  }); };
  const versions = (skill: SavedSkill) => {
    if (pending.current) return;
    if (history?.id === skill.id) { historyEpoch.current++; setHistory(null); return; }
    const epoch = ++historyEpoch.current; setHistory(null);
    void perform(async () => {
      const body = await request<{ versions: TeamSkillVersion[] }>(`/api/skills/${encodeURIComponent(skill.id)}/versions?limit=20`);
      if (!active() || epoch !== historyEpoch.current) return;
      if (!Array.isArray(body.versions)) throw new Error("Skill history unavailable.");
      setHistory({ id: skill.id, versions: body.versions });
    });
  };

  return <section aria-label="Team skill review" className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-[var(--paper)] text-[var(--ink)]">
    <header className="border-b border-[var(--line)] p-4 sm:px-7"><p className="font-mono text-[10px] uppercase tracking-widest text-[var(--ink-2)]">Workspace instructions · deliberate activation</p><h2 className="mt-1 text-xl">Team run-attached skills</h2><p className="mt-2 max-w-3xl text-sm text-[var(--ink-2)]">Review imported employee bundle drafts here. These records stay in the selected team workspace; they are not your personal skill library. Only the skill owner can review, activate or disable it. Activation grants no app access and starts no work.</p></header>
    <div className="mx-auto grid w-full max-w-4xl gap-4 p-4 sm:p-7">
      {error && <p role="alert" className="border border-[var(--danger)] p-3 text-sm text-[var(--danger)]">{error}</p>}{notice && <p role="status" className="border border-[var(--line)] p-3 text-sm">{notice}</p>}
      <div className="border border-[var(--line)] bg-[var(--card)] p-4"><h3 className="text-lg">{editing ? `Edit version ${editing.version}` : "Add a team draft"}</h3><label className="mt-3 block text-xs">Skill name<input className={`${TEAM_FIELD} mt-1`} value={name} maxLength={100} onChange={(event) => { draftRevision.current++; setName(event.target.value); }} /></label><label className="mt-3 block text-xs">Skill instructions<textarea className={`${TEAM_FIELD} mt-1 min-h-28`} value={instructions} maxLength={16000} onChange={(event) => { draftRevision.current++; setInstructions(event.target.value); }} /></label><button type="button" className={`${TEAM_CONTROL} mt-3`} disabled={!canManage || busy || !name.trim() || !instructions.trim()} onClick={save}>{editing ? "Save new draft version" : "Save draft"}</button>{editing && <button type="button" className={`${TEAM_CONTROL} mt-3 ml-2`} disabled={busy} onClick={() => { draftRevision.current++; setEditing(null); setName(""); setInstructions(""); }}>Cancel edit</button>}</div>
      <section aria-label="Team skill templates" className="border border-[var(--line)] bg-[var(--card)] p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-lg">Curated templates</h3><button type="button" className={TEAM_CONTROL} disabled={busy} onClick={browseLibrary}>Browse team skill templates</button></div><p className="mt-2 text-xs text-[var(--ink-2)]">Install a draft in this workspace. Templates grant no tools or access and require separate review and activation.</p>{library && <ul className="mt-3 grid gap-3 sm:grid-cols-2">{library.map((entry) => <li key={entry.slug} className="border border-[var(--line)] p-3"><h4 className="text-sm font-semibold">{entry.name}</h4><p className="mt-1 text-xs text-[var(--ink-2)]">{entry.summary}</p><p className="mt-1 font-mono text-[10px]">Template v{entry.version}</p><button type="button" className={`${TEAM_CONTROL} mt-2`} disabled={!canManage || busy || entry.installed} onClick={() => installTemplate(entry.slug)}>{entry.installed ? `Installed · ${entry.installedStatus ?? "draft"}` : "Install team draft"}</button></li>)}</ul>}</section>
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-lg">Saved skills</h3><button type="button" className={TEAM_CONTROL} disabled={busy || loading} onClick={() => { setHistory(null); void load(); }}>Refresh skills</button></div>
      {loading && skills.length === 0 ? <p role="status">Loading workspace skills…</p> : skills.length === 0 ? <p className="border border-dashed border-[var(--line)] p-5 text-sm text-[var(--ink-2)]">No skills available in this workspace. Import an employee bundle or save a draft above.</p> : <ul className="grid gap-3">{skills.map((skill) => <li key={skill.id} className="min-w-0 border border-[var(--line)] bg-[var(--card)] p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h4 className="text-sm font-semibold">{skill.name}</h4><p className="mt-1 font-mono text-[10px] text-[var(--ink-2)]">{skill.status} · v{skill.version}{!skill.owned ? " · shared active version" : " · owned by you"}</p></div><div className="flex flex-wrap gap-2">{canManage && skill.owned && <button type="button" className={TEAM_CONTROL} disabled={busy} onClick={() => { draftRevision.current++; setEditing(skill); setName(skill.name); setInstructions(skill.instructions); setHistory(null); setNotice("Saving creates a new draft version. Review and activation are required again."); }}>Edit version</button>}<button type="button" className={TEAM_CONTROL} disabled={busy} onClick={() => versions(skill)}>{history?.id === skill.id ? "Hide history" : "Versions"}</button>{canManage && skill.owned && skill.status === "draft" && <button type="button" className={TEAM_CONTROL} disabled={busy} onClick={() => changeStatus(skill, "review")}>Mark reviewed</button>}{canManage && skill.owned && skill.status === "review" && <button type="button" className={TEAM_CONTROL} disabled={busy} onClick={() => changeStatus(skill, "activate")}>Activate reviewed version</button>}{canManage && skill.owned && skill.status !== "disabled" && <button type="button" className={TEAM_CONTROL} disabled={busy} onClick={() => changeStatus(skill, "disable")}>Disable</button>}</div></div><pre className="mt-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--ink-2)]">{skill.instructions}</pre>{history?.id === skill.id && <ol className="mt-3 grid gap-2 border-t border-[var(--line)] pt-3">{history.versions.map((version) => <li key={version.version}><p className="font-mono text-[10px]">v{version.version} · {version.name}</p><pre className="mt-1 whitespace-pre-wrap break-words text-xs text-[var(--ink-2)]">{version.instructions}</pre></li>)}</ol>}</li>)}</ul>}
      {cursor && <button type="button" className={TEAM_CONTROL} disabled={busy || loading} onClick={() => { void load(cursor); }}>Load more skills</button>}
      <p className="text-xs text-[var(--ink-2)]">Templates and edited instructions remain workspace-scoped drafts until explicitly reviewed and activated. Personal instructions are not copied here. Provider setup is separate from skill activation.</p>
    </div>
  </section>;
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
    <div className="min-h-0 min-w-0 w-full flex-1 flex flex-col h-full overflow-hidden bg-[var(--bg)] text-[var(--fg)]">
      <div className="min-w-0 border-b border-[var(--border-1)] bg-[var(--panel)] px-4 lg:px-8 py-4 shrink-0">
        <div className="flex min-w-0 flex-col items-start justify-between gap-3 sm:flex-row">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-[var(--fg)]">Run-attached skills</h2>
            <p className="text-xs text-[var(--muted-foreground-2)]">
              Versioned instruction bundles scoped to your signed-in account or workspace. Review a draft before activating it. Source links are labels only; Shiba never downloads or executes their contents.
            </p>
          </div>
          <button type="button" onClick={onOpenExtensions} className="min-h-11 max-w-full shrink-0 border border-[var(--border-1)] bg-[var(--card)] px-3 text-xs hover:bg-[var(--secondary)]">Workspace skills</button>
        </div>
      </div>

      <div className="min-h-0 min-w-0 w-full flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="min-w-0 w-full max-w-3xl mx-auto flex flex-col gap-4">
          <SkillLibraryCards />
          <FounderSkillLibrary />
          <div className="rounded-[var(--radius-button)] border border-[var(--border-2)] bg-[var(--card)] p-4 flex flex-col gap-2.5 shadow-[var(--sh-overlay)]">
            <div className="text-xs font-semibold text-[var(--fg)]">{editingId ? "Create a new draft version" : "Add a draft skill"}</div>
            <input type="text" value={name} onChange={(event) => { draftRevision.current += 1; setName(event.target.value); }} placeholder="Skill name" aria-label="Skill name" className={`${FIELD} w-full`} />
            <input type="url" value={sourceUrl} onChange={(event) => { draftRevision.current += 1; setSourceUrl(event.target.value); }} placeholder="Optional HTTPS source link (provenance only)" aria-label="Skill source URL" className={`${FIELD} w-full font-mono`} />
            <textarea value={instructions} onChange={(event) => { draftRevision.current += 1; setInstructions(event.target.value); }} placeholder="Reviewed instructions to attach to runs" aria-label="Skill instructions" rows={5} maxLength={16000} className={`${FIELD} w-full resize-y`} />
            <div className="flex min-w-0 flex-wrap items-center gap-3">
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
                  <div className="flex min-w-0 flex-col items-start justify-between gap-3 sm:flex-row">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-[var(--fg)]">{skill.name}</span>
                        <span className="text-[10px] rounded-full border border-[var(--border-1)] px-2 py-0.5">{skill.status} · v{skill.version}</span>
                        {!skill.owned ? <span className="text-[10px] text-[var(--muted-foreground-2)]">Workspace</span> : null}
                      </div>
                      {skill.sourceUrl ? <div className="text-[11px] font-mono text-[var(--muted-foreground-2)] truncate mt-1">Source: {skill.sourceUrl}</div> : null}
                      {skill.activeVersion !== undefined && skill.activeVersion !== skill.version ? <div className="text-[10px] text-[var(--muted-foreground-2)]">Active version v{skill.activeVersion}</div> : null}
                    </div>
                    <div className="flex min-w-0 max-w-full flex-wrap gap-1.5 sm:justify-end">
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
