import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

export function TerminalView({ text }: { text: string }) {
  const elementRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const textRef = useRef(text);
  const writtenRef = useRef("");
  const [ready, setReady] = useState(false);
  textRef.current = text;

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
      terminal.write(textRef.current);
      writtenRef.current = textRef.current;
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
    if (text.startsWith(writtenRef.current)) terminal.write(text.slice(writtenRef.current.length));
    else {
      terminal.reset();
      terminal.write(text);
    }
    writtenRef.current = text;
  }, [text]);

  return (
    <section aria-label="Live terminal output" className="min-w-0 border border-[var(--line)] bg-[var(--paper)] p-2">
      <div ref={elementRef} className="min-w-0 overflow-hidden" />
      <pre className={ready ? "sr-only" : "max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-[var(--ink)]"}>
        {text || "Waiting for terminal output."}
      </pre>
    </section>
  );
}
