import { useEffect, useState } from "react";
import type { StoredApproval } from "../types";
import { createCompletionDrivenPoll, documentVisibilityPause } from "../polling";

/**
 * Single owner for stored approval pointers (/api/approvals).
 * Tasks home, Approvals, threads, and Slack-mirrored cards share this hook.
 */
export function useApprovalsState(
  refreshToken: number,
  enabled: boolean,
  liveEventsConnected = false,
): {
  approvals: StoredApproval[];
  decided: StoredApproval[];
  error: string | null;
  reload: () => void;
} {
  const [approvals, setApprovals] = useState<StoredApproval[]>([]);
  const [decided, setDecided] = useState<StoredApproval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setApprovals([]);
      setDecided([]);
      setError(null);
      return;
    }
    let cancelled = false;
    let sent = 0;
    let applied = 0;
    const load = () => {
      const seq = ++sent;
      return fetch("/api/approvals")
        .then(async (response) => {
          if (!response.ok) throw new Error(`Approvals request failed: ${response.status}`);
          const body = (await response.json()) as { approvals?: StoredApproval[]; decided?: StoredApproval[] };
          if (!cancelled && seq > applied) {
            applied = seq;
            setApprovals(Array.isArray(body.approvals) ? body.approvals : []);
            setDecided(Array.isArray(body.decided) ? body.decided : []);
            setError(null);
          }
        })
        .catch((fetchError: unknown) => {
          if (!cancelled && seq > applied) {
            setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
          }
        });
    };
  const poll = createCompletionDrivenPoll({
      intervalMs: liveEventsConnected ? 120_000 : 30_000,
      load,
      pause: documentVisibilityPause(),
    });
    void load();
    return () => {
      cancelled = true;
      poll.stop();
    };
  }, [enabled, refreshToken, tick, liveEventsConnected]);

  return {
    approvals,
    decided,
    error,
    reload: () => setTick((value) => value + 1),
  };
}