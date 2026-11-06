import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

interface TerminalSnapshot { text: string; totalChars?: number; epoch: number }

function validOffset(snapshot: TerminalSnapshot): snapshot is TerminalSnapshot & { totalChars: number } {
  return Number.isSafeInteger(snapshot.totalChars) && Number(snapshot.totalChars) >= snapshot.text.length &&
    Number.isSafeInteger(snapshot.epoch) && snapshot.epoch >= 0;
}

/** A retained window may slide while its source's cumulative offset continues growing. */
function appendDelta(previous: TerminalSnapshot, next: TerminalSnapshot): string | null {
  if (previous.epoch !== next.epoch) return null;
  if (previous.totalChars === undefined && next.totalChars === undefined) {
    return next.text.startsWith(previous.text) ? next.text.slice(previous.text.length) : null;
  }
  if (!validOffset(previous) || !validOffset(next)) return null;
  const added = next.totalChars - previous.totalChars;
  if (added === 0) return next.text === previous.text ? "" : null;
  if (added < 0 || added > next.text.length) return null;
  const overlap = next.text.length - added;
  if (overlap > previous.text.length || !previous.text.endsWith(next.text.slice(0, overlap))) return null;
  return next.text.slice(next.text.length - added);
}

export function TerminalView({ text, totalChars, epoch = 0 }: { text: string; totalChars?: number; epoch?: number }) {
  const elementRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const snapshotRef = useRef<TerminalSnapshot>({ text, totalChars, epoch });
  const writtenRef = useRef<TerminalSnapshot>({ text: "", epoch: 0 });
  const [ready, setReady] = useState(false);
  snapshotRef.current = { text, totalChars, epoch };

  useEffect(() => {
    let stopped = false;
    let observer: ResizeObserver | undefined;
    void import("@xterm/xterm").then(({ Terminal }) => {
      const element = elementRef.current;
      if (stopped || !element) return;
      const theme = getComputedStyle(element);
      const terminal = new Terminal({
        disableStdin: true,
        cursorBlink: false,
        convertEol: true,
        screenReaderMode: true,
        scrollback: 5_000,
        rows: 16,
        cols: 90,
        fontSize: 12,
        fontFamily: "Geist Mono, monospace",
        theme: {
          background: theme.getPropertyValue("--paper").trim(),
          foreground: theme.getPropertyValue("--ink").trim(),
        },
      });
      terminalRef.current = terminal;
      terminal.open(element);
      const snapshot = snapshotRef.current;
      if (snapshot.text) terminal.write(snapshot.text);
      writtenRef.current = snapshot;
      setReady(true);
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(() => {
          if (element.clientWidth > 0) terminal.resize(Math.max(20, Math.floor(element.clientWidth / 7.3)), 16);
        });
        observer.observe(element);
      }
    }).catch(() => {
      // The accessible text view remains available when canvas setup fails.
      terminalRef.current?.dispose();
      terminalRef.current = null;
    });
    return () => {
      stopped = true;
      observer?.disconnect();
      terminalRef.current?.dispose();
      terminalRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const snapshot = { text, totalChars, epoch };
    const delta = appendDelta(writtenRef.current, snapshot);
    if (delta === null) {
      terminal.reset();
      if (snapshot.text) terminal.write(snapshot.text);
    } else if (delta) terminal.write(delta);
    writtenRef.current = snapshot;
  }, [text, totalChars, epoch]);

  return (
    <section aria-label="Live terminal output" className="min-w-0 border border-[var(--line)] bg-[var(--paper)] p-2">
      <div ref={elementRef} className="min-w-0 overflow-hidden" />
      <pre className={ready ? "sr-only" : "max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-[var(--ink)]"}>
        {text || "Waiting for terminal output."}
      </pre>
    </section>
  );
}
