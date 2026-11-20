import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import {
  DISCORD_INSTALL_RESULT_PARAM,
  discordInstallResultSchema,
  type DiscordConnectionStatus,
  type DiscordInstallation,
  type DiscordInstallResult,
} from "@shiba/shared";
import { DiscordInstallationsClient } from "../discord-installations-client";
import type { IntegrationBindingInputs } from "../integration-connection-bindings";
import { ToneChip, type ChipTone } from "./ToneChip";

const GUILD_PARAM = "discordGuild";
const BUTTON_BASE =
  "inline-flex min-h-11 items-center justify-center rounded-[var(--radius-button)] border px-3 text-[11px] font-mono font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-8";
const SECONDARY_BUTTON = `${BUTTON_BASE} border-[var(--border-1)] bg-[var(--card)] text-[var(--fg)] hover:border-[var(--primary)]/40`;
const PRIMARY_BUTTON = `${BUTTON_BASE} border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-text)] shadow-[2px_2px_0_var(--paper-shadow)] hover:opacity-90`;
const DANGER_BUTTON = `${BUTTON_BASE} border-[color-mix(in_oklch,var(--destructive)_40%,transparent)] bg-[var(--destructive-soft)] text-[var(--destructive)]`;

type InstallNotice = { result: DiscordInstallResult; guildId: string | null };

export type DiscordConnection = {
  status: DiscordConnectionStatus | null;
  loading: boolean;
  loadError: string | null;
  pending: string | null;
  actionError: { key: string; message: string } | null;
  notice: InstallNotice | null;
  dismissNotice: () => void;
  reload: () => void;
  connect: (guildId?: string) => Promise<void>;
  disconnect: (guildId: string) => Promise<boolean>;
};

function takeInstallResult(): InstallNotice | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const raw = url.searchParams.get(DISCORD_INSTALL_RESULT_PARAM);
  if (raw === null) return null;
  const guildId = url.searchParams.get(GUILD_PARAM);
  url.searchParams.delete(DISCORD_INSTALL_RESULT_PARAM);
  url.searchParams.delete(GUILD_PARAM);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  const parsed = discordInstallResultSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { result: parsed.data, guildId: guildId && /^\d{1,24}$/.test(guildId) ? guildId : null };
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong. Try again.";
}

export function useDiscordConnection({
  workspaceId,
  client,
  navigate,
}: { workspaceId?: string; client?: DiscordInstallationsClient; navigate?: (url: string) => void } = {}): DiscordConnection {
  const api = useMemo(() => client ?? new DiscordInstallationsClient(workspaceId), [client, workspaceId]);
  const [status, setStatus] = useState<DiscordConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<DiscordConnection["actionError"]>(null);
  const [notice, setNotice] = useState<InstallNotice | null>(null);
  const life = useRef<AbortController | null>(null);
  const read = useRef<AbortController | null>(null);

  const reload = useCallback(() => {
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    setLoading(true);
    setLoadError(null);
    api
      .read(controller.signal)
      .then(
        (next) => {
          if (!controller.signal.aborted) setStatus(next);
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setStatus(null);
          setLoadError(errorText(error));
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
  }, [api]);

  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    reload();
    return () => {
      controller.abort();
      read.current?.abort();
    };
  }, [reload]);

  useEffect(() => {
    const taken = takeInstallResult();
    if (taken) setNotice(taken);
  }, []);

  const connect = useCallback(
    async (guildId?: string) => {
      const signal = life.current?.signal;
      if (!signal || signal.aborted) return;
      const key = guildId ? `reconnect:${guildId}` : "connect";
      setPending(key);
      setActionError(null);
      try {
        const url = await api.begin(guildId, signal);
        if (signal.aborted) return;
        (navigate ?? ((target: string) => window.location.assign(target)))(url);
      } catch (error) {
        if (signal.aborted) return;
        setActionError({ key, message: errorText(error) });
        setPending(null);
      }
    },
    [api, navigate],
  );

  const disconnect = useCallback(
    async (guildId: string) => {
      const signal = life.current?.signal;
      if (!signal || signal.aborted) return false;
      const key = `disconnect:${guildId}`;
      setPending(key);
      setActionError(null);
      try {
        const next = await api.disconnect(guildId, signal);
        if (signal.aborted) return false;
        read.current?.abort();
        setStatus(next);
        setLoadError(null);
        setLoading(false);
        return true;
      } catch (error) {
        if (!signal.aborted) setActionError({ key, message: errorText(error) });
        return false;
      } finally {
        if (!signal.aborted) setPending(null);
      }
    },
    [api],
  );

  return {
    status,
    loading,
    loadError,
    pending,
    actionError,
    notice,
    dismissNotice: () => setNotice(null),
    reload,
    connect,
    disconnect,
  };
}

