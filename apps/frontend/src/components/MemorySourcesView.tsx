/** Owner-scoped, self-hostable memory notes and source references. */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type JSX } from "react";

type SourceKind = "note" | "document" | "conversation" | "reference" | "other";
interface MemorySource {
  id: string;
  title: string;
  content: string;
  kind: SourceKind;
  referenceUrl: string | null;
  createdAt: number;
  updatedAt: number;
  retentionDays: number | null;
  expiresAt: number | null;
  disabledAt: number | null;
}
interface MemoryHit extends MemorySource {
  score: number;
  trust: "untrusted";
  context: string;
}
interface MemoryProject {
  id: string;
  name: string;
  purpose: string;
  sourceIds: string[];
  defaultCustomAgentId: string | null;
  defaultHarness: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  disabledAt: number | null;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok)
    throw new Error(
      typeof body.error === "string" ? body.error : `Request failed: ${response.status}`,
    );
  return body;
}

const FIELD =
  "w-full border border-[var(--line)] bg-[var(--paper)] px-2.5 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--ink-2)] focus:outline-none focus:border-[var(--navy)]";
const BUTTON =
  "border border-[var(--line)] bg-[var(--card)] px-3 py-1.5 text-xs text-[var(--ink)] shadow-[2px_2px_0_var(--paper-shadow)] hover:bg-[var(--panel-2)] disabled:opacity-50";
const PRIMARY =
  "border border-[var(--navy)] bg-[var(--navy)] px-3 py-1.5 text-xs text-white shadow-[2px_2px_0_var(--paper-shadow)] hover:bg-[var(--navy-2)] disabled:opacity-50";
const KINDS: SourceKind[] = ["note", "document", "conversation", "reference", "other"];

