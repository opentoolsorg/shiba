import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { toast } from "sonner";
import { Laptop, Plus, RefreshCw, X } from "lucide-react";
import {
  formatDesktopConnectionLabel,
  formatDesktopHarnessSummary,
  type ComputerStatus,
  type ConnectedComputer,
  type PairingTokenResponse,
} from "@shiba/shared";
import { LoadErrorState } from "./LoadErrorState";
import { createLatest, shouldShowConnect, useDesktopStatus } from "../desktop-status";

const POLL_MS = 10_000;

type FleetState =
  | { kind: "loading" }
  | { kind: "disabled" }
  | { kind: "error"; message: string }
  | { kind: "ready"; computers: ConnectedComputer[] };

type Identity = { kind: "checking" } | { kind: "ok"; agent: string } | { kind: "down"; message: string };

const STATUS_DOT: Record<ComputerStatus, string> = {
  idle: "bg-emerald-500",
  busy: "bg-amber-500 animate-pulse",
  offline: "bg-zinc-400 dark:bg-zinc-600",
};

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function PairingModal({ pairing, onClose }: { pairing: PairingTokenResponse; onClose: () => void }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearInterval(tick);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const remaining = pairing.expiresAt - now;
  const expired = remaining <= 0;

  const copy = () => {
    navigator.clipboard.writeText(pairing.connectCommand).then(
      () => toast("Connect command copied"),
      () => toast.error("Copy failed — select the command and copy it manually"),
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pairing-heading"
        className="w-full max-w-xl rounded-xl border border-[#e4e4e7] dark:border-zinc-800 bg-white dark:bg-[#121214] shadow-xl p-5 flex flex-col gap-4"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 id="pairing-heading" className="text-sm font-semibold text-[#0a0a0a] dark:text-zinc-100">Add computer</h3>
            <p className="text-xs text-[#71717a] dark:text-zinc-400 mt-0.5">
              Run this on the machine you want to pair. The token works once; the daemon then connects outbound only.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="size-7 rounded-md flex items-center justify-center text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-[#f4f4f5] dark:hover:bg-zinc-800 transition-colors"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        <pre className="text-[11px] font-mono bg-[#f4f4f5] dark:bg-zinc-900 border border-[#e4e4e7] dark:border-zinc-800 rounded-lg p-3 whitespace-pre-wrap break-all text-[#0a0a0a] dark:text-zinc-100 select-all">
          {pairing.connectCommand}
        </pre>
        <div className="flex items-center justify-between gap-3">
          <span className={`text-xs font-mono ${expired ? "text-red-500" : "text-[#71717a] dark:text-zinc-400"}`} aria-live="polite">
            {expired ? "Token expired — close and generate a new one" : `Expires in ${countdown(remaining)}`}
          </span>
          <button
            type="button"
            onClick={copy}
            disabled={expired}
            className="h-8 px-3 rounded-lg text-xs font-medium bg-[#0a0a0a] dark:bg-zinc-100 text-white dark:text-zinc-900 hover:bg-[#27272a] dark:hover:bg-zinc-200 transition-colors disabled:opacity-40"
          >
            Copy command
          </button>
        </div>
      </div>
    </div>
  );
}

export function RemoteAccessView(): JSX.Element {
  const [fleet, setFleet] = useState<FleetState>({ kind: "loading" });
  const [identity, setIdentity] = useState<Identity>({ kind: "checking" });
  const [pairing, setPairing] = useState<PairingTokenResponse | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const { bridge, status: desktopStatus, refresh: refreshDesktop } = useDesktopStatus();
  const showConnectThisComputer = shouldShowConnect(bridge !== undefined, desktopStatus);
  const mounted = useRef(true);
  const [loads] = useState(createLatest);

  const load = useCallback(async () => {
    const seq = loads.next();
    const apply = (next: FleetState) => {
      if (mounted.current && loads.isLatest(seq)) setFleet(next);
    };
    try {
      const res = await fetch("/api/computers", { cache: "no-store" });
      if (res.status === 404) return apply({ kind: "disabled" });
      if (!res.ok) return apply({ kind: "error", message: `GET /api/computers failed with ${res.status}.` });
      const body = (await res.json()) as { computers?: ConnectedComputer[] };
      apply({ kind: "ready", computers: body.computers ?? [] });
    } catch {
      apply({ kind: "error", message: "Network error reaching /api/computers." });
    }
  }, [loads]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const poll = window.setInterval(() => void load(), POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(poll);
    };
  }, [load]);

  useEffect(() => {
    fetch("/api/whoami", { redirect: "manual", cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as { agent?: unknown } | null;
        if (!mounted.current) return;
        setIdentity(
          res.ok && typeof body?.agent === "string"
            ? { kind: "ok", agent: body.agent }
            : { kind: "down", message: `GET /api/whoami returned ${res.status || "a redirect"}.` },
        );
      })
      .catch(() => {
        if (mounted.current) setIdentity({ kind: "down", message: "Network error reaching /api/whoami." });
      });
  }, []);

  const addComputer = async () => {
    setPairingBusy(true);
    try {
      const res = await fetch("/api/computers/pairing-token", { method: "POST" });
      if (res.status === 404) { setFleet({ kind: "disabled" }); return; }
      if (res.status === 503) throw new Error("Pairing is not configured — set PAIRING_SECRET or LOCAL_ADAPTER_TOKEN on the Worker.");
      if (!res.ok) throw new Error(`POST /api/computers/pairing-token failed with ${res.status}.`);
      setPairing((await res.json()) as PairingTokenResponse);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create a pairing token.");
    } finally {
      setPairingBusy(false);
    }
  };

  const connectThisComputer = async () => {
    if (!bridge) return;
    setPairingBusy(true);
    try {
      const res = await fetch("/api/computers/pairing-token", { method: "POST" });
      if (!mounted.current) return;
      if (res.status === 503) throw new Error("Pairing is not configured — set PAIRING_SECRET or LOCAL_ADAPTER_TOKEN on the Worker.");
      if (!res.ok) {
        if (res.status === 404) setFleet({ kind: "disabled" });
        refreshDesktop();
        throw new Error(`POST /api/computers/pairing-token failed with ${res.status}.`);
      }
      const body = (await res.json()) as PairingTokenResponse;
      const result = await bridge.pair(body.token);
      if (!mounted.current) return;
      if (result.ok) {
        toast("This computer is connected.");
      } else {
        toast.error(result.error);
      }
      refreshDesktop();
      void load();
    } catch (err) {
      if (mounted.current) toast.error(err instanceof Error ? err.message : "Could not pair this computer.");
    } finally {
      if (mounted.current) setPairingBusy(false);
    }
  };

  const revoke = async (machine: ConnectedComputer) => {
    setConfirmRevoke(null);
    try {
      const res = await fetch("/api/computers/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ machineId: machine.machineId }),
      });
      if (!res.ok) throw new Error(`Revoke failed with ${res.status}.`);
      toast(`Revoked ${machine.hostname}`);
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Revoke failed.");
    }
  };

  const closePairing = useCallback(() => {
    setPairing(null);
    void load();
  }, [load]);

  const computers = fleet.kind === "ready" ? fleet.computers : [];
  const online = computers.filter((c) => c.status !== "offline").length;

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#fafafa] dark:bg-[#0c0c0e] text-[#0a0a0a] dark:text-zinc-100">
      <div className="border-b border-[#e4e4e7] dark:border-zinc-800 bg-white dark:bg-[#121214] px-6 py-4 flex flex-wrap items-center justify-between gap-4 shrink-0">
        <div>
          <h2 className="text-base font-semibold text-[#0a0a0a] dark:text-zinc-100 flex items-center gap-2">
            <span>Remote Access</span>
            {fleet.kind === "ready" ? (
              <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                {online}/{computers.length} online
              </span>
            ) : null}
          </h2>
          <p className="text-xs text-[#71717a] dark:text-zinc-400 mt-0.5">
            Pair local machines with one command. Daemons connect outbound — no open ports on your computer.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {bridge && showConnectThisComputer ? (
            <button
              type="button"
              onClick={() => void connectThisComputer()}
              disabled={pairingBusy}
              className="h-8 px-3 rounded-lg text-xs font-medium bg-[#0a0a0a] dark:bg-zinc-100 text-white dark:text-zinc-900 hover:bg-[#27272a] dark:hover:bg-zinc-200 transition-colors disabled:opacity-40"
            >
              {pairingBusy ? "Connecting…" : "Connect this computer"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void addComputer()}
            disabled={fleet.kind !== "ready" || pairingBusy}
            className={
              bridge
                ? "h-8 px-3 rounded-lg border border-[#e4e4e7] dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-medium text-[#0a0a0a] dark:text-zinc-100 hover:bg-[#f4f4f5] dark:hover:bg-zinc-700/50 transition-colors disabled:opacity-40"
                : "h-8 px-3 rounded-lg text-xs font-medium bg-[#0a0a0a] dark:bg-zinc-100 text-white dark:text-zinc-900 hover:bg-[#27272a] dark:hover:bg-zinc-200 transition-colors disabled:opacity-40"
            }
          >
            {pairingBusy && !bridge ? "Generating…" : bridge ? "Add another computer" : "Add computer"}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-5xl mx-auto flex flex-col gap-6">
          <section aria-labelledby="connections-heading" className="flex flex-col gap-3">
            <div className="pb-1 border-b border-[#e4e4e7] dark:border-zinc-800">
              <h3 id="connections-heading" className="text-sm font-semibold text-[#0a0a0a] dark:text-zinc-100">Connections</h3>
            </div>
            <div className="rounded-xl border border-[#e4e4e7] dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 shadow-xs grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="flex items-center gap-2">
                <span
                  className={`size-2 rounded-full ${identity.kind === "ok" ? "bg-emerald-500" : identity.kind === "down" ? "bg-red-500" : "bg-zinc-400"}`}
                  aria-hidden="true"
                />
                <span className="text-[#71717a] dark:text-zinc-400">Worker endpoint</span>
                <span className="font-mono text-[#0a0a0a] dark:text-zinc-200 truncate">
                  {identity.kind === "ok" ? "reachable" : identity.kind === "down" ? identity.message : "checking…"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[#71717a] dark:text-zinc-400">Signed in as</span>
                <span className="font-mono text-[#0a0a0a] dark:text-zinc-200 truncate">{identity.kind === "ok" ? identity.agent : "—"}</span>
              </div>
              {bridge ? (
                <div
                  className="sm:col-span-2 flex flex-col gap-1 border-t border-[#e4e4e7] dark:border-zinc-800 pt-3"
                  role="status"
                  aria-live="polite"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`size-2 rounded-full shrink-0 ${
                        desktopStatus?.state === "idle"
                          ? "bg-emerald-500"
                          : desktopStatus?.state === "busy"
                            ? "bg-amber-500 animate-pulse"
                            : desktopStatus?.state === "starting"
                              ? "bg-amber-500"
                              : "bg-zinc-400"
                      }`}
                      aria-hidden="true"
                    />
                    <span className="text-[#71717a] dark:text-zinc-400">This app</span>
                    <span className="font-mono text-[#0a0a0a] dark:text-zinc-200 truncate">
                      {desktopStatus
                        ? formatDesktopConnectionLabel(desktopStatus)
                        : "Checking desktop connection…"}
                    </span>
                  </div>
                  {desktopStatus?.harnesses?.length ? (
                    <p className="text-[10px] font-mono text-[#71717a] dark:text-zinc-400 pl-4">
                      Harnesses: {formatDesktopHarnessSummary(desktopStatus.harnesses)}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>

          <section aria-labelledby="computers-heading" className="flex flex-col gap-3">
            <div className="flex items-center justify-between pb-1 border-b border-[#e4e4e7] dark:border-zinc-800">
              <h3 id="computers-heading" className="text-sm font-semibold text-[#0a0a0a] dark:text-zinc-100">Computers</h3>
              <span className="text-xs font-mono text-[#71717a] dark:text-zinc-400">
                {computers.length} paired · refreshes every {POLL_MS / 1000}s
              </span>
            </div>

            {fleet.kind === "loading" ? (
              <p className="text-xs text-[#71717a] dark:text-zinc-400 py-6 text-center">Loading fleet…</p>
            ) : fleet.kind === "error" ? (
              <LoadErrorState message={fleet.message} onRetry={() => void load()} />
            ) : fleet.kind === "disabled" || computers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 border border-dashed border-[#e4e4e7] dark:border-zinc-800 rounded-xl bg-white dark:bg-zinc-900 text-center p-6">
                <Laptop className="size-8 text-[#71717a] dark:text-zinc-500 mb-2" strokeWidth={1.5} />
                <h4 className="text-sm font-semibold text-[#0a0a0a] dark:text-zinc-100">
                  {fleet.kind === "disabled" ? "Remote access is off on this deployment" : "No computers paired"}
                </h4>
                <p className="text-xs text-[#71717a] dark:text-zinc-400 max-w-sm mt-0.5">
                  {fleet.kind === "disabled" ? (
                    <>
                      Set <code className="font-mono">SHIBA_LOCAL_RUNTIME=1</code> on the Worker to pair local daemons.
                    </>
                  ) : (
                    "Use Add computer to generate a one-time connect command."
                  )}
                </p>
              </div>
            ) : (
              <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {computers.map((c) => (
                  <li
                    key={c.machineId}
                    className="rounded-xl border border-[#e4e4e7] dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 shadow-xs flex flex-col gap-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className={`size-2 rounded-full shrink-0 ${STATUS_DOT[c.status]}`} title={c.status} aria-hidden="true" />
                      <span className="text-sm font-semibold text-[#0a0a0a] dark:text-zinc-100 truncate flex-1">{c.hostname}</span>
                      {desktopStatus?.machineId === c.machineId ? (
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                          This computer
                        </span>
                      ) : null}
                      <span className="text-[10px] font-mono uppercase text-[#71717a] dark:text-zinc-400">{c.status}</span>
                    </div>
                    <div className="text-[11px] font-mono text-[#71717a] dark:text-zinc-400 flex flex-wrap gap-x-3">
                      <span>{c.platform}</span>
                      <span>v{c.daemonVersion}</span>
                      <span>seen {ago(c.lastHeartbeat)}</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {c.harnesses.length === 0 ? (
                        <span className="text-[10px] text-[#71717a] dark:text-zinc-400">no harnesses detected</span>
                      ) : (
                        c.harnesses.map((h) => (
                          <span
                            key={h}
                            className="text-[10px] font-mono px-1.5 py-0.5 rounded-md bg-[#f4f4f5] dark:bg-zinc-800 text-[#0a0a0a] dark:text-zinc-200 border border-[#e4e4e7] dark:border-zinc-700"
                          >
                            {h}
                          </span>
                        ))
                      )}
                    </div>
                    <div className="flex justify-end gap-2 pt-1 border-t border-[#e4e4e7]/60 dark:border-zinc-800/60 mt-1">
                      {confirmRevoke === c.machineId ? (
                        <>
                          <span className="text-[11px] text-red-500 self-center">Revoke {c.hostname}?</span>
                          <button
                            type="button"
                            onClick={() => setConfirmRevoke(null)}
                            className="h-7 px-2 rounded-md text-xs border border-[#e4e4e7] dark:border-zinc-700 bg-white dark:bg-zinc-800 text-[#0a0a0a] dark:text-zinc-200 hover:bg-[#f4f4f5] transition-colors"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => void revoke(c)}
                            className="h-7 px-2 rounded-md text-xs font-semibold text-white bg-red-600 hover:bg-red-700 transition-colors"
                          >
                            Confirm revoke
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmRevoke(c.machineId)}
                          className="h-7 px-2 rounded-md text-xs text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/50 bg-red-50/50 dark:bg-red-950/20 hover:bg-red-100 transition-colors"
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {pairing ? <PairingModal pairing={pairing} onClose={closePairing} /> : null}
    </div>
  );
}
