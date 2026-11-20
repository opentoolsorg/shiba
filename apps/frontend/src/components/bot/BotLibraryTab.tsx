import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Eye, FileText, Paperclip, X } from "lucide-react";
import { MAX_BOT_LIBRARY_FILES } from "@shiba/shared";
import type { RunStatus } from "@shiba/shared";
import { botFileDownloadPath, previewLimitation, type BotLibraryLink } from "../../bot-library";
import { listAttachableFiles, readBotLibraryLink, type AuthorizedBotFile } from "../../bot-files";
import { DeliverablePreview } from "../DeliverablePreview";
import { VideoArtifactPlayer } from "../VideoArtifactPlayer";
import { BotSectionState, FIELD_CLASS, QUIET_BUTTON, botRunsScopeNote, formatBytes, type BotNoticeTone, type BotRunsScope } from "./BotPanel";

/** One captured file from a run this bot started. */
export interface BotRunOutput {
  runId: string;
  runStatus: RunStatus;
  runCreatedAt: number;
  /**
   * The conversation that owns the run. Runs are stored per session and the
   * route reads only the requested one, so a link without it cannot reach a
   * file captured in a named thread.
   */
  sessionId: string;
  path: string;
  index: number;
  bytes?: number;
  mediaType?: string;
}

/** Retained deliverable URL, carrying the owning session when it is not the default one. */
export function botRunOutputPath(output: Pick<BotRunOutput, "runId" | "index" | "sessionId">): string {
  const route = `/api/runs/${encodeURIComponent(output.runId)}/deliverables/${output.index}`;
  return output.sessionId && output.sessionId !== "default"
    ? `${route}?${new URLSearchParams({ session: output.sessionId })}`
    : route;
}

const previewKind = (name: string, mime?: string): "text" | "image" | "video" | "embed" | null => {
  if (previewLimitation(name, mime) !== null) return null;
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "mp4" || mime === "video/mp4") return "video";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif"].includes(extension) || (mime ?? "").startsWith("image/")) return "image";
  return extension === "html" || extension === "pdf" ? "embed" : "text";
};

function Preview({ src, name, mime, downloadHref }: { src: string; name: string; mime?: string; downloadHref?: string }) {
  const kind = previewKind(name, mime);
  if (kind === "video") return <VideoArtifactPlayer src={src} title={name} />;
  if (kind === "image") {
    return (
      <figure className="flex flex-col gap-1">
        <img src={src} alt={name} loading="lazy" className="max-h-56 w-full border border-[var(--border-1)] bg-[var(--panel-2)] object-contain" />
        {downloadHref ? <a href={downloadHref} download={name} className="w-fit text-[11px] text-[var(--primary)] underline">Download {name}</a> : null}
      </figure>
    );
  }
  if (kind === "embed" || kind === "text") return <DeliverablePreview src={src} path={name} downloadHref={downloadHref} />;
  return <BotSectionState>{previewLimitation(name, mime) ?? "No in-panel preview."} Download it to open it.</BotSectionState>;
}