export function MemorySourcesView(): JSX.Element {
  const [sources, setSources] = useState<MemorySource[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<SourceKind>("note");
  const [referenceUrl, setReferenceUrl] = useState("");
  const [retentionDays, setRetentionDays] = useState("365");
  const [editing, setEditing] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MemoryHit[]>([]);
  const [searchActive, setSearchActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [projects, setProjects] = useState<MemoryProject[]>([]);
  const [projectEditing, setProjectEditing] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectPurpose, setProjectPurpose] = useState("");
  const [projectSourceIds, setProjectSourceIds] = useState<string[]>([]);
  const [projectAgent, setProjectAgent] = useState("");
  const [projectHarness, setProjectHarness] = useState("");

  const load = useCallback(async () => {
    try {
      const body = await apiJson<{ sources?: MemorySource[] }>("/api/memory/sources");
      setSources(Array.isArray(body.sources) ? body.sources : []);
      const projectBody = await apiJson<{ projects?: MemoryProject[] }>("/api/memory/projects");
      setProjects(Array.isArray(projectBody.projects) ? projectBody.projects : []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Memory sources could not be loaded.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const resetForm = () => {
    setEditing(null);
    setTitle("");
    setContent("");
    setKind("note");
    setReferenceUrl("");
    setRetentionDays("365");
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const retention = retentionDays === "manual" ? null : Number(retentionDays);
      const payload = {
        title,
        content,
        kind,
        referenceUrl: referenceUrl || null,
        retentionDays: retention,
      };
      await apiJson(
        editing ? `/api/memory/sources/${encodeURIComponent(editing)}` : "/api/memory/sources",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      resetForm();
      await load();
      setNotice(editing ? "Memory source updated." : "Memory source saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Memory source could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const edit = (source: MemorySource) => {
    setEditing(source.id);
    setTitle(source.title);
    setContent(source.content);
    setKind(source.kind);
    setReferenceUrl(source.referenceUrl ?? "");
    setRetentionDays(source.retentionDays === null ? "manual" : String(source.retentionDays));
    setNotice(null);
  };

  const setEnabled = async (source: MemorySource) => {
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/api/memory/sources/${encodeURIComponent(source.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: source.disabledAt !== null }),
      });
      await load();
      setNotice(
        source.disabledAt === null
          ? "Source disabled; it is excluded from recall."
          : "Source enabled for recall.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Source status could not be changed.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (source: MemorySource) => {
    if (!window.confirm(`Permanently delete “${source.title}” and its text from Shiba memory?`))
      return;
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/api/memory/sources/${encodeURIComponent(source.id)}`, { method: "DELETE" });
      await load();
      setNotice("Source and stored text permanently deleted.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Source could not be deleted.");
    } finally {
      setBusy(false);
    }
  };

  const recall = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = await apiJson<{ hits?: MemoryHit[] }>(
        `/api/memory/recall?q=${encodeURIComponent(query)}`,
      );
      setHits(Array.isArray(body.hits) ? body.hits : []);
      setSearchActive(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Memory recall failed.");
    } finally {
      setBusy(false);
    }
  };

  const resetProject = () => {
    setProjectEditing(null);
    setProjectName("");
    setProjectPurpose("");
    setProjectSourceIds([]);
    setProjectAgent("");
    setProjectHarness("");
  };
  const saveProject = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const payload = {
        name: projectName,
        purpose: projectPurpose,
        sourceIds: projectSourceIds,
        defaultCustomAgentId: projectAgent || null,
        defaultHarness: projectHarness || null,
      };
      await apiJson(
        projectEditing
          ? `/api/memory/projects/${encodeURIComponent(projectEditing)}`
          : "/api/memory/projects",
        {
          method: projectEditing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      resetProject();
      await load();
      window.dispatchEvent(new Event("shiba:projects-updated"));
      setNotice(projectEditing ? "Project updated." : "Project saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Project could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  const editProject = (project: MemoryProject) => {
    setProjectEditing(project.id);
    setProjectName(project.name);
    setProjectPurpose(project.purpose);
    setProjectSourceIds(project.sourceIds);
    setProjectAgent(project.defaultCustomAgentId ?? "");
    setProjectHarness(project.defaultHarness ?? "");
  };
  const deleteProject = async (project: MemoryProject) => {
    if (!window.confirm(`Delete project “${project.name}”? Approved task snapshots are unchanged.`))
      return;
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/api/memory/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
      await load();
      window.dispatchEvent(new Event("shiba:projects-updated"));
      setNotice("Project deleted. Existing approved snapshots remain unchanged.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Project could not be deleted.");
    } finally {
      setBusy(false);
    }
  };

  const activeCount = useMemo(
    () =>
      sources.filter(
        (source) =>
          source.disabledAt === null &&
          (source.expiresAt === null || source.expiresAt > Date.now()),
      ).length,
    [sources],
  );

  return (
    <section
      aria-label="Workspace memory sources"
      className="flex flex-col gap-4 text-[var(--ink)]"
    >
      <header className="border border-[var(--line)] bg-[var(--card)] shadow-[2px_2px_0_var(--paper-shadow)]">
        <div className="flex items-center justify-between border-b border-[var(--line)] bg-[var(--paper-title)] px-3 py-2 text-xs font-mono text-[var(--paper-title-fg)]">
          <span>WORKSPACE MEMORY · OWNER PRIVATE</span>
          <button className="text-[10px] underline" onClick={() => void load()} type="button">
            Sync
          </button>
        </div>
        <div className="p-3 text-sm">
          <p>
            Private text memory is stored in Shiba’s local SQLite-backed Durable Object. Retrieval
            uses local keyword ranking; source text is treated as untrusted reference data.
          </p>
          <p className="mt-1 text-xs text-[var(--ink-2)]">
            {activeCount} active sources · default retention is 365 days · “Keep until deleted”
            removes the expiry.
          </p>
        </div>
      </header>

      {error ? (
        <div
          role="alert"
          className="border border-[var(--danger)] p-2 text-sm text-[var(--danger)]"
        >
          {error}
        </div>
      ) : null}
      {notice ? (
        <div role="status" className="border border-[var(--ok)] p-2 text-sm text-[var(--ok)]">
          {notice}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
        <form
          onSubmit={(event) => void save(event)}
          className="flex flex-col gap-2 border border-[var(--line)] bg-[var(--card)] p-3 shadow-[2px_2px_0_var(--paper-shadow)]"
        >
          <h3 className="font-serif text-lg">{editing ? "Edit source" : "Add to memory"}</h3>
          <label className="text-xs font-mono">
            TITLE
            <input
              required
              maxLength={200}
              className={`${FIELD} mt-1`}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="text-xs font-mono">
            SOURCE TYPE
            <select
              className={`${FIELD} mt-1`}
              value={kind}
              onChange={(event) => setKind(event.target.value as SourceKind)}
            >
              {KINDS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-mono">
            TEXT TO REMEMBER
            <textarea
              required
              maxLength={40_000}
              rows={7}
              className={`${FIELD} mt-1 resize-y font-sans`}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="Paste a note or the relevant text here. Shiba does not fetch linked pages."
            />
          </label>
          <label className="text-xs font-mono">
            REFERENCE URL{" "}
            <span className="font-sans text-[var(--ink-2)]">
              (optional provenance link; never fetched)
            </span>
            <input
              type="url"
              pattern="https://.*"
              className={`${FIELD} mt-1 font-sans`}
              value={referenceUrl}
              onChange={(event) => setReferenceUrl(event.target.value)}
              placeholder="https://…"
            />
          </label>
          <label className="text-xs font-mono">
            RETENTION
            <select
              className={`${FIELD} mt-1`}
              value={retentionDays}
              onChange={(event) => setRetentionDays(event.target.value)}
            >
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">365 days (default)</option>
              <option value="730">2 years</option>
              <option value="manual">Keep until deleted</option>
            </select>
          </label>
          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={busy} className={PRIMARY}>
              {busy ? "Saving…" : editing ? "Save changes" : "Add source"}
            </button>
            {editing ? (
              <button type="button" className={BUTTON} onClick={resetForm}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>

        <div className="flex flex-col gap-3">
          <form
            onSubmit={(event) => void recall(event)}
            className="flex flex-col gap-2 border border-[var(--line)] bg-[var(--card)] p-3 shadow-[2px_2px_0_var(--paper-shadow)]"
          >
            <h3 className="font-serif text-lg">Recall from memory</h3>
            <label className="text-xs font-mono">
              QUERY
              <input
                required
                className={`${FIELD} mt-1 font-sans`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search these private sources"
              />
            </label>
            <div className="flex gap-2">
              <button disabled={busy} className={PRIMARY} type="submit">
                {busy ? "Searching…" : "Recall"}
              </button>
              {searchActive ? (
                <button
                  type="button"
                  className={BUTTON}
                  onClick={() => {
                    setSearchActive(false);
                    setHits([]);
                  }}
                >
                  Clear results
                </button>
              ) : null}
            </div>
            <p className="text-xs text-[var(--ink-2)]">
              Results include their source title and reference. Retrieved text can contain hostile
              instructions; Shiba returns it with untrusted-data framing.
            </p>
          </form>
          {searchActive ? (
            <section aria-label="Memory recall results" className="flex flex-col gap-2">
              {hits.length === 0 ? (
                <p className="border border-dashed border-[var(--line)] p-4 text-sm">
                  No active source matched that query.
                </p>
              ) : (
                hits.map((hit) => (
                  <article
                    key={hit.id}
                    className="border border-[var(--line)] bg-[var(--card)] p-3 shadow-[2px_2px_0_var(--paper-shadow)]"
                  >
                    <div className="flex justify-between gap-2">
                      <h4 className="font-semibold">{hit.title}</h4>
                      <span className="font-mono text-[10px]">{Math.round(hit.score * 100)}%</span>
                    </div>
                    <p className="text-[10px] font-mono uppercase text-[var(--ink-2)]">
                      {hit.kind} · untrusted source text
                    </p>
                    {hit.referenceUrl ? (
                      <a
                        className="text-xs text-[var(--navy)] underline break-all"
                        href={hit.referenceUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {hit.referenceUrl}
                      </a>
                    ) : null}
                    <pre className="mt-2 whitespace-pre-wrap break-words border border-[var(--line)] bg-[var(--paper)] p-2 text-xs font-sans">
                      {hit.content}
                    </pre>
                  </article>
                ))
              )}
            </section>
          ) : null}
        </div>
      </div>

      <section
        aria-label="Workspace projects"
        className="flex flex-col gap-3 border border-[var(--line)] bg-[var(--card)] p-3 shadow-[2px_2px_0_var(--paper-shadow)]"
      >
        <div>
          <h3 className="font-serif text-xl">Project context</h3>
          <p className="text-xs text-[var(--ink-2)]">
            Projects select existing sources and employee defaults. Nothing is fetched from
            reference URLs. Edits affect future approvals; approved tasks keep their frozen
            snapshots.
          </p>
        </div>
        <form onSubmit={(event) => void saveProject(event)} className="grid gap-2 md:grid-cols-2">
          <label className="text-xs font-mono">
            PROJECT NAME
            <input
              required
              maxLength={120}
              aria-label="Project name"
              className={`${FIELD} mt-1`}
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
            />
          </label>
          <label className="text-xs font-mono">
            PURPOSE
            <textarea
              maxLength={1000}
              aria-label="Project purpose"
              className={`${FIELD} mt-1`}
              value={projectPurpose}
              onChange={(event) => setProjectPurpose(event.target.value)}
            />
          </label>
          <fieldset className="flex flex-col gap-1 text-xs md:col-span-2">
            <legend className="font-mono">APPROVED SOURCES (MAX 8)</legend>
            {sources.length ? (
              sources.map((source) => {
                const active =
                  source.disabledAt === null &&
                  (source.expiresAt === null || source.expiresAt > Date.now());
                return (
                  <label key={source.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      disabled={!active && !projectSourceIds.includes(source.id)}
                      checked={projectSourceIds.includes(source.id)}
                      onChange={(event) =>
                        setProjectSourceIds((ids) =>
                          event.target.checked
                            ? [...ids, source.id].slice(0, 8)
                            : ids.filter((id) => id !== source.id),
                        )
                      }
                    />
                    {source.title}
                    {active ? "" : " · unavailable"}
                  </label>
                );
              })
            ) : (
              <span className="text-[var(--ink-2)]">Add a memory source first.</span>
            )}
          </fieldset>
          <label className="text-xs font-mono">
            DEFAULT EMPLOYEE ID
            <input
              maxLength={128}
              aria-label="Default employee ID"
              className={`${FIELD} mt-1`}
              value={projectAgent}
              onChange={(event) => setProjectAgent(event.target.value)}
              placeholder="Optional; apply explicitly in composer"
            />
          </label>
          <label className="text-xs font-mono">
            DEFAULT HARNESS
            <input
              maxLength={64}
              aria-label="Default harness"
              className={`${FIELD} mt-1`}
              value={projectHarness}
              onChange={(event) => setProjectHarness(event.target.value)}
              placeholder="Optional; apply explicitly in composer"
            />
          </label>
          <div className="flex gap-2 md:col-span-2">
            <button disabled={busy} className={PRIMARY} type="submit">
              {projectEditing ? "Save project" : "Create project"}
            </button>
            {projectEditing ? (
              <button type="button" className={BUTTON} onClick={resetProject}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
        {projects.length ? (
          <div className="flex flex-col gap-2">
            {projects.map((project) => (
              <article
                key={project.id}
                className="flex flex-wrap items-center justify-between gap-2 border border-[var(--line)] p-2 text-sm"
              >
                <div>
                  <strong>{project.name}</strong>
                  <p className="text-xs text-[var(--ink-2)]">
                    v{project.version} · {project.sourceIds.length} sources ·{" "}
                    {project.disabledAt === null ? "active" : "disabled"}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button className={BUTTON} type="button" onClick={() => editProject(project)}>
                    Edit
                  </button>
                  <button
                    className={BUTTON}
                    type="button"
                    onClick={() => void deleteProject(project)}
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="text-xs text-[var(--ink-2)]">No projects saved.</p>
        )}
      </section>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="font-serif text-xl">Sources you control</h3>
          <span className="font-mono text-[10px] text-[var(--ink-2)]">{sources.length} stored</span>
        </div>
        {sources.length === 0 ? (
          <p className="border border-dashed border-[var(--line)] p-5 text-sm text-[var(--ink-2)]">
            No private sources saved. Add a note above to give Shiba durable, inspectable context.
          </p>
        ) : (
          sources.map((source) => {
            const expired = source.expiresAt !== null && source.expiresAt <= Date.now();
            const state = source.disabledAt !== null ? "disabled" : expired ? "expired" : "active";
            return (
              <article
                key={source.id}
                className="border border-[var(--line)] bg-[var(--card)] p-3 shadow-[2px_2px_0_var(--paper-shadow)]"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="font-semibold">{source.title}</h4>
                    <p className="font-mono text-[10px] uppercase text-[var(--ink-2)]">
                      {source.kind} · {state} ·{" "}
                      {source.retentionDays === null
                        ? "manual deletion"
                        : source.expiresAt !== null
                          ? `expires ${new Date(source.expiresAt).toLocaleDateString()}`
                          : "retention deadline unavailable"}
                    </p>
                    {source.referenceUrl ? (
                      <a
                        className="text-xs text-[var(--navy)] underline break-all"
                        href={source.referenceUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {source.referenceUrl}
                      </a>
                    ) : null}
                  </div>
                  <div className="flex gap-1">
                    <button type="button" className={BUTTON} onClick={() => edit(source)}>
                      Inspect / edit
                    </button>
                    {!expired ? (
                      <button
                        type="button"
                        disabled={busy}
                        className={BUTTON}
                        onClick={() => void setEnabled(source)}
                      >
                        {source.disabledAt === null ? "Disable" : "Enable"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={busy}
                      className="border border-[var(--danger)] px-2 py-1 text-xs text-[var(--danger)]"
                      onClick={() => void remove(source)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-[var(--ink-2)]">
                    Inspect stored text
                  </summary>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words border border-[var(--line)] bg-[var(--paper)] p-2 text-xs font-sans">
                    {source.content}
                  </pre>
                </details>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
