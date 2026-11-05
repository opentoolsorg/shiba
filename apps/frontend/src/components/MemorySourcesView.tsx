/** Owner-scoped, self-hostable memory notes and source references in clean panel style. */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from "react";
import { Database, FileText, Search, Upload } from "lucide-react";
import { EmptyState } from "./ui/ContextPanel";

type SourceKind = "note" | "document" | "conversation" | "reference" | "other";
export interface MemorySource {
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
  version?: number;
  sha256?: string;
  ingestion?: { state: "ready"; filename: string; mediaType: string; bytes: number };
}
interface MemoryHit extends MemorySource {
  score: number;
  trust: "untrusted";
  context: string;
  citations?: Array<{ version: number; sha256: string; lineStart: number; lineEnd: number; section?: string; text: string; textTruncated?: boolean }>;
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

class MemoryApiError extends Error {
  constructor(message: string, readonly currentSource?: MemorySource) { super(message); }
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; currentSource?: MemorySource };
  if (!response.ok)
    throw new MemoryApiError(
      typeof body.error === "string" ? body.error : `Request failed: ${response.status}`,
      response.status === 409 ? body.currentSource : undefined,
    );
  return body;
}

const FIELD =
  "w-full border border-[#e4e4e7] dark:border-zinc-800 bg-white dark:bg-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-[#0a0a0a] dark:text-zinc-100 placeholder:text-[#71717a] dark:placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-400 touch:min-h-11";
const BUTTON =
  "border border-[#e4e4e7] dark:border-zinc-800 bg-white dark:bg-zinc-800 px-3 py-1.5 text-xs font-medium text-[#0a0a0a] dark:text-zinc-100 rounded-lg hover:bg-[#f4f4f5] dark:hover:bg-zinc-700 disabled:opacity-50 transition-colors touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]";
const PRIMARY =
  "bg-[#0a0a0a] dark:bg-zinc-100 text-white dark:text-zinc-900 px-3 py-1.5 text-xs font-medium rounded-lg hover:bg-zinc-800 dark:hover:bg-zinc-200 disabled:opacity-50 transition-colors shadow-xs touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]";
const KINDS: SourceKind[] = ["note", "document", "conversation", "reference", "other"];

