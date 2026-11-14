import type { JSX } from "react";

export interface RouterCandidate {
  actorId: string;
  name: string;
}

/** Reason for a primary-bot handoff, plus a picker that creates another handoff. */
export function RouterChip({
  reason,
  candidates,
  runActive = false,
  onReassign,
}: {
  reason: string;
  candidates: RouterCandidate[];
  runActive?: boolean;
  onReassign: (actorId: string) => void;
}): JSX.Element {
  return (
    <div aria-label="Router decision" className="mt-2 border border-[var(--line)] px-3 py-2 text-sm">
      <p>because {reason}</p>
      {runActive ? (
        <p className="mt-1 text-xs text-[var(--ink-2)]">
          This bot is working. Reassign creates a new handoff that still waits for approval.
        </p>
      ) : null}
      <label className="mt-2 flex flex-col gap-1 text-xs text-[var(--ink-2)]">
        Reassign
        <select
          aria-label="Reassign"
          defaultValue=""
          onChange={(event) => {
            const actorId = event.target.value;
            if (actorId) onReassign(actorId);
          }}
          className="min-h-11 border border-[var(--line)] bg-[var(--card)] px-2 text-sm text-[var(--ink)]"
        >
          <option value="">Choose a bot</option>
          {candidates.map((candidate) => (
            <option key={candidate.actorId} value={candidate.actorId}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
