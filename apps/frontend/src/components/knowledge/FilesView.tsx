import { useCallback, useEffect, useState, type JSX } from "react";
import { FolderPlus, Upload } from "lucide-react";
import type { KnowledgeFile, KnowledgeScope } from "@shiba/shared";
import { LoadErrorState } from "../LoadErrorState";
import { MainCard } from "../ui/ContextPanel";

export function FilesView(): JSX.Element {
  const [scope, setScope] = useState<KnowledgeScope>("personal");
  const [files, setFiles] = useState<KnowledgeFile[]>([]);
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<Array<{ sourceId: string; text: string }>>([]);
  const [folderName, setFolderName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const response = await fetch(`/api/files?scope=${scope}`, { credentials: "same-origin", cache: "no-store" });
    const body = await response.json() as { files?: KnowledgeFile[]; error?: string };
    if (!response.ok || !Array.isArray(body.files)) throw new Error(body.error ?? `Files unavailable (${response.status}).`);
    setFiles(body.files);
  }, [scope]);

  useEffect(() => { void load().catch((err: unknown) => setError(err instanceof Error ? err.message : "Files failed to load.")); }, [load]);

  async function createFolder() {
    if (!folderName.trim()) return;
    setBusy(true);
    try {
      const response = await fetch("/api/files/folders", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: folderName, scope }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Folder create failed.");
      setFolderName("");
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Folder create failed.");
    } finally {
      setBusy(false);
    }
  }

  async function runSearch() {
    if (!query.trim()) return;
    const response = await fetch(`/api/knowledge/search?q=${encodeURIComponent(query)}`, { credentials: "same-origin", cache: "no-store" });
    const body = await response.json() as { hits?: Array<{ sourceId: string; text: string }>; error?: string };
    if (!response.ok) throw new Error(body.error ?? "Search failed.");
    setSearchHits(body.hits ?? []);
  }

  async function uploadTextFile() {
    setBusy(true);
    try {
      const name = `synthetic-${Date.now()}.md`;
      const markdown = `# Synthetic upload\n\nUnique phrase ORION_WS07_PROBE ${Date.now()}\n`;
      const begin = await fetch("/api/files/uploads", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "begin", name, mime: "text/markdown", scope }),
      });
      const beginBody = await begin.json() as { session?: { sessionId: string } ; error?: string };
      if (!begin.ok || !beginBody.session?.sessionId) throw new Error(beginBody.error ?? "Upload session failed.");
      await fetch("/api/files/uploads", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "part", sessionId: beginBody.session.sessionId, partNumber: 1 }),
      });
      const complete = await fetch("/api/files/uploads", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "complete",
          sessionId: beginBody.session.sessionId,
          parts: [{ partNumber: 1, etag: `"fixture"` }],
        }),
      });
      if (!complete.ok) {
        const body = await complete.json() as { error?: string };
        throw new Error(body.error ?? "Upload complete failed.");
      }
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <MainCard>
        <header className="mb-3">
          <h1 className="text-lg font-medium">Files</h1>
          <p className="text-sm text-[var(--muted-foreground-2)]">Upload documents and browse folders. Ingestion runs after each upload completes.</p>
        </header>
        <div className="flex flex-wrap items-center gap-2 pb-3">
          <label className="text-xs text-[var(--muted-foreground-2)]">
            Scope
            <select className="ml-2 border border-[var(--border-1)] bg-[var(--card)] px-2 py-1 text-sm" value={scope} onChange={(e) => setScope(e.target.value as KnowledgeScope)}>
              <option value="personal">Personal</option>
              <option value="workspace">Workspace</option>
            </select>
          </label>
          <button type="button" className="inline-flex items-center gap-1 rounded border border-[var(--border-1)] px-2 py-1 text-sm" disabled={busy} onClick={() => void uploadTextFile()}>
            <Upload size={14} /> Upload sample
          </button>
        </div>
        <div className="flex flex-wrap gap-2 pb-3">
          <input className="min-w-[12rem] flex-1 border border-[var(--border-1)] bg-[var(--card)] px-2 py-1 text-sm" value={folderName} onChange={(e) => setFolderName(e.target.value)} placeholder="New folder name" />
          <button type="button" className="inline-flex items-center gap-1 rounded border border-[var(--border-1)] px-2 py-1 text-sm" disabled={busy} onClick={() => void createFolder()}>
            <FolderPlus size={14} /> Folder
          </button>
        </div>
        <div className="flex flex-wrap gap-2 pb-4">
          <input className="min-w-[12rem] flex-1 border border-[var(--border-1)] bg-[var(--card)] px-2 py-1 text-sm" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search knowledge" />
          <button type="button" className="rounded border border-[var(--border-1)] px-3 py-1 text-sm" onClick={() => void runSearch().catch((err: unknown) => setError(err instanceof Error ? err.message : "Search failed."))}>Search</button>
        </div>
        {error ? <LoadErrorState message={error} onRetry={() => void load()} /> : null}
        <ul className="divide-y divide-[var(--border-1)] text-sm">
          {files.map((file) => (
            <li key={file.id} className="flex items-center justify-between gap-3 py-2">
              <span className="truncate font-medium">{file.name}</span>
              <span className="shrink-0 rounded bg-[var(--panel)] px-2 py-0.5 text-xs text-[var(--muted-foreground-2)]">{file.ingestion.state}</span>
            </li>
          ))}
        </ul>
        {searchHits.length ? (
          <section className="mt-4 border-t border-[var(--border-1)] pt-3 text-sm">
            <h3 className="mb-2 font-medium">Search results</h3>
            <ul className="space-y-2">{searchHits.map((hit) => <li key={`${hit.sourceId}:${hit.text.slice(0, 24)}`} className="text-[var(--muted-foreground-1)]">{hit.text}</li>)}</ul>
          </section>
        ) : null}
      </MainCard>
    </div>
  );
}