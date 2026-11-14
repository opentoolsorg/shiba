import type { JSX } from "react";

const HANDOFF_STATUSES = ["pending approval", "working", "reported", "cancelled"] as const;
export type HandoffCardStatus = (typeof HANDOFF_STATUSES)[number];

export function handoffReason(body: string): string | null {
  const marker = " · because ";
  const index = body.indexOf(marker);
  if (index < 0) return null;
  const reason = body.slice(index + marker.length).trim();
  return reason || null;
}

export function parseHandoffBody(
  body: string,
  fromLabel?: string,
  toLabel?: string,
): { from: string; to: string; task: string } {
  const main = body.split(" · because ")[0]?.trim() || body.trim();
  const match = /^(.+?) → (.+?): ([\s\S]+)$/.exec(main);
  const from = match?.[1]?.trim();
  const to = match?.[2]?.trim();
  const task = match?.[3]?.trim();
  if (from && to && task) return { from, to, task };
  return {
    from: fromLabel?.trim() || "A",
    to: toLabel?.trim() || "B",
    task: main,
  };
}

export function resolveHandoffStatus(input: {
  handoffStatus?: "active" | "cancelled";
  reported: boolean;
  runStarted: boolean;
}): HandoffCardStatus {
  if (input.handoffStatus === "cancelled") return "cancelled";
  if (input.reported) return "reported";
  if (input.runStarted) return "working";
  return "pending approval";
}

/** "A → B: task" with a status. The control opens the child thread. */
export function HandoffCard({
  body,
  fromLabel,
  toLabel,
  status,
  onOpenThread,
}: {
  body: string;
  fromLabel?: string;
  toLabel?: string;
  status: HandoffCardStatus;
  onOpenThread?: () => void;
}): JSX.Element {
  const parsed = parseHandoffBody(body, fromLabel, toLabel);
  const label = `${parsed.from} → ${parsed.to}: ${parsed.task}`;
  return (
    <button
      type="button"
      onClick={onOpenThread}
      disabled={!onOpenThread}
      className="mt-2 flex min-h-11 w-full items-center justify-between gap-3 border border-[var(--line)] px-3 py-2 text-left text-sm"
    >
      <span>{label}</span>
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-2)]">{status}</span>
    </button>
  );
}

/** Compact pointer from a parent thread back to the child result. */
export function HandoffReport({
  body,
  onOpenThread,
}: {
  body: string;
  onOpenThread?: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpenThread}
      disabled={!onOpenThread}
      className="mt-2 min-h-11 text-left text-sm underline"
    >
      Reported result: {body}
    </button>
  );
}