export function BotLibraryTab({
  canEdit,
  linkedFileIds,
  onLinkFiles,
  deliverables,
  onDeliverablesSave,
  runs,
  runsScope,
  onOpenRun,
  onLibraryNotice,
}: {
  canEdit: boolean;
  linkedFileIds: readonly string[];
  onLinkFiles: ((ids: readonly string[]) => Promise<void>) | undefined;
  deliverables: readonly string[];
  onDeliverablesSave: ((paths: readonly string[]) => Promise<void>) | undefined;
  runs: readonly BotRunOutput[];
  /** Which conversation these outputs were read from, and whether the read landed. */
  runsScope?: BotRunsScope;
  onOpenRun?: (runId: string) => void;
  onLibraryNotice: (notice: { tone: BotNoticeTone; text: string } | null) => void;
}) {
  const [links, setLinks] = useState<BotLibraryLink[]>([]);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linksLoading, setLinksLoading] = useState(false);
  const [openPreview, setOpenPreview] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);

  // Each link is resolved through the file route, so this is also the access
  // check: a file this viewer may not read resolves to "missing" here.
  const resolveLinks = useCallback(async (ids: readonly string[], signal: AbortSignal) => {
    const current = ++request.current;
    if (ids.length === 0) { setLinks([]); setLinkError(null); setLinksLoading(false); return; }
    setLinksLoading(true);
    setLinkError(null);
    setLinks(ids.map((fileId) => ({ fileId, status: "loading" })));
    const settled = await Promise.all(ids.map(async (fileId) => {
      try { return await readBotLibraryLink(fileId, signal); }
      catch (error) { return { fileId, status: "error", error: error instanceof Error ? error.message : "Could not read the file." } as BotLibraryLink; }
    }));
    if (current !== request.current || signal.aborted) return;
    setLinks(settled);
    setLinksLoading(false);
    const failed = settled.filter((link) => link.status === "error");
    setLinkError(failed.length ? `${failed.length} linked file${failed.length === 1 ? "" : "s"} could not be checked.` : null);
  }, []);

  const linkKey = linkedFileIds.join(",");
  useEffect(() => {
    const controller = new AbortController();
    void resolveLinks(linkKey ? linkKey.split(",") : [], controller.signal);
    return () => controller.abort();
  }, [linkKey, resolveLinks]);

  async function commitLinks(next: readonly string[], ok: string) {
    if (!onLinkFiles) return;
    setBusy(true);
    onLibraryNotice(null);
    try {
      await onLinkFiles(next);
      onLibraryNotice({ tone: "ok", text: ok });
      setPickerOpen(false);
    } catch (error) {
      onLibraryNotice({ tone: "err", text: error instanceof Error ? error.message : "Could not save the library." });
    } finally {
      setBusy(false);
    }
  }

  const runGroups = useMemo(() => {
    const byRun = new Map<string, BotRunOutput[]>();
    for (const output of runs) {
      const list = byRun.get(output.runId) ?? [];
      list.push(output);
      byRun.set(output.runId, list);
    }
    return [...byRun.entries()];
  }, [runs]);

  const atCap = linkedFileIds.length >= MAX_BOT_LIBRARY_FILES;

  return (
    <div role="tabpanel" id="agent-panel-library" aria-labelledby="agent-tab-library" className="flex flex-col gap-5 pt-2">
      <section aria-labelledby="bot-library-files" className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 id="bot-library-files" className="text-xs font-medium text-[var(--muted-foreground-2)]">Files</h3>
          <p className="font-mono text-[10px] text-[var(--muted-foreground-2)]">{linkedFileIds.length}/{MAX_BOT_LIBRARY_FILES}</p>
        </div>
        <p className="text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
          Documents from this workspace that this bot's work may use. A link stores the file's id, not its bytes: opening
          one still runs the file's own access check, so a link can never widen who may read it.
        </p>
        {linksLoading ? <p role="status" className="text-[11px] text-[var(--muted-foreground-2)]">Checking the linked files…</p> : null}
        {linkError ? <BotSectionState tone="error" retry={() => void resolveLinks(linkedFileIds, new AbortController().signal)}>{linkError}</BotSectionState> : null}
        {links.length > 0 ? (
          <ul aria-label="Bot library files" className="flex flex-col gap-1.5">
            {links.map((link) => (
              <li key={link.fileId} className="rounded-md border border-[var(--border-1)] bg-[var(--card)]">
                <div className="flex items-start gap-2 px-3 py-2">
                  <FileText aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-[var(--icon-muted)]" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-[var(--fg)]">{link.name ?? (link.status === "loading" ? "Checking…" : "Linked file")}</p>
                    <p className="mt-0.5 break-words text-[11px] text-[var(--muted-foreground-2)]">
                      {link.status === "ready"
                        ? [link.scope === "workspace" ? "Workspace file" : "Personal file", link.size !== undefined ? formatBytes(link.size) : null, link.mime].filter(Boolean).join(" · ")
                        : link.status === "missing"
                          ? (link.error ?? "Removed, or not available to you.")
                          : link.status === "error"
                            ? (link.error ?? "Unavailable.")
                            : "Checking access…"}
                    </p>
                  </div>
                  {link.status === "ready" && link.name ? (
                    <>
                      <button
                        type="button"
                        aria-label={`Preview ${link.name}`}
                        aria-expanded={openPreview === link.fileId}
                        onClick={() => setOpenPreview(openPreview === link.fileId ? null : link.fileId)}
                        className={`${QUIET_BUTTON} min-h-7 min-w-7`}
                      >
                        <Eye aria-hidden="true" className="size-3.5" />
                      </button>
                      <a
                        href={botFileDownloadPath(link.fileId)}
                        download={link.name}
                        aria-label={`Download ${link.name}`}
                        className={`${QUIET_BUTTON} min-h-7 min-w-7`}
                      >
                        <Download aria-hidden="true" className="size-3.5" />
                      </a>
                    </>
                  ) : null}
                  {canEdit && onLinkFiles ? (
                    <button
                      type="button"
                      aria-label={`Remove ${link.name ?? "linked file"}`}
                      title="Unlink this file"
                      disabled={busy}
                      onClick={() => void commitLinks(linkedFileIds.filter((id) => id !== link.fileId), "Unlinked. The file itself is untouched.")}
                      className={`${QUIET_BUTTON} min-h-7 min-w-7 disabled:opacity-50`}
                    >
                      <X aria-hidden="true" className="size-3.5" />
                    </button>
                  ) : null}
                </div>
                {openPreview === link.fileId && link.status === "ready" && link.name ? (
                  <div className="border-t border-[var(--border-1)] p-3">
                    <Preview
                      src={botFileDownloadPath(link.fileId)}
                      name={link.name}
                      mime={link.mime}
                      downloadHref={botFileDownloadPath(link.fileId)}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : !linksLoading && !linkError ? (
          <BotSectionState>
            No files linked yet. {canEdit ? "Attach a workspace or personal document to give this bot a library." : ""}
          </BotSectionState>
        ) : null}
        {canEdit && onLinkFiles ? (
          pickerOpen ? (
            <BotFilePicker
              existing={linkedFileIds}
              atCap={atCap}
              busy={busy}
              onCancel={() => setPickerOpen(false)}
              onPick={(file) => void commitLinks([...linkedFileIds, file.id], `${file.name} is now linked to this bot.`)}
            />
          ) : (
            <button
              type="button"
              disabled={busy || atCap}
              onClick={() => setPickerOpen(true)}
              className="inline-flex min-h-9 w-fit items-center gap-1.5 rounded-md border border-[var(--border-1)] bg-[var(--card)] px-3 text-[11px] text-[var(--fg)] disabled:opacity-50"
            >
              <Paperclip aria-hidden="true" className="size-3.5" />Attach a file
            </button>
          )
        ) : null}
      </section>

      <section aria-labelledby="bot-library-outputs" className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 id="bot-library-outputs" className="text-xs font-medium text-[var(--muted-foreground-2)]">Run outputs</h3>
          <p className="font-mono text-[10px] text-[var(--muted-foreground-2)]">{runs.length} captured</p>
        </div>
        <p className="text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
          Files captured from runs this bot started{runsScope?.threadName ? ` in ${runsScope.threadName}` : ""}. They are read from the run that produced them, not from this bot.
        </p>
        {runGroups.length === 0 ? (
          <BotSectionState>
            {runsScope?.state === "loading"
              ? "Loading this bot's captured files…"
              : runsScope?.state === "error"
                ? "This bot's runs could not be read just now, so nothing is listed. Reload to try again."
                : `No captured output${runsScope?.threadName ? ` in ${runsScope.threadName}` : ""} yet. A completed run lists its captured files here.`}
          </BotSectionState>
        ) : (
          <ul aria-label="Bot run outputs" className="flex flex-col gap-2">
            {runGroups.map(([runId, outputs]) => {
              const first = outputs[0];
              return (
                <li key={runId} className="rounded-md border border-[var(--border-1)] bg-[var(--card)] px-3 py-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--fg)]">{runId.slice(0, 12)}</p>
                    <span className="shrink-0 border border-[var(--border-1)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-[var(--muted-foreground-2)]">{first?.runStatus}</span>
                  </div>
                  <ul className="mt-1 flex flex-col gap-1">
                    {outputs.map((output) => {
                      const src = botRunOutputPath(output);
                      const name = output.path.split("/").pop() || output.path;
                      const key = `${output.runId}:${output.index}`;
                      return (
                        <li key={key} className="flex flex-col gap-1">
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--fg)]">{output.path}</span>
                            <button
                              type="button"
                              aria-label={`Preview ${output.path}`}
                              aria-expanded={openPreview === `run:${key}`}
                              onClick={() => setOpenPreview(openPreview === `run:${key}` ? null : `run:${key}`)}
                              className={`${QUIET_BUTTON} min-h-7 min-w-7`}
                            >
                              <Eye aria-hidden="true" className="size-3.5" />
                            </button>
                            <a href={src} download={name} aria-label={`Download ${output.path}`} className={`${QUIET_BUTTON} min-h-7 min-w-7`}>
                              <Download aria-hidden="true" className="size-3.5" />
                            </a>
                          </div>
                          {openPreview === `run:${key}` ? (
                            <Preview src={src} name={output.path} mime={output.mediaType} downloadHref={src} />
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                  {onOpenRun ? (
                    <button type="button" onClick={() => onOpenRun(runId)} className="mt-1 text-[11px] text-[var(--primary)] underline">
                      Open this run
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {botRunsScopeNote(runsScope) ? <BotSectionState>{botRunsScopeNote(runsScope)}</BotSectionState> : null}
      </section>

      <BotDeliverablesSection
        canEdit={Boolean(onDeliverablesSave)}
        deliverables={deliverables}
        onSave={onDeliverablesSave}
        onLibraryNotice={onLibraryNotice}
      />
    </div>
  );
}

function BotDeliverablesSection({ canEdit, deliverables, onSave, onLibraryNotice }: {
  canEdit: boolean;
  deliverables: readonly string[];
  onSave: ((paths: readonly string[]) => Promise<void>) | undefined;
  onLibraryNotice: (notice: { tone: BotNoticeTone; text: string } | null) => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const commit = async (next: readonly string[], ok: string) => {
    if (!onSave) return;
    setBusy(true);
    onLibraryNotice(null);
    try {
      await onSave(next);
      onLibraryNotice({ tone: "ok", text: ok });
      setDraft("");
    } catch (error) {
      onLibraryNotice({ tone: "err", text: error instanceof Error ? error.message : "Could not save the library." });
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    const path = draft.trim();
    if (!path || deliverables.includes(path)) return;
    void commit([...deliverables, path], `${path} is now required by this bot's approvals.`);
  };
  return (
    <section aria-labelledby="bot-library-required" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 id="bot-library-required" className="text-xs font-medium text-[var(--muted-foreground-2)]">Required outputs</h3>
        <p className="font-mono text-[10px] text-[var(--muted-foreground-2)]">{deliverables.length} declared</p>
      </div>
      <p className="text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
        Paths this bot's approvals must produce. These are declarations frozen into the next approval, not files: nothing
        is stored here until a run captures one.
      </p>
      {deliverables.length > 0 ? (
        <ul aria-label="Required output paths" className="flex flex-col gap-1.5">
          {deliverables.map((path) => (
            <li key={path} className="flex items-center gap-2 rounded-md border border-dashed border-[var(--border-1)] px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--fg)]">{path}</span>
              <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-[var(--muted-foreground-2)]">Path, not a file</span>
              {canEdit && onSave ? (
                <button
                  type="button"
                  aria-label={`Remove ${path}`}
                  disabled={busy}
                  onClick={() => void commit(deliverables.filter((item) => item !== path), `${path} is no longer required.`)}
                  className={`${QUIET_BUTTON} min-h-7 min-w-7 disabled:opacity-50`}
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <BotSectionState>No required outputs yet.</BotSectionState>
      )}
      {canEdit && onSave ? (
        <div className="flex items-center gap-1.5">
          <label className="sr-only" htmlFor="bot-library-add">Add a required output</label>
          <input
            id="bot-library-add"
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }}
            placeholder="report.md"
            className={`${FIELD_CLASS} flex-1 font-mono`}
          />
          <button type="button" disabled={busy || !draft.trim()} onClick={add} className="min-h-9 rounded-md border border-[var(--border-1)] bg-[var(--card)] px-3 text-[11px] disabled:opacity-50">
            Add
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** Picks from documents the file route already returns for this viewer. */
function BotFilePicker({ existing, atCap, busy, onCancel, onPick }: {
  existing: readonly string[];
  atCap: boolean;
  busy: boolean;
  onCancel: () => void;
  onPick: (file: AuthorizedBotFile) => void;
}) {
  const [files, setFiles] = useState<AuthorizedBotFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const load = useCallback(() => {
    setFiles(null);
    setError(null);
    void listAttachableFiles().then((result) => {
      setFiles(result.files);
      setError(result.error);
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Files unavailable."));
  }, []);
  useEffect(load, [load]);
  const visible = (files ?? []).filter((file) => !existing.includes(file.id) && (!query.trim() || file.name.toLowerCase().includes(query.trim().toLowerCase())));
  return (
    <div className="flex flex-col gap-2 rounded-md border border-[var(--border-1)] bg-[var(--card)] p-2">
      <div className="flex items-center gap-1.5">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by name"
          aria-label="Filter attachable files"
          className={`${FIELD_CLASS} flex-1`}
        />
        <button type="button" onClick={onCancel} className={`${QUIET_BUTTON} min-h-9 px-2 text-[11px]`}>Cancel</button>
      </div>
      {atCap ? <p role="alert" className="text-[11px] text-[var(--destructive)]">A bot links at most {MAX_BOT_LIBRARY_FILES} files. Remove one first.</p> : null}
      {error && files === null ? <BotSectionState tone="error" retry={load}>{error}</BotSectionState> : null}
      {files === null && !error ? <p role="status" className="text-[11px] text-[var(--muted-foreground-2)]">Loading your files…</p> : null}
      {files !== null && visible.length === 0 ? (
        <BotSectionState>
          {files.length === 0 ? "No files in this workspace yet. Upload one in Files first." : "No file matches that filter."}
        </BotSectionState>
      ) : null}
      {files !== null && visible.length > 0 ? (
        <ul aria-label="Attachable files" className="max-h-56 overflow-y-auto">
          {visible.map((file) => (
            <li key={file.id}>
              <button
                type="button"
                disabled={busy || atCap}
                onClick={() => onPick(file)}
                className="flex min-h-9 w-full items-center gap-2 rounded px-1 text-left text-[11px] hover:bg-[var(--secondary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] disabled:opacity-50"
              >
                <span className="min-w-0 flex-1 truncate text-[var(--fg)]">{file.name}</span>
                <span className="shrink-0 text-[var(--muted-foreground-2)]">{file.scope === "workspace" ? "Workspace" : "Personal"} · {formatBytes(file.size)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
