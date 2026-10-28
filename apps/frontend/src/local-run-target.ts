import { useCallback, useEffect, useRef, useState } from "react";
import { LOCAL_HEARTBEAT_STALE_MS, type ConnectedComputer, type DesktopStatus } from "@shiba/shared";

const POLL_MS = 10_000;
const LOCAL_DAEMON_HARNESSES: Readonly<Record<string, string>> = {
  opencode: "opencode",
  "claude-code": "claude",
  codex: "codex",
};

function readComputers(raw: unknown): ConnectedComputer[] {
  if (!Array.isArray(raw)) throw new Error("The server did not return a paired computer list.");
  const computers: ConnectedComputer[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const computer = item as Record<string, unknown>;
    // Revoked computers are omitted by today's server; also fail closed if a
    // future API includes tombstones in its listing.
    if (computer.revoked === true || computer.revokedAt != null) continue;
    if (typeof computer.machineId !== "string" || !computer.machineId.trim() || computer.machineId.length > 128 ||
        typeof computer.hostname !== "string" || typeof computer.platform !== "string" ||
        typeof computer.daemonVersion !== "string" || !Array.isArray(computer.harnesses) ||
        !computer.harnesses.every((harness) => typeof harness === "string") ||
        !["idle", "busy", "offline"].includes(String(computer.status)) ||
        typeof computer.lastHeartbeat !== "number" || !Number.isFinite(computer.lastHeartbeat) ||
        computer.lastHeartbeat < 0 || seen.has(computer.machineId)) continue;
    seen.add(computer.machineId);
    // Project known display fields only; credentials never belong in state.
    computers.push({
      machineId: computer.machineId, hostname: computer.hostname,
      platform: computer.platform, daemonVersion: computer.daemonVersion,
      harnesses: [...computer.harnesses] as string[], status: computer.status as ConnectedComputer["status"],
      lastHeartbeat: computer.lastHeartbeat,
    });
  }
  return computers;
}

/** Match the daemon's CLI names and the server's 75-second liveness window. */
export function eligibleLocalComputers(raw: unknown, harness: string, now = Date.now()): ConnectedComputer[] {
  const daemonHarness = LOCAL_DAEMON_HARNESSES[harness.trim().toLowerCase()];
  if (!daemonHarness) return [];
  return readComputers(raw).filter((computer) =>
    (computer.status === "idle" || computer.status === "busy") &&
    now - computer.lastHeartbeat <= LOCAL_HEARTBEAT_STALE_MS &&
    computer.lastHeartbeat - now <= LOCAL_HEARTBEAT_STALE_MS &&
    computer.harnesses.includes(daemonHarness),
  ).sort((a, b) => a.hostname.localeCompare(b.hostname) || a.machineId.localeCompare(b.machineId));
}

interface Selection { machineId: string; source: "user" | "native" | "single"; identityKey: string }

export function useLocalRunTarget({
  harness,
  desktopStatus,
  enabled = true,
  identityKey = "dashboard",
}: {
  harness: string;
  desktopStatus: DesktopStatus | null;
  enabled?: boolean;
  identityKey?: string;
}) {
  const [fleet, setFleet] = useState<{ computers: ConnectedComputer[]; identityKey: string } | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [failure, setFailure] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [now, setNow] = useState(Date.now);
  const sequence = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled || activeRequest.current) return;
    const request = ++sequence.current;
    const abort = new AbortController();
    activeRequest.current = abort;
    const timeout = window.setTimeout(() => abort.abort(), 15_000);
    setLoading(true);
    try {
      const response = await fetch("/api/computers", {
        credentials: "same-origin", cache: "no-store", signal: abort.signal,
      });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403
        ? "Sign in to check paired computers."
        : response.status === 404 ? "Local execution is not enabled on this deployment."
          : `Paired computers could not be checked (${response.status}).`);
      const body: unknown = await response.json();
      const computers = readComputers(body && typeof body === "object" ? (body as { computers?: unknown }).computers : undefined);
      if (request !== sequence.current) return;
      setFleet({ computers, identityKey });
      setFailure(null);
      setNow(Date.now());
    } catch (error) {
      if (request !== sequence.current) return;
      setFleet({ computers: [], identityKey });
      setFailure(abort.signal.aborted ? "Paired computers check timed out. Retry."
        : error instanceof Error ? error.message : "Paired computers could not be checked.");
    } finally {
      window.clearTimeout(timeout);
      if (request === sequence.current) {
        activeRequest.current = null;
        setLoading(false);
      }
    }
  }, [enabled, identityKey]);

  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    void refresh();
    const poll = window.setInterval(() => void refresh(), POLL_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => {
      sequence.current += 1;
      activeRequest.current?.abort();
      activeRequest.current = null;
      window.clearInterval(poll);
      window.clearInterval(clock);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, refresh]);

  const computers = enabled && fleet?.identityKey === identityKey
    ? eligibleLocalComputers(fleet.computers, harness, now) : [];
  const nativeId = desktopStatus?.state === "idle" || desktopStatus?.state === "busy"
    ? desktopStatus.machineId : undefined;
  const native = computers.find((computer) => computer.machineId === nativeId);
  const chosen = selection?.identityKey === identityKey ? selection : null;
  // Native status is a preference only: its ID must also appear in the
  // authenticated API list with a fresh compatible heartbeat.
  const preferred = native && chosen?.source !== "user" ? native
    : chosen ? computers.find((computer) => computer.machineId === chosen.machineId)
      : computers.length === 1 ? computers[0] : undefined;
  const targetMachineId = preferred?.machineId;

  useEffect(() => {
    if (!targetMachineId || (chosen?.machineId === targetMachineId)) return;
    setSelection({ machineId: targetMachineId, source: native?.machineId === targetMachineId ? "native" : "single", identityKey });
  }, [targetMachineId, chosen?.machineId, native?.machineId, identityKey]);

  const selectMachine = useCallback((machineId: string) => {
    // The menu can only select an eligible server record, never a bridge-only ID.
    if (computers.some((computer) => computer.machineId === machineId)) {
      setSelection({ machineId, source: "user", identityKey });
    }
  }, [computers, identityKey]);
  const unsupported = !LOCAL_DAEMON_HARNESSES[harness.trim().toLowerCase()];
  const error = !enabled ? null : unsupported ? "The selected harness cannot run on a paired computer."
    : fleet?.identityKey !== identityKey ? null : failure
      ?? (chosen && !targetMachineId ? "The selected computer is offline or no longer available. Choose another paired computer." : null);
  return {
    computers,
    localRunAvailable: computers.length > 0,
    targetMachineId,
    loading: enabled && (loading || fleet?.identityKey !== identityKey),
    error,
    selectionRequired: computers.length > 1 && !targetMachineId,
    selectedComputerUnavailable: chosen !== null && !targetMachineId,
    selectMachine,
    refresh,
  };
}
