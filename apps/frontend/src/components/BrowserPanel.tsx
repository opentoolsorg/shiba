import { ChevronDown, ChevronRight, Monitor, Square } from "lucide-react";
import { type FormEvent, type JSX, useCallback, useEffect, useId, useRef, useState } from "react";
import { ToneChip } from "./ToneChip";

type BrowserState = "none" | "live" | "paused" | "closed";
type BrowserFrame = {
  state: BrowserState;
  url?: string;
  image?: string;
  width?: number;
  height?: number;
  controlling?: boolean;
};
type BrowserInput =
  | { kind: "click"; x: number; y: number }
  | { kind: "scroll"; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "text"; text: string }
  | { kind: "key"; key: string };
type BrowserAction =
  | { action: "takeover" | "handback" | "stop" }
  | { action: "input"; input: BrowserInput };

const STATUS = {
  none: { label: "No session", tone: "neutral" },
  live: { label: "Live", tone: "ok" },
  paused: { label: "Paused", tone: "pending" },
  closed: { label: "Closed", tone: "neutral" },
} as const;
const BUTTON = "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 text-xs font-medium text-[var(--ink)] [@media(hover:hover)]:hover:bg-[var(--panel-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)] disabled:opacity-50";
const FIELD = "min-h-11 min-w-0 border border-[var(--input-line)] bg-[var(--paper)] px-2 text-xs text-[var(--ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]";
const KEYS = ["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"] as const;
const POLL_MS = 1750;

async function requestFrame(endpoint: string, signal: AbortSignal, action?: BrowserAction): Promise<BrowserFrame> {
  const response = await fetch(endpoint, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    credentials: "same-origin",
    cache: "no-store",
    ...(action ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) } : {}),
  });
  if (!response.ok) throw new Error(String(response.status));
  const frame = await response.json() as BrowserFrame | null;
  if (!frame || !Object.hasOwn(STATUS, frame.state)) throw new Error("Invalid browser state");
  return frame;
}