export function MemorySourcesView(): JSX.Element {
  const [sources, setSources] = useState<MemorySource[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<SourceKind>("note");
  const [referenceUrl, setReferenceUrl] = useState("");
  const [retentionDays, setRetentionDays] = useState("365");
  const [editing, setEditing] = useState<string | null>(null);
  const [editingVersion, setEditingVersion] = useState<number | null>(null);
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
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [cleanupPending, setCleanupPending] = useState<Array<{ id: string; filename: string }>>([]);
  const [uploadsPending, setUploadsPending] = useState<Array<{ id: string; filename: string }>>([]);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadBusy = useRef(false);
  const recallEpoch = useRef(0);

  const load = useCallback(async () => {
    const epoch = ++recallEpoch.current;
    setHits([]);
    setSearchActive(false);
    try {
      const body = await apiJson<{ sources?: MemorySource[]; cleanupPending?: Array<{ id: string; filename: string }>; uploadsPending?: Array<{ id: string; filename: string }> }>("/api/memory/sources");
      if (epoch !== recallEpoch.current) return;
      setSources(Array.isArray(body.sources) ? body.sources : []);
      setCleanupPending(body.cleanupPending ?? []);
      setUploadsPending(body.uploadsPending ?? []);
      const projectBody = await apiJson<{ projects?: MemoryProject[] }>("/api/memory/projects");
      if (epoch !== recallEpoch.current) return;
      setProjects(Array.isArray(projectBody.projects) ? projectBody.projects : []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Memory sources could not be loaded.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (event: FormEvent) => {
    event.preventDefault();
    if (!uploadFile || uploadBusy.current) return;
    uploadBusy.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!/\.(txt|md)$/i.test(uploadFile.name) || uploadFile.size < 1 || uploadFile.size > 40_000) throw new Error("Choose a nonempty TXT or Markdown file, at most 40000 bytes.");
      await apiJson("/api/memory/sources/upload", { method: "POST", headers: { "Content-Type": uploadFile.name.toLowerCase().endsWith(".md") ? "text/markdown" : "text/plain", "X-Source-Filename": uploadFile.name }, body: uploadFile });
      setUploadFile(null);
      if (uploadInput.current) uploadInput.current.value = "";
      await load();
      setNotice("File validated and stored privately. Immutable version ready for retrieval.");
    } catch (cause) {
      await load();
      setError(cause instanceof Error ? cause.message : "Upload failed. Retry the complete file.");
    }
    finally { uploadBusy.current = false; setBusy(false); }
  };

  const retryCleanup = async (id: string) => {
    setBusy(true);
    try {
      const result = await apiJson<{ cleanup?: string }>(`/api/memory/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
      setNotice(result.cleanup === "pending" ? "Source remains excluded. File cleanup is still pending." : "Stored file cleanup complete.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "File cleanup failed."); }
    finally { setBusy(false); }
  };

  const resetForm = () => {
    setEditing(null);
    setEditingVersion(null);
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
        ...(editingVersion !== null ? { expectedVersion: editingVersion } : {}),
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
      await load();
      if (cause instanceof MemoryApiError && cause.currentSource?.id === editing) {
        setEditingVersion(cause.currentSource.version ?? null);
        setNotice("Current source refreshed. Your text is unchanged; inspect the stored source before saving again.");
      }
      setError(cause instanceof Error ? cause.message : "Memory source could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const edit = (source: MemorySource) => {
    setEditing(source.id);
    setEditingVersion(source.version ?? null);
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
    if (!window.confirm(`Forget “${source.title}” for future retrieval and delete stored file versions? Existing approved snapshots remain unchanged.`))
      return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiJson<{ cleanup?: string }>(`/api/memory/sources/${encodeURIComponent(source.id)}`, { method: "DELETE" });
      await load();
      setNotice(result.cleanup === "pending" ? "Source forgotten for future retrieval. Stored file cleanup is pending." : "Source and stored files deleted. Existing approved snapshots remain unchanged.");
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
    const epoch = recallEpoch.current;
    try {
      const body = await apiJson<{ hits?: MemoryHit[] }>(
        `/api/memory/recall?q=${encodeURIComponent(query)}`,
      );
      if (epoch === recallEpoch.current) {
        setHits(Array.isArray(body.hits) ? body.hits : []);
        setSearchActive(true);
      }
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
      className="flex flex-col gap-4 text-[#0a0a0a] dark:text-zinc-100"
    >
      <header className="border border-[#e4e4e7] dark:border-zinc-800 rounded-xl bg-white dark:bg-zinc-900 shadow-xs overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#e4e4e7] dark:border-zinc-800 bg-[#fafafa] dark:bg-zinc-800/60 px-4 py-2.5 text-xs font-mono text-[#71717a] dark:text-zinc-400">
          <span>WORKSPACE MEMORY · OWNER PRIVATE</span>
          <button className="text-[11px] underline hover:text-[#0a0a0a] dark:hover:text-zinc-100 transition-colors touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]" onClick={() => void load()} type="button">
            Sync
          </button>
        </div>
        <div className="p-4 text-sm">
          <p className="text-[13px] text-[#0a0a0a] dark:text-zinc-200">
            Private extracted text is stored in Shiba’s local SQLite-backed Durable Object; uploaded file versions stay in private storage. Retrieval
            uses local keyword ranking; source text is treated as untrusted reference data.
          </p>
          <p className="mt-1 text-xs text-[#71717a] dark:text-zinc-400">
            {activeCount} active sources · default retention is 365 days · “Keep until deleted”
            removes the expiry.
          </p>
        </div>
      </header>

      {error ? (
        <div
          role="alert"
          className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/60 p-3 rounded-xl text-xs text-rose-800 dark:text-rose-300"
        >
          {error}
        </div>
      ) : null}
      {notice ? (
        <div role="status" className="border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 p-3 rounded-xl text-xs text-emerald-800 dark:text-emerald-300">
          {notice}
        </div>
      ) : null}

      <form onSubmit={(event) => void upload(event)} className="flex flex-col gap-2.5 border border-[#e4e4e7] dark:border-zinc-800 rounded-xl bg-white dark:bg-zinc-900 p-4 shadow-xs">
        <h3 className="text-base font-semibold text-[#0a0a0a] dark:text-zinc-100">Upload source file</h3>
        <p className="text-xs text-[#71717a] dark:text-zinc-400">TXT and Markdown only, UTF-8, at most 40000 bytes. PDF, Office, archives, HTML and SVG are unsupported. Files become ready after validation and private storage succeed. Recall expiry excludes text; original files remain stored until Delete.</p>
        <label className="text-xs font-medium text-[#71717a] dark:text-zinc-400 flex flex-col gap-1.5">TXT or Markdown file
          <input ref={uploadInput} type="file" accept=".txt,.md,text/plain,text/markdown" disabled={busy} onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} className="text-xs text-[#71717a] dark:text-zinc-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-[#f4f4f5] dark:file:bg-zinc-800 file:text-[#0a0a0a] dark:file:text-zinc-100 hover:file:bg-zinc-200 dark:hover:file:bg-zinc-700 touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]" />
        </label>
        <div className="flex justify-start pt-1">
          <button type="submit" disabled={busy || !uploadFile} className={PRIMARY}>{uploadBusy.current ? "Validating and storing…" : "Upload file"}</button>
        </div>
      </form>
      {cleanupPending.length ? <section aria-label="Pending file cleanup" className="border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 rounded-xl p-3.5 text-xs">
        <p className="text-amber-800 dark:text-amber-300 font-medium">These removed or uncommitted file versions are excluded from retrieval. Stored file deletion is pending.</p>
        <div className="mt-2 flex flex-col gap-1">
          {cleanupPending.map((item) => <p key={item.id} className="flex items-center gap-2 touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]">{item.filename} <button type="button" disabled={busy} className={BUTTON} onClick={() => void retryCleanup(item.id)}>Retry file cleanup</button></p>)}
        </div>
      </section> : null}
      {uploadsPending.length ? <section aria-label="Unresolved uploads" className="border border-[#e4e4e7] dark:border-zinc-800 bg-[#fafafa] dark:bg-zinc-900 rounded-xl p-3.5 text-xs text-[#71717a] dark:text-zinc-400">
        <p>These uploads have no committed new version. Reload to check progress. Interrupted writes require operator reconciliation; cleanup cannot safely delete an upload still in progress.</p>
        <div className="mt-2 flex flex-col gap-1">
          {uploadsPending.map((item) => <p key={item.id}>{item.filename}</p>)}
        </div>
      </section> : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
        <form
          onSubmit={(event) => void save(event)}
          className="flex flex-col gap-2.5 border border-[#e4e4e7] dark:border-zinc-800 rounded-xl bg-white dark:bg-zinc-900 p-4 shadow-xs"
        >
          <h3 className="text-base font-semibold text-[#0a0a0a] dark:text-zinc-100">{editing ? "Edit source" : "Add to memory"}</h3>
          {editingVersion !== null ? <p className="text-xs text-[#71717a] dark:text-zinc-400">Current source version: {editingVersion}. Saving corrections creates a new immutable version.</p> : null}
          <label className="text-xs font-mono text-[#71717a] dark:text-zinc-400">
            TITLE
            <input
              required
              maxLength={200}
              className={`${FIELD} mt-1 touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]`}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="text-xs font-mono text-[#71717a] dark:text-zinc-400">
            SOURCE TYPE
            <select
              className={`${FIELD} mt-1 touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]`}
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
          <label className="text-xs font-mono text-[#71717a] dark:text-zinc-400">
            TEXT TO REMEMBER
            <textarea
              required
              maxLength={40_000}
              rows={7}
              className={`${FIELD} mt-1 resize-y font-sans touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]`}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="Paste a note or the relevant text here. Shiba does not fetch linked pages."
            />
          </label>
          <label className="text-xs font-mono text-[#71717a] dark:text-zinc-400">
            REFERENCE URL{" "}
            <span className="font-sans text-[11px] text-[#71717a] dark:text-zinc-500">
              (optional provenance link; never fetched)
            </span>
            <input
              type="url"
              pattern="https://.*"
              className={`${FIELD} mt-1 font-sans touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]`}
              value={referenceUrl}
              onChange={(event) => setReferenceUrl(event.target.value)}
              placeholder="https://…"
            />
          </label>
          <label className="text-xs font-mono text-[#71717a] dark:text-zinc-400">
            RETENTION
            <select
              className={`${FIELD} mt-1 touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]`}
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
            className="flex flex-col gap-2.5 border border-[#e4e4e7] dark:border-zinc-800 rounded-xl bg-white dark:bg-zinc-900 p-4 shadow-xs"
          >
            <h3 className="text-base font-semibold text-[#0a0a0a] dark:text-zinc-100">Recall from memory</h3>
            <label className="text-xs font-mono text-[#71717a] dark:text-zinc-400">
              QUERY
              <input
                required
                className={`${FIELD} mt-1 font-sans touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]`}
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
            <p className="text-xs text-[#71717a] dark:text-zinc-400">
              Results include their source title and reference. Retrieved text can contain hostile
              instructions; Shiba returns it with untrusted-data framing.
            </p>
          </form>
          {searchActive ? (
            <section aria-label="Memory recall results" className="flex flex-col gap-2">
              {hits.length === 0 ? (
                <p className="border border-dashed border-[#e4e4e7] dark:border-zinc-800 rounded-xl p-4 text-xs text-[#71717a] dark:text-zinc-400 text-center">
                  No active source matched that query.
                </p>
              ) : (
                hits.map((hit) => (
                  <article
                    key={hit.id}
                    className="border border-[#e4e4e7] dark:border-zinc-800 rounded-xl bg-white dark:bg-zinc-900 p-3.5 shadow-xs"
                  >
                    <div className="flex justify-between gap-2">
                      <h4 className="font-semibold text-[13px] text-[#0a0a0a] dark:text-zinc-100">{hit.title}</h4>
                      <span className="font-mono text-[11px] text-[#71717a] dark:text-zinc-400">{Math.round(hit.score * 100)}%</span>
                    </div>
                    <p className="text-[10px] font-mono uppercase text-[#71717a] dark:text-zinc-500">
                      {hit.kind} · untrusted source text
                    </p>
                    {hit.citations?.map((citation) => <p key={`${citation.version}:${citation.lineStart}`} className="text-xs break-all text-[#71717a] dark:text-zinc-400">v{citation.version} · line {citation.lineStart}{citation.section ? ` · ${citation.section}` : ""}{citation.textTruncated ? " · excerpt" : ""} · SHA-256 {citation.sha256}</p>)}
                    {hit.referenceUrl ? (
                      <a
                        className="text-xs text-blue-600 dark:text-blue-400 underline break-all"
                        href={hit.referenceUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {hit.referenceUrl}
                      </a>
                    ) : null}
                    <pre className="mt-2 whitespace-pre-wrap break-words border border-[#e4e4e7] dark:border-zinc-800 rounded-lg bg-[#fafafa] dark:bg-zinc-800/60 p-2.5 text-xs font-sans text-[#0a0a0a] dark:text-zinc-200">
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
        className="flex flex-col gap-3 border border-[#e4e4e7] dark:border-zinc-800 rounded-xl bg-white dark:bg-zinc-900 p-4 shadow-xs"
      >
        <div>
          <h3 className="text-base font-semibold text-[#0a0a0a] dark:text-zinc-100">Project context</h3>
          <p className="text-xs text-[#71717a] dark:text-zinc-400">
            Projects select existing sources and employee defaults. Nothing is fetched from
            reference URLs. Edits affect future approvals; approved tasks keep their frozen
            snapshots.
          </p>
        </div>
        <form onSubmit={(event) => void saveProject(event)} className="grid gap-3 md:grid-cols-2">
          <label className="text-xs font-mono text-[#71717a] dark:text-zinc-400">
            PROJECT NAME
            <input
              required
              maxLength={120}
              aria-label="Project name"
              className={`${FIELD} mt-1 font-sans touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]`}
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
            />
          </label>
          <label className="text-xs font-mono text-[#71717a] dark:text-zinc-400">
            PURPOSE
            <textarea
              maxLength={1000}
              aria-label="Project purpose"
              className={`${FIELD} mt-1 font-sans resize-y touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]`}
              rows={2}
              value={projectPurpose}
              onChange={(event) => setProjectPurpose(event.target.value)}
            />
          </label>
          <fieldset className="flex flex-col gap-1 text-xs md:col-span-2">
            <legend className="font-mono text-[#71717a] dark:text-zinc-400 mb-1">APPROVED SOURCES (MAX 8)</legend>
            {sources.length ? (
              sources.map((source) => {
                const active =
                  source.disabledAt === null &&
                  (source.expiresAt === null || source.expiresAt > Date.now());
                return (
                  <label key={source.id} className="flex items-center gap-2 text-[#0a0a0a] dark:text-zinc-200">
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
                    <span>{source.title}</span>
                    {active ? "" : <span className="text-[#71717a] dark:text-zinc-500 touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]">· unavailable</span>}
                  </label>
                );
              })
            ) : (
              <span className="text-[#71717a] dark:text-zinc-500">Add a memory source first.</span>
            )}
          </fieldset>
          <label className="text-xs font-mono text-[#71717a] dark:text-zinc-400">
            DEFAULT EMPLOYEE ID
            <input
              maxLength={128}
              aria-label="Default employee ID"
              className={`${FIELD} mt-1 font-sans touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]`}
              value={projectAgent}
              onChange={(event) => setProjectAgent(event.target.value)}
              placeholder="Optional; apply explicitly in composer"
            />
          </label>
          <label className="text-xs font-mono text-[#71717a] dark:text-zinc-400">
            DEFAULT HARNESS
            <input
              maxLength={64}
              aria-label="Default harness"
              className={`${FIELD} mt-1 font-sans touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]`}
              value={projectHarness}
              onChange={(event) => setProjectHarness(event.target.value)}
              placeholder="Optional; apply explicitly in composer"
            />
          </label>
          <div className="flex gap-2 md:col-span-2 pt-1">
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
          <div className="flex flex-col gap-2 pt-1">
            {projects.map((project) => (
              <article
                key={project.id}
                className="flex flex-wrap items-center justify-between gap-2 border border-[#e4e4e7] dark:border-zinc-800 rounded-lg p-2.5 text-xs bg-[#fafafa] dark:bg-zinc-800/50"
              >
                <div>
                  <strong className="text-[13px] text-[#0a0a0a] dark:text-zinc-100">{project.name}</strong>
                  <p className="text-xs text-[#71717a] dark:text-zinc-400">
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
          <p className="text-xs text-[#71717a] dark:text-zinc-500">No projects saved.</p>
        )}
      </section>

      <div className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-[#0a0a0a] dark:text-zinc-100">Sources you control</h3>
          <span className="font-mono text-[11px] text-[#71717a] dark:text-zinc-400">{sources.length} stored</span>
        </div>
        {sources.length === 0 ? (
          <EmptyState
            icon={Database}
            title="No private sources saved"
            description="Add a note or upload a TXT/Markdown file to give Shiba durable, inspectable context."
          />
        ) : (
          sources.map((source) => {
            const expired = source.expiresAt !== null && source.expiresAt <= Date.now();
            const state = source.disabledAt !== null ? "disabled" : expired ? "expired" : "active";
            return (
              <article
                key={source.id}
                className="border border-[#e4e4e7] dark:border-zinc-800 rounded-xl bg-white dark:bg-zinc-900 p-4 shadow-xs"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="font-semibold text-[13px] text-[#0a0a0a] dark:text-zinc-100">{source.title}</h4>
                    <p className="font-mono text-[11px] uppercase text-[#71717a] dark:text-zinc-400">
                      {source.kind} · {state} ·{" "}
                      {source.retentionDays === null
                        ? "manual deletion"
                        : source.expiresAt !== null
                          ? `expires ${new Date(source.expiresAt).toLocaleDateString()}`
                          : "retention deadline unavailable"}
                    </p>
                    {source.ingestion ? <p className="text-xs break-all text-[#71717a] dark:text-zinc-400">Extraction: {source.ingestion.state} · version {source.version} · {source.ingestion.bytes} bytes · SHA-256 {source.sha256}</p> : <p className="text-xs text-[#71717a] dark:text-zinc-400">Pasted note; upload TXT/Markdown to pin an immutable task source.</p>}
                    {source.referenceUrl ? (
                      <a
                        className="text-xs text-blue-600 dark:text-blue-400 underline break-all"
                        href={source.referenceUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {source.referenceUrl}
                      </a>
                    ) : null}
                  </div>
                  <div className="flex gap-1.5 shrink-0">
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
                      className="border border-rose-200 dark:border-rose-900 px-2.5 py-1 text-xs text-rose-600 dark:text-rose-400 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-950/60 transition-colors touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
                      onClick={() => void remove(source)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <details className="mt-2.5">
                  <summary className="cursor-pointer text-xs text-[#71717a] dark:text-zinc-400 hover:text-[#0a0a0a] dark:hover:text-zinc-100">
                    Inspect stored text
                  </summary>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words border border-[#e4e4e7] dark:border-zinc-800 rounded-lg bg-[#fafafa] dark:bg-zinc-800/60 p-2.5 text-xs font-sans text-[#0a0a0a] dark:text-zinc-200">
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
