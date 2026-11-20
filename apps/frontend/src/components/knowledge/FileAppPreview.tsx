import { AppWindow, LockKeyhole, X } from "lucide-react";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { LoadErrorState } from "../LoadErrorState";

const cell = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);
const snapshot = z
  .strictObject({
    specVersion: z.literal(1),
    title: z.string().min(1).max(60),
    description: z.string().max(280),
    columns: z.array(z.string().min(1).max(60)).min(1).max(8),
    rows: z.array(z.array(cell).max(8)).max(20),
  })
  .refine(({ columns, rows }) => rows.every((row) => row.length === columns.length));
const result = z.strictObject({ preview: snapshot });
const action =
  "inline-flex min-h-11 items-center gap-2 border border-[var(--line)] px-3 text-xs font-medium hover:bg-[var(--panel-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]";
const unavailable = "Couldn’t load this preview.";
const refusal: Readonly<Record<number, string>> = {
  401: "Sign in with Cloudflare Access to open this preview.",
  403: "This preview is unavailable to your account.",
  404: "This preview is unavailable to your account.",
  413: "This preview is larger than 64 KiB.",
  422: "This file is not a valid app preview.",
};

type PreviewState =
  | { kind: "loading" }
  | { kind: "ready"; preview: z.infer<typeof snapshot> }
  | { kind: "refused"; message: string }
  | { kind: "failed" };

function PreviewDialog({
  fileId,
  opener,
  onClose,
}: {
  fileId: string;
  opener: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [request, setRequest] = useState(() => ({ fileId }));
  const [state, setState] = useState<PreviewState>({ kind: "loading" });

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const trigger = opener.current;
    element.showModal();
    element.querySelector("button")?.focus();
    return () => {
      element.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, [opener]);

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
    async function read() {
      try {
        const response = await fetch(
          `/api/files/${encodeURIComponent(request.fileId)}/app-preview`,
          {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal,
          },
        );
        signal.throwIfAborted();
        if (!response.ok) {
          const message = refusal[response.status];
          setState(message ? { kind: "refused", message } : { kind: "failed" });
          return;
        }
        const parsed = result.safeParse(await response.json());
        signal.throwIfAborted();
        setState(
          parsed.success ? { kind: "ready", preview: parsed.data.preview } : { kind: "failed" },
        );
      } catch {
        if (!controller.signal.aborted) setState({ kind: "failed" });
      }
    }
    void read();
    return () => controller.abort();
  }, [request]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={heading}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-5xl overflow-hidden border border-[var(--line)] bg-[var(--card)] p-0 text-[var(--fg)] backdrop:bg-[var(--overlay)] open:flex open:flex-col"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-2">
        <h2 id={heading} className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <AppWindow size={16} aria-hidden="true" /> App preview
        </h2>
        <button type="button" className={action} onClick={onClose}>
          <X size={14} aria-hidden="true" /> Close
        </button>
      </header>
      <div className="min-h-0 min-w-0 space-y-4 overflow-y-auto p-4 text-sm sm:p-5">
        <p className="flex items-center gap-2 text-xs text-[var(--ink-2)]">
          <LockKeyhole size={14} aria-hidden="true" /> Private · Read-only. Nothing is saved.
        </p>
        {state.kind === "loading" && (
          <div role="status" className="space-y-3 border border-[var(--line)] p-3">
            <p>Loading preview…</p>
            <div aria-hidden="true" className="space-y-2">
              <div className="h-4 w-1/2 bg-[var(--panel-2)]" />
              <div className="h-8 w-full bg-[var(--panel-2)]" />
            </div>
          </div>
        )}
        {state.kind === "refused" && (
          <p role="alert" className="border border-[var(--line)] p-3">
            {state.message}
          </p>
        )}
        {state.kind === "failed" && (
          <LoadErrorState
            message={unavailable}
            onRetry={() => {
              setState({ kind: "loading" });
              setRequest({ fileId });
            }}
          />
        )}
        {state.kind === "ready" && (
          <section aria-label="Preview contents" className="min-w-0 space-y-3">
            <h3 className="text-balance text-xl font-semibold [overflow-wrap:anywhere]">
              {state.preview.title}
            </h3>
            {state.preview.description && (
              <p className="text-pretty text-[var(--ink-2)] [overflow-wrap:anywhere]">
                {state.preview.description}
              </p>
            )}
            {state.preview.rows.length === 0 ? (
              <p className="border border-[var(--line)] p-3 text-[var(--ink-2)]">
                This snapshot has no rows.
              </p>
            ) : (
              <>
                {state.preview.columns.length > 2 && (
                  <p className="text-xs text-[var(--ink-2)] sm:hidden">
                    Scroll the table to see more columns.
                  </p>
                )}
                <section
                  aria-label="Preview table"
                  tabIndex={0}
                  className="max-w-full overflow-x-auto border border-[var(--line)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
                >
                  <table
                    className="w-full table-fixed text-left text-sm tabular-nums"
                    style={{ minWidth: `${state.preview.columns.length * 7.5}rem` }}
                  >
                    <caption className="sr-only">{state.preview.title} data</caption>
                    <thead className="bg-[var(--panel-2)]">
                      <tr>
                        {Array.from(state.preview.columns.entries(), ([position, column]) => (
                          <th
                            key={position}
                            scope="col"
                            className="px-3 py-2 font-medium [overflow-wrap:anywhere]"
                          >
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from(state.preview.rows.entries(), ([position, row]) => (
                        <tr key={position} className="border-t border-[var(--line)]">
                          {Array.from(row.entries(), ([column, value]) => (
                            <td
                              key={column}
                              className="px-3 py-2 align-top [overflow-wrap:anywhere]"
                            >
                              {value === null
                                ? "—"
                                : typeof value === "boolean"
                                  ? value
                                    ? "Yes"
                                    : "No"
                                  : value}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              </>
            )}
          </section>
        )}
      </div>
    </dialog>
  );
}

export function FileAppPreview({ fileId, fileName }: { fileId: string; fileName: string }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={opener}
        type="button"
        className={action}
        aria-label={`Preview app: ${fileName}`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <AppWindow size={14} aria-hidden="true" /> Preview app
      </button>
      {open && (
        <PreviewDialog
          key={fileId}
          fileId={fileId}
          opener={opener}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
