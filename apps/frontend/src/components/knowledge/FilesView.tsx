import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { FolderPlus, Search, Upload } from "lucide-react";
import type { KnowledgeFile, KnowledgeScope, KnowledgeSearchHit } from "@shiba/shared";
import { MarkedSnippet } from "../palette/ResultRow";
import { uploadFile } from "../../files-upload-client";
import { teamWorkspaceHeaders } from "../../team-workspaces-client";
import type { AppNavView } from "../AppNavRail";
import { LoadErrorState } from "../LoadErrorState";
import { MainCard } from "../ui/ContextPanel";
import { FileAppPreview } from "./FileAppPreview";

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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <MainCard>
        <header className="mb-3">
          <h1 className="text-lg font-medium">Files</h1>
          <p className="text-sm text-[var(--muted-foreground-2)]">Upload documents and browse folders. Ingestion runs after each upload completes.</p>
          {onNavigate ? (
            <p className="mt-1 text-xs text-[var(--muted-foreground-2)]">
              Uploaded files are separate from memory sources.{" "}
              <button type="button" className="font-medium text-[var(--fg)] underline underline-offset-2" onClick={() => onNavigate("memory")}>Review memory sources</button>
            </p>
          ) : null}
        </header>
        <div className="flex flex-wrap items-center gap-2 pb-3">
          <label className="text-xs text-[var(--muted-foreground-2)]">
            Scope
            <select className="ml-2 border border-[var(--border-1)] bg-[var(--card)] px-2 py-1 text-sm" value={scope} disabled={busy} onChange={(e) => { setScope(e.target.value as KnowledgeScope); setFolderId(""); setFolders([]); }}>
              <option value="personal">Personal</option>
              <option value="workspace">Workspace</option>
            </select>
          </label>
          <label className="text-xs text-[var(--muted-foreground-2)]">
            Folder
            <select className="ml-2 border border-[var(--border-1)] bg-[var(--card)] px-2 py-1 text-sm" value={folderId} disabled={busy} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">All files</option>
              {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select>
          </label>
          <input ref={inputRef} type="file" multiple hidden aria-label="Upload files" disabled={busy} onChange={(e) => {
            if (e.currentTarget.files) void uploadFiles(e.currentTarget.files);
            e.currentTarget.value = "";
          }} />
          <button type="button" className="inline-flex items-center gap-1 rounded border border-[var(--border-1)] px-2 py-1 text-sm" disabled={busy} onClick={() => inputRef.current?.click()}>
            <Upload size={14} /> Upload
          </button>
        </div>
        <div className="flex flex-wrap gap-2 pb-3">
          <input className="min-w-[12rem] flex-1 border border-[var(--border-1)] bg-[var(--card)] px-2 py-1 text-sm" value={folderName} onChange={(e) => setFolderName(e.target.value)} placeholder="New folder name" />
          <button type="button" className="inline-flex items-center gap-1 rounded border border-[var(--border-1)] px-2 py-1 text-sm" disabled={busy} onClick={() => void createFolder()}>
            <FolderPlus size={14} /> Folder
          </button>
        </div>
        <form role="search" aria-label="Search knowledge" className="flex flex-wrap gap-2 pb-4" onSubmit={(e) => {
          e.preventDefault();
          void runSearch().catch((err: unknown) => setError(err instanceof Error ? err.message : "Search failed."));
        }}>
          <input type="search" aria-label="Search files and notes" className="min-w-[12rem] flex-1 border border-[var(--border-1)] bg-[var(--card)] px-2 py-1 text-sm" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search inside files and notes" />
          <button type="submit" className="inline-flex items-center gap-1 rounded border border-[var(--border-1)] px-3 py-1 text-sm disabled:opacity-50" disabled={searching || !query.trim()}>
            <Search size={14} aria-hidden="true" /> {searching ? "Searching…" : "Search"}
          </button>
        </form>
        {searchHits ? (
          <section aria-label="Knowledge search results" aria-live="polite" className="mb-4 border border-[var(--border-1)] bg-[var(--card)]">
            <header className="flex items-center justify-between border-b border-[var(--border-1)] px-3 py-2 text-xs text-[var(--muted-foreground-2)]">
              <span>Matches for <span className="font-medium text-[var(--fg)]">{query.trim()}</span></span>
              <span className="tabular-nums">{searchHits.length} {searchHits.length === 1 ? "passage" : "passages"}</span>
            </header>
            {searchHits.length ? (
              <ol className="divide-y divide-[var(--border-1)] text-sm">
                {searchHits.map((hit) => (
                  <li key={hit.chunkId} className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium">{hit.sourceName || (hit.sourceKind === "note" ? "Untitled note" : "Untitled file")}</span>
                      <span className="shrink-0 rounded bg-[var(--panel)] px-2 py-0.5 text-xs text-[var(--muted-foreground-2)]">{hit.sourceKind === "note" ? "Note" : "File"}{hit.scope ? ` · ${hit.scope === "workspace" ? "Workspace" : "Personal"}` : ""}</span>
                    </div>
                    <p className="mt-1 line-clamp-3 text-[var(--muted-foreground-1)]"><MarkedSnippet text={hit.text.slice(0, 600)} query={query} /></p>
                  </li>
                ))}
              </ol>
            ) : <p className="px-3 py-3 text-sm text-[var(--muted-foreground-2)]">No passages match. Files appear here once their ingestion state is done.</p>}
          </section>
        ) : null}
        {error ? <LoadErrorState message={error} onRetry={() => void load().catch((err: unknown) => setError(err instanceof Error ? err.message : "Files failed to load."))} /> : null}
        <section aria-label="File list" onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
          e.preventDefault();
          void uploadFiles(e.dataTransfer.files);
        }}>
          <p className="pb-2 text-xs text-[var(--muted-foreground-2)]">Drop files here to upload{folderId ? " into the selected folder" : ""}.</p>
          {uploads.length ? <ul aria-live="polite" className="pb-3 text-sm">
            {uploads.map((upload) => <li key={upload.id}>
              {upload.name}: {upload.state} · {upload.done} / {upload.total} parts
              {upload.error ? <span role="alert"> — {upload.error}</span> : null}
            </li>)}
          </ul> : null}
          <ul className="divide-y divide-[var(--border-1)] text-sm">
            {files.map((file) => {
              const canPreview = appPreviewOwner && scope === "personal" && file.scope === "personal" &&
                file.createdBy?.trim().toLowerCase() === appPreviewOwner &&
                file.workspaceId === "self-hosted" && file.archivedAt === null && file.mime === "application/json" &&
                /^file_[a-f0-9]{24}$/.test(file.id) && file.name.endsWith(".app-preview.json");
              return <li key={file.id} className={canPreview ? "flex flex-wrap items-center gap-x-3 gap-y-2 py-2" : "flex items-center justify-between gap-3 py-2"}>
                <span className={canPreview ? "min-w-0 flex-1 font-medium [overflow-wrap:anywhere]" : "truncate font-medium"}>{file.name}</span>
                <span className="hidden shrink-0 text-xs text-[var(--muted-foreground-2)] sm:inline">{file.mime}</span>
                <span className="shrink-0 text-xs text-[var(--muted-foreground-2)]">{new Date(file.updatedAt).toLocaleDateString()}</span>
                <span className="shrink-0 text-xs text-[var(--muted-foreground-2)]">{file.size.toLocaleString()} bytes</span>
                <span className="shrink-0 rounded bg-[var(--panel)] px-2 py-0.5 text-xs text-[var(--muted-foreground-2)]">{file.ingestion.state}</span>
                {canPreview && <div className="basis-full sm:basis-auto"><FileAppPreview key={appPreviewOwner} fileId={file.id} fileName={file.name} /></div>}
              </li>;
            })}
          </ul>
        </section>
      </MainCard>
    </div>
  );
}
