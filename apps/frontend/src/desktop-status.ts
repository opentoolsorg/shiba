// T63 — subscription to the desktop bridge's status. In a plain browser there
// is no bridge; the hook stays null and every caller falls back to the
// pre-desktop behaviour.
import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopStatus, ShibaDesktopBridge } from "@shiba/shared";

// window.shibaDesktop is injected by the desktop preload only when the
// renderer origin equals the configured origin (DESKTOP-PLAN §3.5, D4). The
// canonical augmentation also lives in desktop.d.ts; duplicating it here keeps
// this module self-contained in programs that import it without the ambient
// file (e.g. the backend test tsconfig, which pulls frontend sources through
// imports). Identical optional members merge safely.
declare global {
  interface Window {
    shibaDesktop?: ShibaDesktopBridge;
  }
}

// Monotonic sequence guard: a token taken before a later next() is stale.
export function createLatest() {
  let seq = 0;
  return { next: () => ++seq, peek: () => seq, isLatest: (token: number) => token === seq };
}

// Connected or bridge-owned states hide the button: re-pairing would kill a live daemon.
const HIDE_CONNECT_STATES: readonly string[] = ["disabled", "signed-out", "idle", "busy", "starting"];

export function shouldShowConnect(bridgePresent: boolean, status: DesktopStatus | null): boolean {
  return bridgePresent && !HIDE_CONNECT_STATES.includes(status?.state ?? "");
}

// Local runs target this machine only when the desktop shell reports its id.
export function targetMachineFields(status: DesktopStatus | null): { targetMachineId?: string } {
  return status?.machineId ? { targetMachineId: status.machineId } : {};
}

export interface DesktopBridgeState {
  bridge: ShibaDesktopBridge | undefined;
  status: DesktopStatus | null;
  refresh(): void;
}

export function useDesktopStatus(): DesktopBridgeState {
  // The preload decides once per page load whether the bridge exists.
  const bridgeRef = useRef<ShibaDesktopBridge | undefined>(
    typeof window === "undefined" ? undefined : window.shibaDesktop,
  );
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  // Bumped on every push: a status() pull that started before a push is stale.
  const [pushes] = useState(createLatest);
  const mounted = useRef(true);

  const pull = useCallback(() => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    const seq = pushes.peek();
    bridge.status().then(
      (s) => { if (mounted.current && pushes.isLatest(seq)) setStatus(s); },
      () => {},
    );
  }, [pushes]);

  useEffect(() => {
    const bridge = bridgeRef.current;
    mounted.current = true;
    if (!bridge) return;
    pull();
    const unsubscribe = bridge.onStatus((s) => {
      pushes.next();
      setStatus(s);
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [pull, pushes]);

  return { bridge: bridgeRef.current, status, refresh: pull };
}
