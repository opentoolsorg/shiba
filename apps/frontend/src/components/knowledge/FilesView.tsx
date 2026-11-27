import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { FileArchive, FileText, FolderPlus, LayoutGrid, List, Plus, Search, Upload } from "lucide-react";
import type { KnowledgeFile, KnowledgeScope, KnowledgeSearchHit } from "@shiba/shared";
import { MarkedSnippet } from "../palette/ResultRow";
import { uploadFile } from "../../files-upload-client";
import { teamWorkspaceHeaders } from "../../team-workspaces-client";
import type { AppNavView } from "../AppNavRail";
import { LoadErrorState } from "../LoadErrorState";
import { FileAppPreview } from "./FileAppPreview";

const REVEAL_ON_HOVER = "transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100";

export function FilesView({ onNavigate, appPreviewOwner, workspaceId }: { onNavigate?: (view: AppNavView) => void; appPreviewOwner?: string; workspaceId?: string | null } = {}): JSX.Element {
  const [scope, setScope] = useState<KnowledgeScope>("personal");
  const [files, setFiles] = useState<KnowledgeFile[]>([]);
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<KnowledgeSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [folderId, setFolderId] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadingRef = useRef(false);
  const fileRequest = useRef(0);
  const folderRequest = useRef(0);
  const [uploads, setUploads] = useState<Array<{ id: number; name: string; done: number; total: number; state: string; error?: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [layout, setLayout] = useState<"list" | "cards">("list");
  const [searchOpen, setSearchOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workspaceHeaders = useMemo(() => teamWorkspaceHeaders(workspaceId ?? undefined), [workspaceId]);

  const load = useCallback(async () => {
    const request = ++fileRequest.current;
    setError(null);
    const response = await fetch(`/api/files?scope=${scope}${folderId ? `&folderId=${encodeURIComponent(folderId)}` : ""}`, { credentials: "same-origin", cache: "no-store", headers: workspaceHeaders });
    const body = await response.json() as { files?: KnowledgeFile[]; error?: string };
    if (!response.ok || !Array.isArray(body.files)) throw new Error(body.error ?? `Files unavailable (${response.status}).`);
    if (request === fileRequest.current) setFiles(body.files);
  }, [scope, folderId, workspaceHeaders]);

  useEffect(() => {
    void load().catch((err: unknown) => setError(err instanceof Error ? err.message : "Files failed to load."));
    return () => { fileRequest.current++; };
  }, [load]);

  const loadFolders = useCallback(async () => {
    const request = ++folderRequest.current;
    const response = await fetch(`/api/files/folders?scope=${scope}`, { credentials: "same-origin", cache: "no-store", headers: workspaceHeaders });
    const body = await response.json() as { folders?: Array<{ id: string; name: string }>; error?: string };
    if (!response.ok || !Array.isArray(body.folders)) throw new Error(body.error ?? "Folders unavailable.");
    if (request === folderRequest.current) setFolders(body.folders);
  }, [scope, workspaceHeaders]);

  useEffect(() => {
    void loadFolders().catch((err: unknown) => setError(err instanceof Error ? err.message : "Folders failed to load."));
    return () => { folderRequest.current++; };
  }, [loadFolders]);

  useEffect(() => {
    if (!files.some((file) => file.ingestion.state === "pending" || file.ingestion.state === "processing")) return;
    const timer = setInterval(() => { void load().catch((err: unknown) => setError(err instanceof Error ? err.message : "Files failed to load.")); }, 3000);
    return () => clearInterval(timer);
  }, [files, load]);

  async function createFolder() {
    if (!folderName.trim()) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/files/folders?scope=${scope}`, {
        method: "POST", credentials: "same-origin",
        headers: { ...workspaceHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ name: folderName, scope, parentId: folderId || null }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Folder create failed.");
      setFolderName("");
      await loadFolders();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Folder create failed.");
    } finally {
      setBusy(false);
    }
  }

  async function runSearch() {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const response = await fetch(`/api/knowledge/search?q=${encodeURIComponent(query.trim())}`, { credentials: "same-origin", cache: "no-store", headers: workspaceHeaders });
      const body = await response.json() as { hits?: KnowledgeSearchHit[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Search failed.");
      setSearchHits(body.hits ?? []);
    } finally {
      setSearching(false);
    }
  }

  async function uploadFiles(selected: FileList | File[]) {
    if (uploadingRef.current || busy || !selected.length) return;
    const batch = Array.from(selected);
    uploadingRef.current = true;
    setBusy(true);
    setUploads(batch.map((file, id) => ({ id, name: file.name, done: 0, total: 0, state: "Waiting" })));
    const update = (index: number, patch: Partial<(typeof uploads)[number]>) => {
      setUploads((current) => current.map((item, i) => i === index ? { ...item, ...patch } : item));
    };
    try {
      for (const [index, file] of batch.entries()) {
        update(index, { state: "Uploading" });
        try {
          await uploadFile(file, {
            scope, folderId: folderId || null, headers: workspaceHeaders,
            onProgress: (done, total) => update(index, { done, total }),
          });
          update(index, { state: "Uploaded" });
        } catch (err: unknown) {
          update(index, { state: "Failed", error: err instanceof Error ? err.message : "Upload failed." });
          continue;
        }
        await load().catch((err: unknown) => setError(err instanceof Error ? err.message : "Files failed to load."));
      }
    } finally {
      uploadingRef.current = false;
      setBusy(false);
    }
  }

  const iconFor = (file: KnowledgeFile, size = 15) => (file.mime ?? "") === "application/pdf"
    ? <FileArchive size={size} className="shrink-0 text-red-500" />
    : (file.mime ?? "").startsWith("text/") || (file.mime ?? "").includes("markdown")
      ? <FileText size={size} className="shrink-0 text-[var(--muted-light)]" />
      : <FileArchive size={size} className="shrink-0 text-[var(--muted-light)]" />;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg)] text-[var(--fg)]">
      <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 px-6 py-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="truncate text-sm font-normal tracking-[-0.01em]">All</h1>
          <span className="text-xs leading-5 text-[var(--muted-light)]">{files.length} {files.length === 1 ? "item" : "items"}</span>
          {onNavigate ? (
            <button type="button" className="hidden text-xs text-[var(--muted-foreground-2)] underline underline-offset-2 hover:text-[var(--fg)] sm:inline" onClick={() => onNavigate("memory")}>Review memory sources</button>
          ) : null}
        </div>

        <div className="flex max-w-full shrink-0 items-center gap-2 overflow-x-auto scrollbar-none max-sm:order-2 max-sm:w-full sm:ml-auto sm:w-auto sm:overflow-visible [&::-webkit-scrollbar]:hidden">
          <label className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-1)] bg-[var(--card)] px-2 text-xs text-[var(--muted-foreground-2)]">
            <span>Scope</span>
            <select aria-label="Scope" className="h-full bg-transparent text-xs text-[var(--fg)] outline-none" value={scope} disabled={busy} onChange={(e) => { setScope(e.target.value as KnowledgeScope); setFolderId(""); setFolders([]); }}>
              <option value="personal">Personal</option>
              <option value="workspace">Workspace</option>
            </select>
          </label>
          <label className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-1)] bg-[var(--card)] px-2 text-xs text-[var(--muted-foreground-2)]">
            <span>Folder</span>
            <select aria-label="Folder" className="h-full max-w-28 bg-transparent text-xs text-[var(--fg)] outline-none" value={folderId} disabled={busy} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">All files</option>
              {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select>
          </label>
          <button type="button" title="Search files" aria-label="Search files" aria-expanded={searchOpen} onClick={() => {
            if (searchOpen) {
              setSearchHits(null);
              setQuery("");
            }
            setSearchOpen(!searchOpen);
          }} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border-1)] bg-[var(--card)] text-[var(--muted-foreground-2)] transition-colors hover:bg-[var(--card-hover)] hover:text-[var(--fg)]">
            <Search size={14} />
          </button>
          <button type="button" title="Create folder" aria-label="Create folder" aria-expanded={createOpen} onClick={() => setCreateOpen((open) => !open)} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border-1)] bg-[var(--card)] text-[var(--muted-foreground-2)] transition-colors hover:bg-[var(--card-hover)] hover:text-[var(--fg)]">
            <Plus size={14} />
          </button>
          <div className="flex h-8 items-center rounded-md border border-[var(--border-1)] bg-[var(--panel)] p-0.5">
            <button type="button" title="List" aria-label="List layout" aria-pressed={layout === "list"} onClick={() => setLayout("list")} className={`inline-flex h-7 items-center rounded px-2 transition-colors ${layout === "list" ? "bg-[var(--card)] text-[var(--fg)] shadow-xs" : "text-[var(--muted-light)] hover:text-[var(--fg)]"}`}><List size={14} /></button>
            <button type="button" title="Cards" aria-label="Cards layout" aria-pressed={layout === "cards"} onClick={() => setLayout("cards")} className={`inline-flex h-7 items-center rounded px-2 transition-colors ${layout === "cards" ? "bg-[var(--card)] text-[var(--fg)] shadow-xs" : "text-[var(--muted-light)] hover:text-[var(--fg)]"}`}><LayoutGrid size={14} /></button>
          </div>
          <input ref={inputRef} type="file" multiple hidden aria-label="Upload files" disabled={busy} onChange={(e) => {
            if (e.currentTarget.files) void uploadFiles(e.currentTarget.files);
            e.currentTarget.value = "";
          }} />
          <button type="button" className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border-1)] bg-[var(--card)] text-[var(--muted-foreground-2)] transition-colors hover:bg-[var(--card-hover)] hover:text-[var(--fg)] disabled:opacity-50" aria-label="Upload" title="Upload" disabled={busy} onClick={() => inputRef.current?.click()}>
            <Upload size={14} />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto w-full max-w-3xl">
          {createOpen || searchOpen ? <section aria-label="File actions" className="mb-3 flex flex-wrap items-center gap-2">
            {createOpen ? <input className="h-8 min-w-40 flex-1 rounded-md border border-[var(--border-1)] bg-[var(--card)] px-2.5 text-xs outline-none placeholder:text-[var(--muted-light)] focus:border-[var(--border-3)] sm:max-w-56" value={folderName} onChange={(e) => setFolderName(e.target.value)} placeholder="New folder name" /> : null}
            {createOpen ? <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-1)] bg-[var(--card)] px-2.5 text-xs transition-colors hover:bg-[var(--card-hover)] disabled:opacity-50" disabled={busy} onClick={() => void createFolder()}>
              <FolderPlus size={13} /> Folder
            </button> : null}
            {searchOpen ? <form role="search" aria-label="Search knowledge" className="flex min-w-56 flex-1 items-center gap-2 sm:justify-end" onSubmit={(e) => {
              e.preventDefault();
              void runSearch().catch((err: unknown) => setError(err instanceof Error ? err.message : "Search failed."));
            }}>
              <input type="search" aria-label="Search files and notes" className="h-8 min-w-0 flex-1 rounded-md border border-[var(--border-1)] bg-[var(--card)] px-2.5 text-xs outline-none placeholder:text-[var(--muted-light)] focus:border-[var(--border-3)] sm:max-w-64" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search files…" />
              <button type="submit" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-1)] bg-[var(--card)] px-2.5 text-xs transition-colors hover:bg-[var(--card-hover)] disabled:opacity-50" disabled={searching || !query.trim()}>
                <Search size={13} aria-hidden="true" /> {searching ? "Searching…" : "Search"}
              </button>
            </form> : null}
          </section> : null}

          {searchOpen && searchHits ? (
            <section aria-label="Knowledge search results" aria-live="polite" className="mb-4 overflow-hidden rounded-xl border border-[var(--border-1)] bg-[var(--card)] shadow-xs">
              <header className="flex items-center justify-between border-b border-[var(--border-1)] px-3 py-2 text-xs text-[var(--muted-foreground-2)]">
                <span>Matches for <span className="font-medium text-[var(--fg)]">{query.trim()}</span></span>
                <span className="tabular-nums">{searchHits.length} {searchHits.length === 1 ? "passage" : "passages"}</span>
              </header>
              {searchHits.length ? (
                <ol className="divide-y divide-[var(--border-1)] text-sm">
                  {searchHits.map((hit) => (
                    <li key={hit.chunkId} className="group px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">{hit.sourceName || (hit.sourceKind === "note" ? "Untitled note" : "Untitled file")}</span>
                        <span className={`shrink-0 rounded-full bg-[var(--surface-subtle)] px-2 py-0.5 text-[11px] text-[var(--muted-foreground-2)] ${REVEAL_ON_HOVER}`}>{hit.sourceKind === "note" ? "Note" : "File"}{hit.scope ? ` · ${hit.scope === "workspace" ? "Workspace" : "Personal"}` : ""}</span>
                      </div>
                      <p className="mt-1 line-clamp-3 text-xs leading-5 text-[var(--muted-foreground-1)]"><MarkedSnippet text={hit.text.slice(0, 600)} query={query} /></p>
                    </li>
                  ))}
                </ol>
              ) : <p className="px-3 py-3 text-xs text-[var(--muted-foreground-2)]">No passages match. Files appear here once their ingestion state is done.</p>}
            </section>
          ) : null}

          {error ? <LoadErrorState message={error} onRetry={() => void load().catch((err: unknown) => setError(err instanceof Error ? err.message : "Files failed to load."))} /> : null}

          <section aria-label="File list" onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
            e.preventDefault();
            void uploadFiles(e.dataTransfer.files);
          }}>
            <p className="sr-only">Drop files here to upload{folderId ? " into the selected folder" : ""}.</p>
            {uploads.length ? <ul aria-live="polite" className="pb-3 text-xs text-[var(--muted-foreground-2)]">
              {uploads.map((upload) => <li key={upload.id}>
                {upload.name}: {upload.state} · {upload.done} / {upload.total} parts
                {upload.error ? <span role="alert"> — {upload.error}</span> : null}
              </li>)}
            </ul> : null}
            {layout === "list" ? (
              <ul className="space-y-0.5 text-sm">
                {files.map((file) => {
                  const canPreview = appPreviewOwner && scope === "personal" && file.scope === "personal" &&
                    file.createdBy?.trim().toLowerCase() === appPreviewOwner &&
                    file.workspaceId === "self-hosted" && file.archivedAt === null && file.mime === "application/json" &&
                    /^file_[a-f0-9]{24}$/.test(file.id) && file.name.endsWith(".app-preview.json");
                  return <li key={file.id} className={canPreview ? "group rounded-[8px] border border-transparent px-3 py-2.5 transition-colors hover:border-[var(--border-1)] hover:bg-[var(--panel)]" : "group flex items-center gap-3 rounded-[8px] border border-transparent px-3 py-2.5 transition-colors hover:border-[var(--border-1)] hover:bg-[var(--panel)]"}>
                    {iconFor(file)}
                    <span className="min-w-0 flex-1 truncate font-normal leading-relaxed">{file.name}</span>
                    <span className={`hidden shrink-0 text-xs text-[var(--muted-light)] ${REVEAL_ON_HOVER} lg:inline`}>{file.mime ?? "file"}</span>
                    <span className={`hidden shrink-0 text-xs text-[var(--muted-light)] ${REVEAL_ON_HOVER} sm:inline`}>{new Date(file.updatedAt).toLocaleDateString()}</span>
                    <span className={`shrink-0 text-xs tabular-nums text-[var(--muted-light)] ${REVEAL_ON_HOVER}`}>{file.size.toLocaleString()} bytes</span>
                    <span className={`shrink-0 rounded-full bg-[var(--surface-subtle)] px-2 py-0.5 text-[11px] text-[var(--muted-foreground-2)] ${REVEAL_ON_HOVER}`}>{file.ingestion.state}</span>
                    {canPreview && <div className="basis-full sm:basis-auto"><FileAppPreview key={appPreviewOwner} fileId={file.id} fileName={file.name} /></div>}
                  </li>;
                })}
              </ul>
            ) : (
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {files.map((file) => {
                  const canPreview = appPreviewOwner && scope === "personal" && file.scope === "personal" &&
                    file.createdBy?.trim().toLowerCase() === appPreviewOwner &&
                    file.workspaceId === "self-hosted" && file.archivedAt === null && file.mime === "application/json" &&
                    /^file_[a-f0-9]{24}$/.test(file.id) && file.name.endsWith(".app-preview.json");
                  return <li key={file.id} className="overflow-hidden rounded-xl border border-[var(--border-1)] bg-[var(--card)] shadow-xs transition-shadow hover:shadow-md">
                    <div className="flex h-28 items-center justify-center bg-[var(--panel)]">{iconFor(file, 36)}</div>
                    <div className="space-y-1.5 p-3">
                      <span className="block truncate text-xs font-medium">{file.name}</span>
                      <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--muted-light)]">
                        <span className="tabular-nums">{file.size.toLocaleString()} bytes</span>
                        <span>{new Date(file.updatedAt).toLocaleDateString()}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="rounded-full bg-[var(--surface-subtle)] px-2 py-0.5 text-[11px] text-[var(--muted-foreground-2)]">{file.ingestion.state}</span>
                        {canPreview && <FileAppPreview key={appPreviewOwner} fileId={file.id} fileName={file.name} />}
                      </div>
                    </div>
                  </li>;
                })}
              </ul>
            )}
            {!files.length ? <div className="flex min-h-36 flex-col items-center justify-center gap-2 text-xs text-[var(--muted-light)]"><FileText size={22} /><span>No files yet</span></div> : null}
          </section>
        </div>
      </div>
    </div>
  );
}
