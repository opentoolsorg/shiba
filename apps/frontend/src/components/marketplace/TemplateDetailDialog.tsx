import { useEffect, useId, useRef, type JSX } from "react";
import type { AgentTemplate } from "@shiba/shared";
import { ArrowUpRight } from "lucide-react";

const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]";
const primaryBtn = `inline-flex min-h-11 flex-1 items-center justify-center gap-1 rounded-lg border border-[var(--primary)] bg-[var(--primary)] px-3 text-xs font-semibold text-[var(--primary-text)] disabled:opacity-50 ${focusRing}`;
const secondaryBtn = `inline-flex min-h-11 items-center justify-center rounded-lg border border-[var(--border-1)] px-3 text-xs font-medium hover:bg-[var(--card-hover)] ${focusRing}`;
const heading = "mt-4 text-xs font-semibold";

/** Read-only detail for one template. Hire and Copy pack are the catalog's own actions. */
export function TemplateDetailDialog({ template, busy, message, onHire, onCopy, onClose }: {
  template: AgentTemplate; busy: boolean; message: string; onHire: () => void; onCopy: () => void; onClose: () => void;
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const titleId = useId();
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); close.current(); return; }
      if (event.key !== "Tab" || !root.current) return;
      const items = Array.from(root.current.querySelectorAll<HTMLElement>("button:not([disabled])"));
      const first = items[0], last = items[items.length - 1];
      if (!first || !last) return;
      if (!root.current.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("keydown", key, true); if (opener?.isConnected && opener !== document.body) opener.focus(); };
  }, []);
  const capabilities = [
    `Provider: ${template.harness ?? "opencode"}`,
    ...template.chat_lanes.map((lane) => `${lane.charAt(0).toUpperCase()}${lane.slice(1)} threads`),
    ...(template.expectedDeliverables?.length ? [`Expected outputs: ${template.expectedDeliverables.join(", ")}`] : []),
    "Approval-gated",
  ];
  const recommended = [...template.skills, ...template.plugins].map((name) => name.replaceAll("-", " "));
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
    <div ref={root} role="dialog" aria-modal="true" aria-labelledby={titleId} className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--panel)] text-[var(--fg)] shadow-[var(--sh-card)]">
      <div className="flex items-start justify-between gap-3 border-b border-[var(--border-1)] px-4 py-3">
        <div className="min-w-0"><h3 id={titleId} className="text-base font-semibold">{template.name}</h3><p className="mt-1 text-sm text-[var(--muted-foreground-2)]">{template.description}</p></div>
        <button type="button" onClick={onClose} className={`${secondaryBtn} shrink-0`}>Close</button>
      </div>
      <div className="overflow-y-auto px-4 pb-4 text-xs">
        <h4 className={heading}>Instructions</h4>
        <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--border-1)] p-2">{template.instructions}</pre>
        <h4 className={heading}>Requested capabilities</h4>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">{capabilities.map((item) => <li key={item}>{item}</li>)}</ul>
        <h4 className={heading}>Skills and plugins <span className="ml-1 rounded-md border border-[var(--border-1)] px-1.5 py-0.5 text-[11px] font-normal text-[var(--muted-foreground-2)]">Recommended, not installed</span></h4>
        {recommended.length ? <ul className="mt-1 list-disc space-y-0.5 pl-5 capitalize">{recommended.map((name) => <li key={name}>{name}</li>)}</ul> : <p className="mt-1 text-[var(--muted-foreground-2)]">None recommended for this template.</p>}
        <p className="mt-4 rounded-lg border border-[var(--border-1)] p-2 text-[var(--muted-foreground-2)]">Not included: credentials, network access, or external permissions</p>
      </div>
      <div className="border-t border-[var(--border-1)] px-4 py-3">
        {message ? <p role="status" className="mb-2 text-xs text-[var(--muted-foreground-2)]">{message}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy} onClick={onHire} className={primaryBtn}>Hire <ArrowUpRight size={14} aria-hidden="true" /></button>
          <button type="button" onClick={onCopy} className={secondaryBtn}>Copy pack</button>
        </div>
      </div>
    </div>
  </div>;
}
