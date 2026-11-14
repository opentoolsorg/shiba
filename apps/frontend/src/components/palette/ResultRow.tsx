import type { JSX } from "react";
import { AgentAvatar } from "../AgentAvatar";
import type { PaletteChatHit, PaletteTaskHit } from "./usePaletteSearch";

function relative(at: number): string {
  const minutes = Math.floor(Math.max(0, Date.now() - at) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function taskStatusLabel(status: string | null | undefined): string | null {
  if (!status) return null;
  if (status === "done" || status === "cancelled") return "Done";
  if (status === "in-progress") return "Working";
  if (status === "needs_you" || status === "blocked") return "Needs you";
  return "Waiting";
}

export function MarkedSnippet({ text, query }: { text: string; query: string }): JSX.Element {
  const terms = query.trim().split(/\s+/).filter((term) => term.length >= 2).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${terms.join("|")})`, "ig"));
  const match = new RegExp(`^(?:${terms.join("|")})$`, "i");
  const nodes: JSX.Element[] = [];
  let at = 0;
  for (const part of parts) {
    const key = `${at}:${part}`;
    at += part.length + 1;
    nodes.push(match.test(part) ? <mark key={key}>{part}</mark> : <span key={key}>{part}</span>);
  }
  return <>{nodes}</>;
}

export function ChatResult({ hit, query }: { hit: PaletteChatHit; query: string }): JSX.Element {
  return (
    <span className="flex min-h-11 w-full items-center gap-3">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-[var(--fg)]">#{hit.title}</span>
        <span className="block truncate text-xs text-[var(--muted-foreground-2)]"><MarkedSnippet text={hit.snippet} query={query} /></span>
      </span>
      <span className="text-[10px] text-[var(--muted-foreground-2)]">{relative(hit.updatedAt)}</span>
    </span>
  );
}

export function TaskResult({ hit }: { hit: PaletteTaskHit }): JSX.Element {
  const status = taskStatusLabel(hit.status);
  return (
    <span className="flex min-h-11 w-full items-center gap-3">
      <span className="min-w-0 flex-1 truncate text-sm text-[var(--fg)]">{hit.title}</span>
      {status ? <span className="rounded-full border border-[var(--border-1)] px-2 py-0.5 text-[10px]">{status}</span> : null}
      {hit.ownerId ? <AgentAvatar id={hit.ownerId} name={hit.ownerId} size={28} decorative /> : null}
    </span>
  );
}
