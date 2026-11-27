import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { BookOpen, Code, FileArchive, FileSpreadsheet, FileText, FolderPlus, LayoutGrid, List, Plus, Search, Upload } from "lucide-react";
import type { KnowledgeFile, KnowledgeScope, KnowledgeSearchHit } from "@shiba/shared";
import { MarkedSnippet } from "../palette/ResultRow";
import { uploadFile } from "../../files-upload-client";
import { teamWorkspaceHeaders } from "../../team-workspaces-client";
import type { AppNavView } from "../AppNavRail";
import { LoadErrorState } from "../LoadErrorState";
import { FileAppPreview } from "./FileAppPreview";
import { queueNewNoteIntent } from "./new-note-intent";

type FolderRow = { id: string; name: string; parent_id?: string | null };

function folderPathLabel(folder: FolderRow, folders: FolderRow[], depth = 0): string {
  if (!folder.parent_id || depth > 12) return folder.name;
  const parent = folders.find((item) => item.id === folder.parent_id);
  return parent ? `${folderPathLabel(parent, folders, depth + 1)}/${folder.name}` : folder.name;
}

const REVEAL_ON_HOVER = "transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100";

export function FilesView({ onNavigate, appPreviewOwner, workspaceId }: { onNavigate?: (view: AppNavView) => void; appPreviewOwner?: string; workspaceId?: string | null } = {}): JSX.Element {
  const [scope, setScope] = useState<KnowledgeScope>("personal");
  const [files, setFiles] = useState<KnowledgeFile[]>([]);
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<KnowledgeSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [folderId, setFolderId] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const folderUploadRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const uploadingRef = useRef(false);
  const fileRequest = useRef(0);
  const folderRequest = useRef(0);
  const [uploads, setUploads] = useState<Array<{ id: number; name: string; done: number; total: number; state: string; error?: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [layout, setLayout] = useState<"list" | "cards">("list");
  const [searchOpen, setSearchOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [folderFormOpen, setFolderFormOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
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
    const body = await response.json() as { folders?: FolderRow[]; error?: string };
    if (!response.ok || !Array.isArray(body.folders)) throw new Error(body.error ?? "Folders unavailable.");
    if (request === folderRequest.current) setFolders(body.folders);
  }, [scope, workspaceHeaders]);

  useEffect(() => {
    void loadFolders().catch((err: unknown) => setError(err instanceof Error ? err.message : "Folders failed to load."));
    return () => { folderRequest.current++; };
  }, [loadFolders]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (createOpen) folderInputRef.current?.focus();
  }, [createOpen]);

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
      setCreateOpen(false);
      setFolderFormOpen(false);
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

  function closeSearch() {
    setSearchHits(null);
    setQuery("");
    setSearchOpen(false);
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
    const createdFolders = new Map<string, string>();
    const uploadFolderFor = async (file: File) => {
      const parts = ((file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "").split("/").filter(Boolean);
      if (parts.length < 2) return folderId || null;
      let parentId = folderId || null;
      for (let index = 0; index < parts.length - 1; index++) {
        const path = parts.slice(0, index + 1).join("/");
        const cached = createdFolders.get(path);
        if (cached) { parentId = cached; continue; }
        const response = await fetch(`/api/files/folders?scope=${scope}`, {
          method: "POST", credentials: "same-origin",
          headers: { ...workspaceHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ name: parts[index], scope, parentId }),
        });
        const body = await response.json() as { folder?: { id?: string }; error?: string };
        if (!response.ok || typeof body.folder?.id !== "string") throw new Error(body.error ?? "Folder create failed.");
        parentId = body.folder.id;
        createdFolders.set(path, parentId);
      }
      return parentId;
    };
    try {
      for (const [index, file] of batch.entries()) {
        update(index, { state: "Uploading" });
        try {
          await uploadFile(file, {
            scope, folderId: await uploadFolderFor(file), headers: workspaceHeaders,
            onProgress: (done, total) => update(index, { done, total }),
          });
          update(index, { state: "Uploaded" });
        } catch (err: unknown) {
          update(index, { state: "Failed", error: err instanceof Error ? err.message : "Upload failed." });
          continue;
        }
        await load().catch((err: unknown) => setError(err instanceof Error ? err.message : "Files failed to load."));
      }
      if (createdFolders.size) await loadFolders().catch(() => undefined);
    } finally {
      uploadingRef.current = false;
      setBusy(false);
    }
  }

  const iconFor = (file: KnowledgeFile, size = 15) => {
    const mime = (file.mime ?? "").toLowerCase();
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (mime === "application/pdf" || extension === "pdf") return <img src="/assets/file-icons/pdf.svg" alt="" width={size} height={size} className="shrink-0 object-contain" aria-hidden="true" />;
    if (mime === "application/json" || extension === "json") return <Code size={size} className="shrink-0 text-amber-700 dark:text-amber-300" />;
    if (["htm", "html", "js", "jsx", "ts", "tsx", "css", "xml", "yaml", "yml", "toml", "py", "sh"].includes(extension) || mime.includes("html")) return <Code size={size} className="shrink-0 text-cyan-700 dark:text-cyan-300" />;
    if (mime === "text/csv" || extension === "csv" || mime.includes("spreadsheet")) return <FileSpreadsheet size={size} className="shrink-0 text-emerald-700 dark:text-emerald-300" />;
    if (mime.includes("markdown") || ["md", "markdown"].includes(extension)) return <FileText size={size} className="shrink-0 text-indigo-700 dark:text-indigo-300" />;
    if (mime.startsWith("text/") || ["txt", "log"].includes(extension)) return <FileText size={size} className="shrink-0 text-zinc-600 dark:text-zinc-300" />;
    return <FileArchive size={size} className="shrink-0 text-neutral-500 dark:text-neutral-300" />;
  };

  const iconFrameFor = (file: KnowledgeFile) => {
    const mime = (file.mime ?? "").toLowerCase();
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (mime === "application/pdf" || extension === "pdf") return "bg-white ring-1 ring-black/5";
    if (mime === "application/json" || extension === "json") return "bg-amber-100 dark:bg-amber-950/45";
    if (["htm", "html", "js", "jsx", "ts", "tsx", "css", "xml", "yaml", "yml", "toml", "py", "sh"].includes(extension) || mime.includes("html")) return "bg-cyan-100 dark:bg-cyan-950/45";
    if (mime === "text/csv" || extension === "csv" || mime.includes("spreadsheet")) return "bg-emerald-100 dark:bg-emerald-950/45";
    if (mime.includes("markdown") || ["md", "markdown"].includes(extension)) return "bg-indigo-100 dark:bg-indigo-950/45";
    if (mime.startsWith("text/") || ["txt", "log"].includes(extension)) return "bg-zinc-100 dark:bg-zinc-900/60";
    return "bg-neutral-100 dark:bg-neutral-900/60";
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg)] text-[var(--fg)]">
      <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 px-6 py-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="truncate text-sm font-normal tracking-[-0.01em]">All</h1>
          <span className="text-xs leading-5 text-[var(--muted-light)]">{files.length} {files.length === 1 ? "item" : "items"}</span>
          <span className="text-xs leading-5 text-[var(--muted-light)]">/</span>
          <label className="flex items-center text-xs leading-5 text-[var(--muted-light)]">
            <span className="sr-only">Scope</span>
            <select aria-label="Scope" className="max-w-24 bg-transparent text-xs text-[var(--muted-foreground-2)] outline-none transition-colors hover:text-[var(--fg)]" value={scope} disabled={busy} onChange={(e) => { setScope(e.target.value as KnowledgeScope); setFolderId(""); setFolders([]); }}>
              <option value="personal">Personal</option>
              <option value="workspace">Workspace</option>
            </select>
          </label>
          <span className="text-xs leading-5 text-[var(--muted-light)]">/</span>
          <label className="flex items-center text-xs leading-5 text-[var(--muted-light)]">
            <span className="sr-only">Folder</span>
            <select aria-label="Folder" className="max-w-24 bg-transparent text-xs text-[var(--muted-foreground-2)] outline-none transition-colors hover:text-[var(--fg)]" value={folderId} disabled={busy} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">All files</option>
              {folders.map((folder) => <option key={folder.id} value={folder.id}>{folderPathLabel(folder, folders)}</option>)}
            </select>
          </label>
          {onNavigate ? (
            <button type="button" className="text-xs leading-5 text-[var(--muted-foreground-2)] underline-offset-2 transition-colors hover:text-[var(--fg)] hover:underline" onClick={() => onNavigate("memory")}>Review memory sources</button>
          ) : null}
        </div>

        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2 overflow-x-auto scrollbar-none max-sm:order-2 max-sm:w-full max-sm:overflow-visible sm:ml-auto sm:w-auto sm:overflow-visible [&::-webkit-scrollbar]:hidden">
          {searchOpen ? <form role="search" aria-label="Search knowledge" aria-busy={searching} className="relative block w-52 max-w-[45vw]" onSubmit={(e) => {
            e.preventDefault();
            void runSearch().catch((err: unknown) => setError(err instanceof Error ? err.message : "Search failed."));
          }}>
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--muted-foreground-2)]" />
            <input ref={searchInputRef} type="search" aria-label="Search files and notes" className="h-8 w-full rounded-md border border-[var(--border-1)] bg-[var(--card)] pl-8 pr-3 text-xs outline-none placeholder:text-[var(--muted-light)] focus:border-[var(--border-3)]" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") closeSearch(); }} placeholder="Search files…" />
          </form> : null}
          <button type="button" title={searchOpen ? "Close search files" : "Search files"} aria-label={searchOpen ? "Close search files" : "Search files"} aria-pressed={searchOpen} onClick={() => { searchOpen ? closeSearch() : setSearchOpen(true); }} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border-1)] bg-[var(--card)] text-[var(--muted-foreground-2)] transition-colors hover:bg-[var(--card-hover)] hover:text-[var(--fg)]">
            <Search size={15} />
          </button>
          <div className="flex h-8 items-center rounded-md border border-[var(--border-1)] bg-[var(--panel)] p-0.5">
            <button type="button" title="List" aria-label="List layout" aria-pressed={layout === "list"} onClick={() => setLayout("list")} className={`inline-flex h-7 items-center rounded px-2 transition-colors ${layout === "list" ? "bg-[var(--card)] text-[var(--fg)] shadow-xs" : "text-[var(--muted-light)] hover:text-[var(--fg)]"}`}><List size={14} /></button>
            <button type="button" title="Cards" aria-label="Cards layout" aria-pressed={layout === "cards"} onClick={() => setLayout("cards")} className={`inline-flex h-7 items-center rounded px-2 transition-colors ${layout === "cards" ? "bg-[var(--card)] text-[var(--fg)] shadow-xs" : "text-[var(--muted-light)] hover:text-[var(--fg)]"}`}><LayoutGrid size={14} /></button>
          </div>
          <div className="relative">
            <button type="button" title="Create" aria-label="Create folder" aria-expanded={createOpen} aria-haspopup="menu" onClick={() => {
                setCreateOpen((open) => !open);
                setFolderFormOpen(false);
                setUploadOpen(false);
              }} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border-1)] bg-[var(--card)] text-[var(--muted-foreground-2)] transition-colors hover:bg-[var(--card-hover)] hover:text-[var(--fg)]">
              <Plus size={15} />
            </button>
            {createOpen ? <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-40 rounded-lg border border-[var(--border-1)] bg-[var(--card)] py-1 shadow-lg">
              {!folderFormOpen ? <>
                <button type="button" role="menuitem" className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-[var(--muted-foreground-2)] transition-colors hover:bg-[var(--card-hover)] hover:text-[var(--fg)]" onClick={() => {
                  setCreateOpen(false);
                  setFolderFormOpen(false);
                  if (onNavigate) queueNewNoteIntent(scope);
                  onNavigate?.("notes");
                }}>
                  <BookOpen size={13} /> New Note
                </button>
                <button type="button" role="menuitem" className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-[var(--muted-foreground-2)] transition-colors hover:bg-[var(--card-hover)] hover:text-[var(--fg)]" onClick={() => setFolderFormOpen(true)}>
                  <FolderPlus size={13} /> New Folder
                </button>
              </> : <form className="flex items-center gap-1 px-2 py-1.5" onSubmit={(e) => {
                e.preventDefault();
                void createFolder();
              }}>
                <input ref={folderInputRef} aria-label="New folder name" className="h-7 min-w-0 flex-1 rounded-md border border-[var(--border-1)] bg-[var(--panel)] px-2 text-xs outline-none placeholder:text-[var(--muted-light)] focus:border-[var(--border-3)]" value={folderName} onChange={(e) => setFolderName(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setCreateOpen(false); }} placeholder="Folder name" />
                <button type="submit" aria-label="Create named folder" title="Create folder" className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground-2)] transition-colors hover:bg-[var(--card-hover)] hover:text-[var(--fg)] disabled:opacity-50" disabled={busy}>
                  <FolderPlus size={13} />
                </button>
              </form>}
            </div> : null}
          </div>
          <input ref={inputRef} type="file" multiple hidden aria-label="Upload files" disabled={busy} onChange={(e) => {
            if (e.currentTarget.files) void uploadFiles(e.currentTarget.files);
            e.currentTarget.value = "";
          }} />
          <input ref={folderUploadRef} type="file" multiple hidden aria-label="Upload folder" disabled={busy} {...({ webkitdirectory: "" } as Record<string, string>)} onChange={(e) => {
            if (e.currentTarget.files) void uploadFiles(e.currentTarget.files);
            e.currentTarget.value = "";
          }} />
          <div className="relative">
            <button type="button" className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border-1)] bg-[var(--card)] text-[var(--muted-foreground-2)] transition-colors hover:bg-[var(--card-hover)] hover:text-[var(--fg)] disabled:opacity-50" aria-label="Upload" title="Upload" aria-expanded={uploadOpen} aria-haspopup="menu" disabled={busy} onClick={() => {
              setUploadOpen((open) => !open);
              setCreateOpen(false);
              setFolderFormOpen(false);
            }}>
              <Upload size={15} />
            </button>
            {uploadOpen ? <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-44 rounded-lg border border-[var(--border-1)] bg-[var(--card)] py-1 shadow-lg">
              <button type="button" role="menuitem" className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-[var(--muted-foreground-2)] transition-colors hover:bg-[var(--card-hover)] hover:text-[var(--fg)]" onClick={() => {
                setUploadOpen(false);
                inputRef.current?.click();
              }}>
                <FileText size={13} /> Upload File
              </button>
              <button type="button" role="menuitem" className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-[var(--muted-foreground-2)] transition-colors hover:bg-[var(--card-hover)] hover:text-[var(--fg)]" onClick={() => {
                setUploadOpen(false);
                folderUploadRef.current?.click();
              }}>
                <FolderPlus size={13} /> Upload Folder
              </button>
            </div> : null}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className={`mx-auto w-full ${layout === "cards" ? "max-w-[1440px]" : "max-w-3xl"}`}>
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
                    <span className={`shrink-0 rounded-full bg-[var(--surface-subtle)] px-2 py-0.5 text-[11px] leading-4 text-[var(--muted-foreground-2)] ${REVEAL_ON_HOVER}`}>{file.ingestion.state}</span>
                    {canPreview && <div className="basis-full sm:basis-auto"><FileAppPreview key={appPreviewOwner} fileId={file.id} fileName={file.name} /></div>}
                  </li>;
                })}
              </ul>
            ) : (
              <ul className="columns-1 gap-4 gap-x-4 sm:columns-2 lg:columns-3 xl:columns-4">
                {files.map((file) => {
                  const canPreview = appPreviewOwner && scope === "personal" && file.scope === "personal" &&
                    file.createdBy?.trim().toLowerCase() === appPreviewOwner &&
                    file.workspaceId === "self-hosted" && file.archivedAt === null && file.mime === "application/json" &&
                    /^file_[a-f0-9]{24}$/.test(file.id) && file.name.endsWith(".app-preview.json");
                  return <li key={file.id} className="mb-4 break-inside-avoid overflow-hidden rounded-xl border border-[var(--border-1)] bg-[var(--card)] shadow-xs transition-shadow hover:shadow-md">
                    <div className="flex h-28 items-center justify-center bg-[var(--panel)]"><span className={`inline-flex size-16 items-center justify-center rounded-lg shadow-xs ${iconFrameFor(file)}`}>{iconFor(file, 36)}</span></div>
                    <div className="px-3 py-2">
                      <p className="line-clamp-2 text-xs font-medium">{file.name}</p>
                      <p className="mt-1 line-clamp-2 text-[10px] text-[var(--muted-foreground-2)]">{file.folderId ? folders.find((folder) => folder.id === file.folderId)?.name ?? "Folder" : "All files"}</p>
                      <p className="mt-1 text-[10px] text-[var(--muted-light)]">{new Date(file.updatedAt).toLocaleDateString("en-US")}</p>
                      {canPreview && <FileAppPreview key={appPreviewOwner} fileId={file.id} fileName={file.name} />}
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
