import { Monitor } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import type { RunStatus } from "@shiba/shared";

type Control = "agent" | "you" | "other";
type Input =
  | { type: "click"; x: number; y: number; button: "left" | "middle" | "right" }
  | { type: "key"; keys: string }
  | { type: "scroll"; dx: number; dy: number }
  | { type: "type"; text: string };
type Command = { action: Input | { type: "shot" } } | { control: "take" | "release" };

const POLL_MS = 2_000;
const BUTTON = "min-h-11 border border-[var(--border-1)] bg-[var(--secondary)] px-3 text-xs font-medium text-[var(--fg)] hover:bg-[var(--secondary-hover)] disabled:opacity-50";
const CLOSED = "This cloud computer is closed.";
const CONTROL_LABEL: Record<Control, string> = {
  agent: "Agent has control",
  you: "You have control",
  other: "Someone else has control",
};
const DESKTOP_KEYS: Record<string, string> = {
  Enter: "Return", Escape: "Escape", Backspace: "BackSpace", Delete: "Delete",
  Insert: "Insert", Home: "Home", End: "End", PageUp: "Page_Up", PageDown: "Page_Down",
  ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", " ": "space",
  "+": "plus", "-": "minus",
};

function desktopKey(event: KeyboardEvent): Input | undefined {
  if (event.key === "Tab" || event.nativeEvent.isComposing) return undefined;
  const name = DESKTOP_KEYS[event.key]
    ?? (/^[a-z0-9]$/i.test(event.key) ? event.key.toLowerCase() : undefined)
    ?? (/^F(?:[1-9]|1[0-2])$/.test(event.key) ? event.key : undefined);
  if (!name) {
    return event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey
      ? { type: "type", text: event.key }
      : undefined;
  }
  return {
    type: "key",
    keys: [
      event.ctrlKey && "ctrl",
      event.altKey && "alt",
      event.shiftKey && name !== "plus" && "shift",
      event.metaKey && "super",
      name,
    ].filter(Boolean).join("+"),
  };
}

export function RunComputerPanel({ runId, sessionId, status }: { runId: string; sessionId?: string; status: RunStatus }) {
  const titleId = useId();
  const query = sessionId !== undefined ? `?${new URLSearchParams({ session: sessionId })}` : "";
  const url = `/api/runs/${encodeURIComponent(runId)}/screen${query}`;
  return (
    <section aria-labelledby={titleId} className="min-w-0 border border-[var(--border-1)] bg-[var(--card)]">
      <h3 id={titleId} className="flex items-center gap-2 border-b border-[var(--border-1)] px-3 py-2.5 text-sm font-semibold text-[var(--fg)]">
        <Monitor size={16} aria-hidden="true" />
        Computer
      </h3>
      {status === "running"
        ? <LiveComputer key={url} url={url} />
        : <p className="p-3 text-xs text-[var(--muted-foreground-2)]">{status === "pending" ? "The screen opens when the approved run starts." : CLOSED}</p>}
    </section>
  );
}

