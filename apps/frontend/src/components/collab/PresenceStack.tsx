import type { JSX } from "react";
import type { CollaborationRoomViewer } from "../../collaboration-room-realtime";

const MAX_AVATARS = 4;
const initial = (label: string) => (label.replace(/^(human|agent):/, "").trim()[0] ?? "?").toUpperCase();
const name = (label: string) => label.replace(/^(human|agent):/, "").split("@")[0] ?? label;

/** "Asha is typing…", "Asha and Ben are typing…", "3 people are typing…". */
export function typingSummary(viewers: CollaborationRoomViewer[], selfViewerId: string | null, working: string[] = []): string {
  const selfLabel = viewers.find((viewer) => viewer.viewerId === selfViewerId)?.label;
  const names = [...[...new Set(viewers.filter((viewer) => viewer.typing && viewer.viewerId !== selfViewerId && viewer.label !== selfLabel).map((viewer) => viewer.label))].map(name),
    ...working.map((label) => `${label} is working`)];
  const typers = names.filter((item) => !item.endsWith(" is working"));
  const workers = names.filter((item) => item.endsWith(" is working"));
  const parts: string[] = [];
  if (typers.length === 1) parts.push(`${typers[0]} is typing`);
  else if (typers.length === 2) parts.push(`${typers[0]} and ${typers[1]} are typing`);
  else if (typers.length > 2) parts.push(`${typers.length} people are typing`);
  parts.push(...workers);
  return parts.length ? `${parts.join(" · ")}…` : "";
}

/** Stacked avatars of who is in the room, with a status dot per person. */
export function PresenceStack({ viewers, selfViewerId }: { viewers: CollaborationRoomViewer[]; selfViewerId: string | null }): JSX.Element | null {
  if (viewers.length === 0) return null;
  const people = new Map<string, CollaborationRoomViewer>();
  for (const viewer of viewers) {
    const previous = people.get(viewer.label);
    people.set(viewer.label, previous ? {
      ...viewer,
      viewerId: previous.viewerId === selfViewerId ? previous.viewerId : viewer.viewerId,
      status: previous.status === "online" || viewer.status === "online" ? "online" : "away",
      typing: previous.typing || viewer.typing,
    } : viewer);
  }
  const shown = [...people.values()].slice(0, MAX_AVATARS);
  const extra = people.size - shown.length;
  return (
    <ul aria-label="Online room members" className="flex items-center -space-x-1.5">
      {shown.map((viewer) => (
        <li
          key={viewer.viewerId}
          title={`${name(viewer.label)}${viewer.viewerId === selfViewerId ? " (you)" : ""} · ${viewer.status}`}
          className="relative grid size-6 place-items-center rounded-full border border-[var(--paper)] bg-[var(--panel-2)] text-[10px] font-semibold text-[var(--ink-2)]"
        >
          <span aria-hidden="true">{initial(viewer.label)}</span>
          <span className="sr-only">{name(viewer.label)}, {viewer.status}{viewer.typing ? ", typing" : ""}</span>
          <span aria-hidden="true" className={`absolute -bottom-0.5 -right-0.5 size-2 rounded-full border border-[var(--paper)] ${viewer.status === "online" ? "bg-[var(--success)]" : "bg-[var(--ink-2)]"}`} />
        </li>
      ))}
      {extra > 0 ? <li className="grid size-6 place-items-center rounded-full border border-[var(--paper)] bg-[var(--panel-2)] text-[10px] text-[var(--ink-2)]">+{extra}</li> : null}
    </ul>
  );
}