function missingSettings(configured: DiscordConnectionStatus["configured"]): Array<{ names: string; purpose: string }> {
  const missing: Array<{ names: string; purpose: string }> = [];
  if (!configured.oauth) missing.push({ names: "DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET", purpose: "lets the dashboard connect a server" });
  if (!configured.publicKey) missing.push({ names: "DISCORD_PUBLIC_KEY", purpose: "verifies interaction signatures" });
  if (!configured.botToken) missing.push({ names: "DISCORD_BOT_TOKEN", purpose: "posts approval cards and results" });
  if (configured.approvers === 0) missing.push({ names: "DISCORD_APPROVERS", purpose: "Discord user ids allowed to approve runs" });
  return missing;
}

function activeCount(status: DiscordConnectionStatus): number {
  return status.installations.filter((row) => row.state === "active").length;
}

export function discordStatusChip(connection: Pick<DiscordConnection, "status" | "loading" | "loadError">): { tone: ChipTone; label: string } {
  if (connection.loadError) return { tone: "danger", label: "Error" };
  if (!connection.status) return { tone: "neutral", label: "Checking…" };
  if (missingSettings(connection.status.configured).length > 0) return { tone: "pending", label: "Setup required" };
  const active = activeCount(connection.status);
  if (active > 0) return { tone: "ok", label: `Connected (${active} ${active === 1 ? "server" : "servers"})` };
  if (connection.status.installations.some((row) => row.state === "error")) return { tone: "danger", label: "Error" };
  return { tone: "neutral", label: "Disconnected" };
}

export function DiscordStatusChip({ connection }: { connection: DiscordConnection }): JSX.Element {
  const chip = discordStatusChip(connection);
  return <ToneChip tone={chip.tone} label={chip.label} />;
}

export function discordBindingInput(connection: Pick<DiscordConnection, "status" | "loadError">): IntegrationBindingInputs["discord"] {
  if (connection.loadError) return undefined;
  const status = connection.status;
  if (!status) return { loading: true, configured: false, partial: false };
  const { configured } = status;
  return {
    loading: false,
    configured: missingSettings(configured).length === 0 && activeCount(status) > 0,
    partial: configured.oauth || configured.publicKey || configured.botToken || configured.approvers > 0 || status.installations.length > 0,
  };
}

const STATE_CHIP: Record<DiscordInstallation["state"], { tone: ChipTone; label: string }> = {
  active: { tone: "ok", label: "Active" },
  disconnected: { tone: "neutral", label: "Disconnected" },
  error: { tone: "danger", label: "Error" },
};

const NOTICE: Record<DiscordInstallResult, { tone: string; text: (guild: string | null) => string }> = {
  connected: {
    tone: "border-[color-mix(in_oklch,var(--success)_30%,transparent)] bg-[color-mix(in_oklch,var(--success)_12%,transparent)]",
    text: (guild) => (guild ? `Connected ${guild}. Shiba now answers commands there.` : "Discord server connected. Shiba now answers commands there."),
  },
  denied: {
    tone: "border-[var(--border-2)] bg-[var(--secondary)]",
    text: () => "Discord authorization was cancelled. Nothing was installed.",
  },
  failed: {
    tone: "border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] bg-[var(--destructive-soft)]",
    text: () => "Discord didn't finish connecting the server. Try again.",
  },
};

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function InlineError({ message }: { message: string }): JSX.Element {
  return (
    <p role="alert" className="text-[11px] text-[var(--destructive)]">
      {message}
    </p>
  );
}

