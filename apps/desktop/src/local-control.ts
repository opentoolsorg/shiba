export type LocalControlTarget =
  | { kind: "browser"; origin: string }
  | { kind: "native-window"; windowId: string; processId: number };

export type LocalControlStopReason =
  | "not-started"
  | "user-stopped"
  | "target-changed"
  | "window-closed"
  | "unsupported";

export type LocalControlSnapshot =
  | { phase: "stopped"; revision: number; reason: LocalControlStopReason }
  | {
      phase: "approved";
      revision: number;
      target: LocalControlTarget;
      mode: "control" | "takeover";
    };

function sameTarget(a: LocalControlTarget, b: LocalControlTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "browser" && b.kind === "browser") return a.origin === b.origin;
  return a.kind === "native-window" && b.kind === "native-window" &&
    a.windowId === b.windowId && a.processId === b.processId;
}

export function createLocalControlBoundary() {
  let snapshot: LocalControlSnapshot = { phase: "stopped", revision: 0, reason: "not-started" };
  const listeners = new Set<(state: LocalControlSnapshot) => void>();

  const publish = (next: LocalControlSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
    return snapshot;
  };

  return {
    getState: () => snapshot,
    subscribe(listener: (state: LocalControlSnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    approve(target: LocalControlTarget) {
      return publish({ phase: "approved", revision: snapshot.revision + 1, target, mode: "control" });
    },
    targetChanged(target: LocalControlTarget) {
      if (snapshot.phase !== "approved" || sameTarget(snapshot.target, target)) return snapshot;
      return publish({ phase: "stopped", revision: snapshot.revision + 1, reason: "target-changed" });
    },
    takeOver() {
      if (snapshot.phase !== "approved" || snapshot.mode === "takeover") return snapshot;
      return publish({ ...snapshot, revision: snapshot.revision + 1, mode: "takeover" });
    },
    handBack() {
      if (snapshot.phase !== "approved" || snapshot.mode === "control") return snapshot;
      return publish({ ...snapshot, revision: snapshot.revision + 1, mode: "control" });
    },
    stop(reason: Exclude<LocalControlStopReason, "not-started"> = "user-stopped") {
      if (snapshot.phase === "stopped" && snapshot.reason === reason) return snapshot;
      return publish({ phase: "stopped", revision: snapshot.revision + 1, reason });
    },
    canControl(target: LocalControlTarget) {
      return snapshot.phase === "approved" && snapshot.mode === "control" && sameTarget(snapshot.target, target);
    },
  };
}