function viewportPoint(image: HTMLImageElement | null, frame: BrowserFrame, clientX: number, clientY: number) {
  const bounds = image?.getBoundingClientRect();
  const { width, height } = frame;
  if (!bounds?.width || !bounds.height || !width || !height ||
    !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const scaleX = width / bounds.width;
  const scaleY = height / bounds.height;
  return {
    x: Math.min(width - 1, Math.max(0, Math.floor((clientX - bounds.left) * scaleX))),
    y: Math.min(height - 1, Math.max(0, Math.floor((clientY - bounds.top) * scaleY))),
    scaleX,
    scaleY,
  };
}

export function BrowserPanel({ sessionId }: { sessionId: string }): JSX.Element {
  return <SessionBrowserPanel key={sessionId} sessionId={sessionId} />;
}

function SessionBrowserPanel({ sessionId }: { sessionId: string }): JSX.Element {
  const titleId = useId();
  const previewId = useId();
  const endpoint = sessionId === "default" ? "/api/sessions/browser" : `/api/sessions/browser?session=${encodeURIComponent(sessionId)}`;
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [offline, setOffline] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const lifecycle = useRef<AbortController | null>(null);
  const poll = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const viewport = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const current = new AbortController();
    lifecycle.current = current;
    const refresh = async () => {
      if (pending.current || poll.current) return;
      const request = new AbortController();
      poll.current = request;
      try {
        const next = await requestFrame(endpoint, AbortSignal.any([current.signal, request.signal]));
        if (!request.signal.aborted && !current.signal.aborted) {
          setFrame(next);
          setOffline(false);
        }
      } catch {
        if (!request.signal.aborted && !current.signal.aborted) {
          setFrame(null);
          setOffline(true);
        }
      } finally {
        if (poll.current === request) poll.current = null;
      }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, POLL_MS);
    return () => {
      current.abort();
      poll.current = null;
      window.clearInterval(timer);
    };
  }, [endpoint]);

  const send = useCallback(async (action: BrowserAction) => {
    const current = lifecycle.current;
    if (!current || current.signal.aborted || pending.current) return;
    pending.current = true;
    poll.current?.abort();
    setBusy(true);
    setActionError(false);
    try {
      const next = await requestFrame(endpoint, current.signal, action);
      if (!current.signal.aborted) {
        if (action.action === "takeover") setExpanded(true);
        setFrame((previous) => previous && (next.state === "live" || next.state === "paused") &&
          (!next.url || next.url === previous.url)
          ? { url: previous.url, image: previous.image, width: previous.width, height: previous.height, ...next }
          : next);
      }
    } catch {
      if (!current.signal.aborted) setActionError(true);
    } finally {
      pending.current = false;
      if (!current.signal.aborted) setBusy(false);
    }
  }, [endpoint]);

  const controlling = frame?.state === "paused" && frame.controlling === true;
  const hasImage = Boolean(frame?.image && frame.width && frame.height);
  useEffect(() => {
    const image = viewport.current;
    if (!expanded || !controlling || !image || !frame) return;
    const wheel = (event: WheelEvent) => {
      const point = viewportPoint(image, frame, event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? image.clientHeight : 1;
      const deltaX = Math.min(2000, Math.max(-2000, Math.round(event.deltaX * multiplier * point.scaleX)));
      const deltaY = Math.min(2000, Math.max(-2000, Math.round(event.deltaY * multiplier * point.scaleY)));
      if (deltaX || deltaY) void send({ action: "input", input: { kind: "scroll", x: point.x, y: point.y, deltaX, deltaY } });
    };
    image.addEventListener("wheel", wheel, { passive: false });
    return () => image.removeEventListener("wheel", wheel);
  }, [expanded, controlling, frame, send]);

  const sendText = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current || !controlling) return;
    const field = event.currentTarget.elements.namedItem("browser-text") as HTMLInputElement;
    const text = field.value;
    field.value = "";
    if (text) void send({ action: "input", input: { kind: "text", text } });
  };
  const active = frame?.state === "live" || frame?.state === "paused";
  const image = hasImage && frame ? (
    <img
      ref={viewport}
      alt="Browser viewport"
      src={`data:image/png;base64,${frame.image}`}
      width={frame.width}
      height={frame.height}
      draggable={false}
      className="block max-h-[22dvh] w-auto max-w-full select-none object-contain sm:max-h-[26dvh]"
    />
  ) : null;

  return (
    <section aria-labelledby={titleId} data-browser-expanded={active && expanded ? "" : undefined}
      className="mx-3 mt-3 max-h-[35dvh] min-w-0 shrink-0 overflow-y-auto overscroll-contain border border-[var(--line)] bg-[var(--card)] sm:mx-5 sm:max-h-[44dvh] xl:mx-8">
      <div className="sticky top-0 z-[1] flex flex-wrap items-center justify-between gap-x-4 gap-y-2 bg-[var(--card)] px-3 py-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <h2 id={titleId} className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--ink)]">
            <Monitor className="size-4 shrink-0" aria-hidden="true" /> Browser
          </h2>
          <div role="status">
            {frame ? <ToneChip {...STATUS[frame.state]} /> : <ToneChip tone="neutral" label={offline ? "Unavailable" : "Checking…"} />}
          </div>
          {frame?.state === "none" ? <p className="text-xs text-[var(--ink-2)]">Turn on Browser in Chat and ask Shiba to open a site.</p> : null}
          {frame?.state === "closed" ? <p className="text-xs text-[var(--ink-2)]">Ask Shiba to open a site to start a new session.</p> : null}
        </div>
        {active ? <div className="flex flex-wrap gap-2">
          {controlling ? (
            <button type="button" className={BUTTON} disabled={busy} onClick={() => { void send({ action: "handback" }); }}>Hand back</button>
          ) : frame.state === "live" ? (
            <button type="button" className={BUTTON} disabled={busy} onClick={() => { void send({ action: "takeover" }); }}>Take over</button>
          ) : null}
          <button type="button" className={`${BUTTON} inline-flex items-center gap-1.5`} aria-label="Stop browser" disabled={busy} onClick={() => { void send({ action: "stop" }); }}>
            <Square className="size-3" aria-hidden="true" /> Stop
          </button>
          <button type="button" className={`${BUTTON} grid min-w-11 place-items-center p-0`} aria-label={expanded ? "Hide browser preview" : "Show browser preview"}
            title={expanded ? "Hide browser preview" : "Show browser preview"} aria-expanded={expanded} aria-controls={previewId} onClick={() => setExpanded((shown) => !shown)}>
            {expanded ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
          </button>
        </div> : null}
      </div>
      {offline ? <p role="alert" className="px-3 pb-3 text-xs text-[var(--ink-2)]">The browser couldn’t be reached. This panel will retry automatically.</p> : null}
      {actionError ? <p role="alert" className="px-3 pb-3 text-xs text-[var(--destructive-fg)]">The browser didn’t accept that action. Check its current state and try again.</p> : null}
      {active ? (
        <div>
          <div className="flex min-w-0 flex-wrap justify-between gap-2 border-t border-[var(--line)] px-3 py-2 text-xs">
            <div className="min-w-0 break-all text-[var(--ink-2)]"><span className="sr-only">Current URL: </span>{frame.url ?? "Waiting for browser address…"}</div>
            {frame.state === "paused" ? <p className="text-[var(--ink)]">{controlling ? "You’re in control. Shiba is paused." : "Shiba is paused while a person controls the browser."}</p> : null}
          </div>
          <div id={previewId} hidden={!expanded}>
          {expanded && image ? (
            <div className="grid justify-items-center border-t border-[var(--line)] bg-[var(--panel-2)]">
              {controlling ? <button type="button" aria-label="Click the browser viewport; keyboard activation clicks the center" className="min-w-0 max-w-full cursor-crosshair focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--ring)]"
                onClick={(event) => {
                  const bounds = viewport.current?.getBoundingClientRect();
                  const point = event.detail ? viewportPoint(viewport.current, frame, event.clientX, event.clientY)
                    : bounds && viewportPoint(viewport.current, frame, bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
                  if (point) void send({ action: "input", input: { kind: "click", x: point.x, y: point.y } });
                }}>{image}</button> : image}
            </div>
          ) : expanded ? <p className="border-t border-[var(--line)] px-3 py-4 text-xs text-[var(--ink-2)]">Waiting for a browser frame…</p> : null}
          {expanded && controlling ? (
            <div className="flex flex-wrap items-end gap-3 border-t border-[var(--line)] p-3">
              <form className="flex min-w-0 flex-1 basis-64 items-end gap-2" onSubmit={sendText} autoComplete="off">
                <label className="grid min-w-0 flex-1 gap-1 text-xs text-[var(--ink-2)]">Text to send
                  <input name="browser-text" type="password" className={FIELD} autoComplete="new-password" spellCheck={false} maxLength={2000} required />
                </label>
                <button type="submit" className={BUTTON} disabled={busy}>Send text</button>
              </form>
              <form className="flex items-end gap-2" onSubmit={(event) => {
                event.preventDefault();
                const key = new FormData(event.currentTarget).get("key");
                if (typeof key === "string") void send({ action: "input", input: { kind: "key", key } });
              }}>
                <label className="grid gap-1 text-xs text-[var(--ink-2)]">Key to press
                  <select name="key" className={FIELD}>{KEYS.map((key) => <option key={key}>{key}</option>)}</select>
                </label>
                <button type="submit" className={BUTTON} disabled={busy}>Send key</button>
              </form>
            </div>
          ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