function LiveComputer({ url }: { url: string }) {
  const [frame, setFrame] = useState<string | null>(null);
  const [control, setControl] = useState<Control | null>(null);
  const [message, setMessage] = useState("");
  const [changingControl, setChangingControl] = useState(false);
  const [text, setText] = useState("");
  const [sendingText, setSendingText] = useState(false);
  const screen = useRef<HTMLImageElement>(null);
  const viewport = useRef<HTMLButtonElement>(null);
  const textField = useRef<HTMLInputElement>(null);
  const connection = useRef<{
    abort: AbortController;
    tail: Promise<unknown>;
    control: Control | null;
    changingControl: boolean;
    visibility: number;
    closed: boolean;
    queuedInputs: number;
  } | null>(null);
  const canInput = frame !== null && control === "you" && !changingControl;

  const post = useCallback((command: Command) => {
    const scope = connection.current;
    if (!scope || scope.closed || document.hidden) return Promise.resolve(false);
    const isShot = "action" in command && command.action.type === "shot";
    const isInput = "action" in command && !isShot;
    if (isInput && (scope.control !== "you" || scope.changingControl || scope.queuedInputs >= 16)) return Promise.resolve(false);
    if (isInput) scope.queuedInputs++;
    const visibility = scope.visibility;
    const current = () => !scope.abort.signal.aborted && scope.visibility === visibility && !document.hidden;
    const request = scope.tail.then(async () => {
      if (!current() || scope.closed || (isInput && (scope.control !== "you" || scope.changingControl))) return false;
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(command),
          signal: AbortSignal.any([scope.abort.signal, AbortSignal.timeout(18_000)]),
        });
        const body = await response.json().catch(() => null) as {
          ok?: boolean;
          control?: Control;
          screenshotBase64?: string;
          code?: string;
        } | null;
        if (!current()) return false;
        const nextControl = body?.control === "agent" || body?.control === "you" || body?.control === "other" ? body.control : null;
        if (!response.ok || body?.ok !== true || !nextControl) {
          if ([404, 410].includes(response.status) || (response.status === 409 && !nextControl) || body?.code === "run_not_running") {
            scope.closed = true;
            setMessage(CLOSED);
          } else if ([401, 403].includes(response.status)) {
            scope.closed = true;
            setMessage("You don’t have access to this screen.");
          } else if (response.status === 409 && nextControl) {
            scope.control = nextControl;
            setControl(nextControl);
            setMessage(nextControl === "other" ? CONTROL_LABEL.other : "Control changed. Take control to send input.");
            return false;
          } else {
            throw new Error();
          }
          scope.control = null;
          setControl(null);
          setFrame(null);
          return false;
        }
        if (isShot) {
          if (!body.screenshotBase64) throw new Error();
          setFrame(`data:image/png;base64,${body.screenshotBase64}`);
        }
        scope.control = nextControl;
        setControl(nextControl);
        setMessage("");
        return true;
      } catch {
        if (current()) {
          scope.control = null;
          setControl(null);
          setFrame(null);
          setMessage(isShot ? "Couldn’t refresh the screen. Retrying…" : "The computer didn’t confirm that action. Refreshing the screen…");
        }
        return false;
      }
    }).finally(() => { if (isInput) scope.queuedInputs--; });
    scope.tail = request;
    return request;
  }, [url]);

  useEffect(() => {
    const abort = new AbortController();
    const scope = { abort, tail: Promise.resolve() as Promise<unknown>, control: null, changingControl: false, closed: false, visibility: 0, queuedInputs: 0 };
    connection.current = scope;
    let timer: number | undefined;
    let polling = false;
    const poll = async () => {
      if (polling || scope.closed || abort.signal.aborted || document.hidden) return;
      polling = true;
      await post({ action: { type: "shot" } });
      polling = false;
      if (!scope.closed && !abort.signal.aborted && !document.hidden) {
        timer = window.setTimeout(() => { void poll(); }, POLL_MS);
      }
    };
    const refreshVisibility = () => {
      if (scope.closed) return;
      window.clearTimeout(timer);
      scope.visibility++;
      scope.control = null;
      setControl(null);
      setFrame(null);
      setMessage("");
      if (!document.hidden) void poll();
    };
    void poll();
    document.addEventListener("visibilitychange", refreshVisibility);
    return () => {
      abort.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshVisibility);
      connection.current = null;
    };
  }, [post]);

  useEffect(() => {
    const target = viewport.current;
    if (!canInput || !target) return;
    const scroll = (event: WheelEvent) => {
      if (document.activeElement !== target) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? target.clientHeight : 1;
      const dx = Math.round(event.deltaX * unit);
      const dy = Math.round(event.deltaY * unit);
      if (dx !== 0 || dy !== 0) void post({ action: { type: "scroll", dx, dy } });
    };
    target.addEventListener("wheel", scroll, { passive: false });
    return () => target.removeEventListener("wheel", scroll);
  }, [canInput, post]);

  const changeControl = async (change: "take" | "release") => {
    const scope = connection.current;
    if (!scope || scope.changingControl) return;
    scope.changingControl = true;
    setChangingControl(true);
    await post({ control: change });
    scope.changingControl = false;
    if (scope.abort.signal.aborted) return;
    setChangingControl(false);
    if (change === "release" && scope.control !== "you") setText("");
  };

  const clickScreen = (event: MouseEvent<HTMLButtonElement>, button: "left" | "middle" | "right") => {
    const img = screen.current;
    if (!canInput || !img?.naturalWidth || !img.naturalHeight) return;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = Math.floor((event.clientX - rect.left) * img.naturalWidth / rect.width);
    const y = Math.floor((event.clientY - rect.top) * img.naturalHeight / rect.height);
    if (x < 0 || y < 0 || x >= img.naturalWidth || y >= img.naturalHeight) return;
    event.preventDefault();
    event.currentTarget.focus();
    void post({ action: { type: "click", x, y, button } });
  };

  return (
    <div className="flex min-w-0 flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p role="status" className="text-xs text-[var(--muted-foreground-2)]">
          {message || (control ? CONTROL_LABEL[control] : "Waiting for the live screen…")}
        </p>
        {frame && control ? (
          <button
            className={BUTTON}
            type="button"
            disabled={control === "other" || changingControl}
            onClick={() => { void changeControl(control === "you" ? "release" : "take"); }}
          >
            {control === "you" ? "Release control" : "Take control"}
          </button>
        ) : null}
      </div>
      {frame ? (
        <button
          className={`block w-full border border-[var(--border-1)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)] ${canInput ? "cursor-crosshair" : "cursor-default"}`}
          type="button"
          ref={viewport}
          disabled={!canInput}
          aria-label="Cloud computer screen"
          onClick={(event) => { if (event.detail !== 0) clickScreen(event, "left"); }}
          onAuxClick={(event) => { if (event.button === 1) clickScreen(event, "middle"); }}
          onContextMenu={(event) => clickScreen(event, "right")}
          onKeyDown={(event) => {
            if (!canInput) return;
            const action = desktopKey(event);
            if (!action) return;
            event.preventDefault();
            event.stopPropagation();
            void post({ action });
          }}
        >
          <img ref={screen} src={frame} alt="Live view of the run desktop" width={1280} height={800} className="block h-auto w-full" draggable={false} />
        </button>
      ) : null}
      {frame ? (
        <p className="text-xs text-[var(--muted-foreground-2)]">
          {canInput ? "Focus the screen to send clicks, keys, or scroll. Release control when finished. Don’t enter credentials." : "This desktop belongs to this run and closes when it ends."}
        </p>
      ) : null}
      {canInput ? (
        <form className="flex min-w-0 flex-wrap items-center gap-2" onSubmit={async (event) => {
          event.preventDefault();
          if (sendingText || !text) return;
          setSendingText(true);
          if (await post({ action: { type: "type", text } })) setText((current) => current === text ? "" : current);
          setSendingText(false);
          textField.current?.focus();
        }}>
          <input ref={textField} aria-label="Text to send to the cloud computer" autoComplete="off" maxLength={4000} className="min-h-11 min-w-36 flex-1 border border-[var(--input-line)] bg-[var(--paper)] px-3 text-xs" placeholder="Send text to the desktop" value={text} onChange={(event) => setText(event.target.value)} />
          <button className={BUTTON} type="submit" disabled={sendingText || !text}>Send text</button>
          <button className={BUTTON} type="button" onClick={() => { void post({ action: { type: "key", keys: "Tab" } }); }}>Send Tab</button>
        </form>
      ) : null}
    </div>
  );
}
