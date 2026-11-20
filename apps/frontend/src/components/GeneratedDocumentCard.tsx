import { BookOpen, Download, FileText, Maximize2, PanelsTopLeft, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { MarkdownPreview } from "./TaskDetailSections";

export interface GeneratedDocument {
  kind: "report" | "page";
  artifactId: string;
  title: string;
}

export function isDocumentArtifactId(value: unknown): value is string {
  return typeof value === "string" && /^file_[a-f0-9]{24}$/.test(value);
}

/** A Chat image result rendered from its validated file id, never from a path the tool returned. */
export function GeneratedImageCard({ output, prompt }: { output: unknown; prompt?: unknown }) {
  const result = output && typeof output === "object" ? output as Record<string, unknown> : null;
  if (result?.ok === false && typeof result.error === "string") return <p className="break-words text-sm text-[var(--destructive)]">{result.error}</p>;
  if (result?.ok !== true || !isDocumentArtifactId(result.artifactId)) return null;
  const href = `/api/files/${result.artifactId}/download`;
  return <figure className="flex min-w-0 w-full max-w-2xl flex-col gap-3 border border-[var(--border-1)] bg-[var(--card)] p-4">
    <img src={href} alt={typeof prompt === "string" && prompt.trim() ? prompt : "Created in Chat"} loading="lazy" className="max-h-[60dvh] w-full object-contain" />
    <a className={`${action} self-start`} download href={href}><Download aria-hidden="true" size={14} />Download</a>
  </figure>;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const action = "inline-flex min-h-11 items-center justify-center gap-2 border border-[var(--border-1)] px-3 text-xs font-medium hover:bg-[var(--secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]";

function PagePreview({ artifact, expanded = false }: { artifact: GeneratedDocument; expanded?: boolean }) {
  return <iframe
    title={`Page preview: ${artifact.title}`}
    src={`/api/files/${artifact.artifactId}/preview`}
    sandbox=""
    referrerPolicy="no-referrer"
    loading="lazy"
    className={`block w-full min-w-0 border border-[var(--border-1)] ${expanded ? "h-[72dvh]" : "h-64 max-h-[40dvh]"}`}
  />;
}

function ReportBody({ artifactId }: { artifactId: string }) {
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (error) return;
    const controller = new AbortController();
    void fetch(`/api/files/${artifactId}/download`, { credentials: "same-origin", redirect: "error", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Report unavailable");
        return response.text();
      })
      .then((text) => { if (!controller.signal.aborted) setBody(text); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [artifactId, error]);
  if (error) return <div className="space-y-3">
    <p role="alert">Couldn’t load this report.</p>
    <button type="button" className={action} onClick={() => setError(false)}>Retry</button>
  </div>;
  if (body === null) return <p role="status">Loading report…</p>;
  return <MarkdownPreview source={body} allowMailto={false} />;
}

function DocumentViewer({ artifact, onClose }: { artifact: GeneratedDocument; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return <dialog
    ref={dialog}
    aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
    }}
    className={`m-auto max-h-[90dvh] w-[calc(100%-2rem)] overflow-hidden border border-[var(--border-1)] bg-[var(--card)] p-0 text-[var(--fg)] backdrop:bg-[var(--overlay)] open:flex open:flex-col ${artifact.kind === "page" ? "max-w-5xl" : "max-w-2xl"}`}
  >
    <header className="flex items-center justify-between gap-3 border-b border-[var(--border-1)] px-4 py-2">
      <h2 id={titleId} className="min-w-0 break-words text-base font-semibold">{artifact.title}</h2>
      <button type="button" className={`${action} shrink-0`} onClick={onClose}><X aria-hidden="true" size={14} />Close</button>
    </header>
    <div className="min-h-0 min-w-0 overflow-auto p-4 text-sm leading-relaxed">
      {artifact.kind === "page" ? <PagePreview artifact={artifact} expanded /> : <ReportBody artifactId={artifact.artifactId} />}
    </div>
  </dialog>;
}

export function DocumentActions({ document: artifact, compact = false }: { document: GeneratedDocument; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const report = artifact.kind === "report";
  const Icon = report ? BookOpen : Maximize2;
  return <div className="flex min-w-0 flex-wrap gap-2">
    <button type="button" className={action} aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <Icon aria-hidden="true" size={14} />
      {report ? compact ? "Read" : "Read report" : compact ? "Preview" : "Open preview"}
    </button>
    <a className={action} download href={`/api/files/${artifact.artifactId}/download`}><Download aria-hidden="true" size={14} />Download</a>
    {open && <DocumentViewer key={artifact.artifactId} artifact={artifact} onClose={() => setOpen(false)} />}
  </div>;
}

export function GeneratedDocumentCard({ kind, output }: { kind: GeneratedDocument["kind"]; output: unknown }) {
  if (!output || typeof output !== "object") return null;
  const result = output as Record<string, unknown>;
  if (result.ok === false && typeof result.error === "string") return <p className="break-words text-sm text-[var(--destructive)]">{result.error}</p>;
  if (result.ok !== true || result.kind !== kind || !isDocumentArtifactId(result.artifactId) ||
      typeof result.title !== "string" || !result.title.trim() || typeof result.downloadPath !== "string" ||
      !isCount(result.bytes)) return null;
  const report = kind === "report";
  const sourceCount = report && isCount(result.sourceCount) ? result.sourceCount : null;
  if (report && (result.mime !== "text/markdown" || sourceCount === null)) return null;
  if (!report && (result.mime !== "text/html" || typeof result.previewPath !== "string")) return null;
  const artifact: GeneratedDocument = { kind, title: result.title, artifactId: result.artifactId };
  const Icon = report ? FileText : PanelsTopLeft;
  return <article className="flex min-w-0 w-full max-w-2xl flex-col gap-3 border border-[var(--border-1)] bg-[var(--card)] p-4">
    <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground-2)]">
      <Icon aria-hidden="true" size={16} />
      <span>{report ? "Report" : "Web page"}</span>
      {sourceCount !== null && <span className="border-l border-[var(--border-1)] pl-2">{sourceCount} {sourceCount === 1 ? "source" : "sources"}</span>}
    </div>
    <h3 className="break-words text-base font-semibold text-[var(--fg)]">{artifact.title}</h3>
    {!report && <PagePreview artifact={artifact} />}
    <DocumentActions document={artifact} />
  </article>;
}
