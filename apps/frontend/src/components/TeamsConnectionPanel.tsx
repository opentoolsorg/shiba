import { useCallback, useEffect, useId, useRef, useState, type JSX } from "react";
import { z } from "zod";
import { teamWorkspaceHeaders, teamWorkspaceRequest, TeamWorkspaceRequestError } from "../team-workspaces-client";
import { ToneChip, type ChipTone } from "./ToneChip";

const connectionSchema = z.object({
  status: z.enum(["not_configured", "disconnected", "connected", "error"]),
  installed: z.boolean(),
  error: z.string().optional(),
});
type Connection = z.infer<typeof connectionSchema>;
type Action = "connect" | "disconnect";
const statuses = {
  not_configured: { tone: "neutral", label: "Not configured" },
  disconnected: { tone: "neutral", label: "Disabled" },
  connected: { tone: "ok", label: "Enabled" },
  error: { tone: "danger", label: "Status unavailable" },
} satisfies Record<Connection["status"], { tone: ChipTone; label: string }>;
const buttonClass = "inline-flex min-h-11 items-center border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs font-medium hover:bg-[var(--card-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)] disabled:opacity-50";

export function TeamsConnectionPanel({ workspaceId }: { workspaceId: string }): JSX.Element {
  const headingId = useId();
  const active = useRef<AbortController | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [pending, setPending] = useState<Action | "read" | null>("read");
  const [error, setError] = useState<string | null>(null);

  const request = useCallback(async (action?: Action) => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(action ?? "read");
    setError(null);
    try {
      const body = await teamWorkspaceRequest<unknown>("/api/teams/connection", {
        method: action ? "POST" : "GET",
        headers: teamWorkspaceHeaders(workspaceId),
        redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        ...(action ? { body: JSON.stringify({ action }) } : {}),
      });
      if (!controller.signal.aborted) setConnection(connectionSchema.parse(body));
    } catch (cause) {
      if (!controller.signal.aborted) {
        setConnection(null);
        setError(cause instanceof TeamWorkspaceRequestError && cause.message
          ? cause.message
          : action ? "Shiba couldn’t confirm the change. Refresh Teams status before trying again." : "Couldn’t read Teams status. Try refreshing.");
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        setPending(null);
      }
    }
  }, [workspaceId]);

  useEffect(() => {
    void request();
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [request]);

  const action = connection?.status === "connected" ? "disconnect" : connection?.status === "disconnected" ? "connect" : null;
  return (
    <section aria-labelledby={headingId} className="min-w-0 max-w-2xl space-y-3 border border-[var(--line)] bg-[var(--paper)] p-4 text-[var(--ink)]">
      <h3 id={headingId} className="text-base font-semibold">Microsoft Teams connection</h3>
      <p className="text-xs leading-relaxed text-[var(--ink-2)]">This connection controls whether Shiba accepts Teams activity for this workspace. It doesn’t install or remove the app in Microsoft Teams.</p>
      <div role="status">
        {pending ? <p className="text-xs">{pending === "read" ? "Checking Teams status…" : pending === "connect" ? "Enabling Teams in Shiba…" : "Disabling Teams in Shiba…"}</p> : null}
        {connection ? (
          <dl className="grid gap-3 border-y border-[var(--line)] py-3 sm:grid-cols-2">
            <div className="space-y-1">
              <dt className="text-xs font-medium">Shiba connection</dt>
              <dd><ToneChip {...statuses[connection.status]} /></dd>
            </div>
            <div className="space-y-1">
              <dt className="text-xs font-medium">Teams installation</dt>
              <dd><ToneChip tone={connection.installed ? "ok" : "neutral"} label={connection.installed ? "Installation observed" : "Not yet observed"} /></dd>
            </div>
          </dl>
        ) : null}
      </div>
      {connection?.status === "not_configured" ? <p className="text-xs text-[var(--ink-2)]">Ask your deployment operator to configure Microsoft Teams first.</p> : null}
      {connection?.status === "connected" && !connection.installed ? <p className="text-xs text-[var(--ink-2)]">Install the app in Teams, then refresh here to see if Shiba has received the installation event.</p> : null}
      {error || connection?.status === "error" ? <p role="alert" className="break-words text-xs text-[var(--destructive)]">{error || connection?.error || "Teams status is unavailable. Try refreshing."}</p> : null}
      <div className="flex flex-wrap gap-2">
        {action ? <button type="button" className={buttonClass} disabled={pending !== null} onClick={() => void request(action)}>{action === "connect" ? "Enable Teams in Shiba" : "Disable Teams in Shiba"}</button> : null}
        <button type="button" className={buttonClass} disabled={pending !== null} onClick={() => void request()}>Refresh Teams status</button>
        <a href="/docs/teams-setup/" target="_blank" rel="noreferrer" className={buttonClass}>Teams setup guide</a>
      </div>
    </section>
  );
}