function ServerRow({
  row,
  connection,
  canAuthorize,
  confirming,
  onConfirming,
}: {
  row: DiscordInstallation;
  connection: DiscordConnection;
  canAuthorize: boolean;
  confirming: boolean;
  onConfirming: (guildId: string | null) => void;
}): JSX.Element {
  const name = row.guildName || row.guildId;
  const busy = connection.pending !== null;
  const disconnecting = connection.pending === `disconnect:${row.guildId}`;
  const reconnecting = connection.pending === `reconnect:${row.guildId}`;
  const rowError =
    connection.actionError && connection.actionError.key.endsWith(`:${row.guildId}`) ? connection.actionError.message : null;
  const showReconnect = canAuthorize && (row.state !== "active" || !row.commandsRegistered);
  const chip = STATE_CHIP[row.state];
  return (
    <li className="space-y-1.5 border border-[var(--border-1)] bg-[var(--card)] px-3 py-2.5" data-testid={`discord-guild-${row.guildId}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-words text-[13px] font-semibold text-[var(--fg)]">{name}</span>
            <ToneChip tone={chip.tone} label={chip.label} />
          </div>
          <p className="font-mono text-[11px] tabular-nums text-[var(--muted-foreground-2)]">
            Installed by {row.installedBy} · {formatTime(row.installedAt)}
          </p>
          {row.lastError ? <p className="break-words text-[11px] text-[var(--destructive)]">Last error: {row.lastError}</p> : null}
          {row.state === "active" && !row.commandsRegistered ? (
            <p className="text-[11px] text-[var(--warning-fg)]">
              Slash commands aren&apos;t registered in this server yet. Reconnect to register them.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {showReconnect ? (
            <button
              type="button"
              className={SECONDARY_BUTTON}
              aria-label={`Reconnect ${name}`}
              disabled={busy}
              onClick={() => void connection.connect(row.guildId)}
            >
              {reconnecting ? "Opening Discord…" : "Reconnect"}
            </button>
          ) : null}
          {row.state === "active" && !confirming ? (
            <button
              type="button"
              className={SECONDARY_BUTTON}
              aria-label={`Disconnect ${name}`}
              disabled={busy}
              onClick={() => onConfirming(row.guildId)}
            >
              Disconnect
            </button>
          ) : null}
        </div>
      </div>
      {row.state === "active" && confirming ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border-1)] pt-2" role="group" aria-label={`Confirm disconnecting ${name}`}>
          <span className="text-[11px] text-[var(--fg)]">Disconnect {name}? Shiba stops answering commands and mentions there.</span>
          <button
            type="button"
            className={DANGER_BUTTON}
            disabled={busy}
            onClick={async () => {
              if (await connection.disconnect(row.guildId)) onConfirming(null);
            }}
          >
            {disconnecting ? "Disconnecting…" : "Confirm disconnect"}
          </button>
          <button type="button" className={SECONDARY_BUTTON} disabled={disconnecting} onClick={() => onConfirming(null)}>
            Cancel
          </button>
        </div>
      ) : null}
      {rowError ? <InlineError message={rowError} /> : null}
    </li>
  );
}

export function DiscordConnectionPanel({ connection }: { connection: DiscordConnection }): JSX.Element {
  const [confirming, setConfirming] = useState<string | null>(null);
  const { status, loading, loadError, notice, pending } = connection;
  const missing = status ? missingSettings(status.configured) : [];
  const noticeGuild = notice?.guildId ? status?.installations.find((row) => row.guildId === notice.guildId)?.guildName ?? null : null;
  return (
    <div className="space-y-3" data-testid="discord-connection-panel">
      <p>Run commands and progress posts in Discord.</p>
      {notice ? (
        <div role="status" className={`flex flex-wrap items-center justify-between gap-2 border px-3 py-2 text-[var(--fg)] ${NOTICE[notice.result].tone}`}>
          <span>{NOTICE[notice.result].text(noticeGuild)}</span>
          <button type="button" className={SECONDARY_BUTTON} onClick={connection.dismissNotice}>
            Dismiss
          </button>
        </div>
      ) : null}
      {loading && !status && !loadError ? <p role="status">Checking Discord connection…</p> : null}
      {loadError ? (
        <div className="flex flex-wrap items-center gap-2">
          <InlineError message={loadError} />
          <button type="button" className={SECONDARY_BUTTON} disabled={loading} onClick={connection.reload}>
            {loading ? "Retrying…" : "Retry"}
          </button>
        </div>
      ) : null}
      {status && missing.length > 0 ? (
        <div
          className="space-y-2 border border-[color-mix(in_oklch,var(--warning)_30%,transparent)] bg-[var(--warning-subtle)] px-3 py-2.5 text-[var(--fg)]"
          data-testid="discord-setup-required"
        >
          <p className="font-semibold">Missing deployment settings</p>
          <ul className="space-y-1">
            {missing.map((item) => (
              <li key={item.names}>
                <code className="font-mono text-[11px]">{item.names}</code>
                <span className="text-[var(--muted-foreground-2)]"> — {item.purpose}</span>
              </li>
            ))}
          </ul>
          <p>Set these as Worker secrets, then paste this Interactions Endpoint URL into the Discord developer portal:</p>
          <code className="block select-all break-all border border-[var(--border-1)] bg-[var(--card)] px-2 py-1 font-mono text-[11px]">
            {status.interactionsUrl}
          </code>
        </div>
      ) : null}
      {status && missing.length === 0 ? (
        <p className="break-all font-mono text-[11px] text-[var(--muted-foreground-2)]">Interactions endpoint: {status.interactionsUrl}</p>
      ) : null}
      {status && status.installations.length > 0 ? (
        <ul className="space-y-2" aria-label="Discord servers">
          {status.installations.map((row) => (
            <ServerRow
              key={row.guildId}
              row={row}
              connection={connection}
              canAuthorize={status.configured.oauth}
              confirming={confirming === row.guildId}
              onConfirming={setConfirming}
            />
          ))}
        </ul>
      ) : null}
      {status && status.installations.length === 0 ? <p>No Discord server is connected yet.</p> : null}
      {status?.configured.oauth ? (
        <div className="space-y-1.5">
          <button type="button" className={PRIMARY_BUTTON} disabled={pending !== null} onClick={() => void connection.connect()}>
            {pending === "connect" ? "Opening Discord…" : "Connect a server"}
          </button>
          {connection.actionError?.key === "connect" ? <InlineError message={connection.actionError.message} /> : null}
        </div>
      ) : null}
    </div>
  );
}
