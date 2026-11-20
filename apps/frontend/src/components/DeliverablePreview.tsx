import { Download, FileSpreadsheet, FileText, Presentation } from "lucide-react";
import { useEffect, useId, useRef, useState, type JSX } from "react";
import { formatBytes } from "../ui-helpers";
import { MarkdownPreview } from "./TaskDetailSections";
import { VideoArtifactPlayer } from "./VideoArtifactPlayer";

const MAX_CSV_ROWS = 500;
const PREVIEW_LINES = 40;

/** Minimal RFC 4180 parser: quoted fields, doubled quotes, CRLF. */
export function parseCsv(text: string, maxRows = MAX_CSV_ROWS + 1): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += char;
  }
  if (rows.length < maxRows && (field !== "" || row.length > 0)) { row.push(field); rows.push(row); }
  return rows;
}

export const withQuery = (src: string, query: string) => `${src}${src.includes("?") ? "&" : "?"}${query}`;
const extensionOf = (path: string) => /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
const OFFICE_FORMATS = new Map([
  ["xlsx", { label: "XLSX spreadsheet", icon: FileSpreadsheet }],
  ["docx", { label: "DOCX document", icon: FileText }],
  ["pptx", { label: "PPTX presentation", icon: Presentation }],
]);

export function isOfficeDeliverable(path: string): boolean {
  return OFFICE_FORMATS.has(extensionOf(path));
}

function useText(src: string, enabled: boolean): { text: string | null; error: boolean } {
  const [state, setState] = useState<{ text: string | null; error: boolean }>({ text: null, error: false });
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void fetch(src, { headers: { accept: "text/*" } })
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error("unavailable"))))
      .then((text) => { if (active) setState({ text, error: false }); })
      .catch(() => { if (active) setState({ text: null, error: true }); });
    return () => { active = false; };
  }, [src, enabled]);
  return state;
}

function CsvTable({ text }: { text: string }): JSX.Element {
  const [sort, setSort] = useState<{ column: number; descending: boolean } | null>(null);
  const [header = [], ...all] = parseCsv(text);
  const truncated = all.length > MAX_CSV_ROWS;
  const rows = all.slice(0, MAX_CSV_ROWS);
  if (sort) {
    const { column, descending } = sort;
    rows.sort((a, b) => {
      const left = a[column] ?? "";
      const right = b[column] ?? "";
      const numeric = left.trim() !== "" && right.trim() !== "" && !Number.isNaN(Number(left)) && !Number.isNaN(Number(right));
      const order = numeric ? Number(left) - Number(right) : left.localeCompare(right);
      return descending ? -order : order;
    });
  }
  return (
    <div className="max-h-72 overflow-auto rounded border border-[var(--border-1)]">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-[var(--card)]">
          <tr>
            {header.map((name, column) => (
              <th key={column} aria-sort={sort?.column === column ? (sort.descending ? "descending" : "ascending") : "none"} className="px-2 py-1 text-left">
                <button type="button" onClick={() => setSort({ column, descending: sort?.column === column && !sort.descending })}>
                  {name}{sort?.column === column ? (sort.descending ? " ▼" : " ▲") : ""}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, rowIndex) => (
            <tr key={rowIndex} className="border-t border-[var(--border-1)]">
              {header.map((_, column) => <td key={column} className="px-2 py-1 align-top">{cells[column] ?? ""}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && <p className="p-1 text-[10px] text-[var(--muted-foreground-2)]">Showing the first {MAX_CSV_ROWS} rows. Download for the full file.</p>}
    </div>
  );
}

/**
 * Safe preview of a deliverable. HTML runs only inside a sandboxed frame without
 * allow-same-origin, so it has no cookie or API access.
 */
export function DeliverablePreview({ src, path, downloadHref, bytes }: { src: string; path: string; downloadHref?: string; bytes?: number }): JSX.Element | null {
  const extension = extensionOf(path);
  const frame = useRef<HTMLIFrameElement>(null);
  const descriptionId = useId();
  const textual = ["md", "txt", "csv", "json"].includes(extension);
  const { text, error } = useText(src, textual);
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(extension)) {
    return (
      <img
        alt={`Preview of ${path}`}
        src={withQuery(src, "inline=1")}
        loading="lazy"
        className="h-auto max-h-80 w-fit max-w-full rounded border border-[var(--border-1)] object-contain"
      />
    );
  }
  if (extension === "mp4") return <VideoArtifactPlayer src={withQuery(src, "inline=1")} title={path} />;
  const office = OFFICE_FORMATS.get(extension);
  if (office) {
    const fileName = path.split("/").pop();
    return (
      <a
        href={downloadHref ?? src}
        download={fileName}
        aria-label={`Download ${path}`}
        aria-describedby={descriptionId}
        className="flex min-h-11 min-w-0 max-w-xl items-center gap-3 rounded border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-[var(--fg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] [@media(hover:hover)]:hover:bg-[var(--card-hover)]"
      >
        <office.icon aria-hidden="true" className="size-5 shrink-0 text-[var(--muted-foreground-1)]" />
        <span className="min-w-0 flex-1">
          <span className="block break-words text-xs font-medium">{fileName}</span>
          <span id={descriptionId} className="block text-[11px] tabular-nums text-[var(--muted-foreground-2)]">
            {office.label}{bytes !== undefined && ` · ${formatBytes(bytes)}`}
          </span>
        </span>
        <Download aria-hidden="true" className="size-4 shrink-0 text-[var(--primary)]" />
      </a>
    );
  }
  if (extension === "html") {
    return (
      <div className="flex flex-col gap-1">
        <iframe ref={frame} title={`Preview of ${path}`} src={withQuery(src, "inline=1")} sandbox="allow-scripts" referrerPolicy="no-referrer" className="h-80 w-full rounded border border-[var(--border-1)] bg-white" />
        <div className="flex gap-3 text-[11px]">
          <button type="button" className="text-[var(--primary)] underline" onClick={() => void frame.current?.requestFullscreen?.()}>Open full screen</button>
          <a className="text-[var(--primary)] underline" href={withQuery(src, "inline=1&print=1")} target="_blank" rel="noopener noreferrer">Print / Save as PDF</a>
        </div>
      </div>
    );
  }
  if (extension === "pdf") {
    return (
      <div className="flex flex-col gap-1">
        <iframe title={`Preview of ${path}`} src={withQuery(src, "inline=1")} sandbox="" className="h-96 w-full rounded border border-[var(--border-1)]" />
        {downloadHref && <a className="w-fit text-[11px] text-[var(--primary)] underline" href={downloadHref} download={path.split("/").pop()}>Download PDF</a>}
      </div>
    );
  }
  if (!textual) return null;
  if (error) return <span className="text-[11px] text-[var(--muted-foreground-2)]">Preview unavailable.</span>;
  if (text === null) return <span className="text-[11px] text-[var(--muted-foreground-2)]">Loading preview…</span>;
  const excerpt = text.split("\n").slice(0, PREVIEW_LINES).join("\n");
  return (
    <div className="flex flex-col gap-1">
      {extension === "csv" ? <CsvTable text={text} /> : (
        <div className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--border-1)] p-2 text-[11px]">
          {extension === "md" ? <MarkdownPreview source={excerpt} /> : <pre>{excerpt}</pre>}
        </div>
      )}
      {downloadHref && <a className="w-fit text-[11px] text-[var(--primary)] underline" href={downloadHref} download={path.split("/").pop()}>Download {path.split("/").pop()}</a>}
    </div>
  );
}
