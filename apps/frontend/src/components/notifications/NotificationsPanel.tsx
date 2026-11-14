import { Bell, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import type { WorkspaceNotification } from "@shiba/shared";

async function notificationsFetch<T>(
  path: string,
  workspaceId: string | undefined,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(workspaceId ? { "X-Shiba-Workspace": workspaceId } : {}),
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
}

export interface NotificationsPanelProps {
  workspaceId?: string;
  className?: string;
}

export function NotificationsPanel({ workspaceId, className = "" }: NotificationsPanelProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<WorkspaceNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [needsYouOnly, setNeedsYouOnly] = useState(false);

  const unreadCount = useMemo(() => items.filter((item) => item.readAt == null).length, [items]);

  const reload = useCallback(() => {
    setLoading(true);
    setError("");
    void notificationsFetch<{ notifications: WorkspaceNotification[] }>(
      "/api/workspace-notifications",
      workspaceId,
    )
      .then((body) => setItems(body.notifications ?? []))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  }, [workspaceId]);

  useEffect(() => {
    if (!open) return;
    reload();
    const timer = window.setInterval(reload, 15_000);
    return () => window.clearInterval(timer);
  }, [open, reload]);

  useEffect(() => {
    let cancelled = false;
    void notificationsFetch<{ notifications: WorkspaceNotification[] }>(
      "/api/workspace-notifications",
      workspaceId,
    )
      .then((body) => {
        if (!cancelled) setItems(body.notifications ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const markRead = async (notificationId: string) => {
    try {
      await notificationsFetch<{ read: boolean }>(
        `/api/workspace-notifications/${encodeURIComponent(notificationId)}/read`,
        workspaceId,
        { method: "POST" },
      );
      setItems((current) =>
        current.map((item) =>
          item.notificationId === notificationId ? { ...item, readAt: Date.now() } : item,
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className={`relative ${className}`.trim()}>
      <button
        type="button"
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="relative flex min-h-11 min-w-11 items-center justify-center border border-[var(--line)] bg-[var(--card)] text-[var(--ink)] hover:bg-[var(--panel-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]"
      >
        <Bell className="size-4" strokeWidth={1.75} aria-hidden="true" />
        {unreadCount > 0 ? (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 flex size-4 items-center justify-center bg-[var(--navy)] font-mono text-[9px] font-bold text-[var(--paper-title-fg)]"
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Workspace notifications"
          className="absolute right-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] border border-[var(--line)] bg-[var(--paper)] text-[var(--ink)] shadow-[var(--sh-card)]"
        >
          <header className="flex items-center justify-between gap-2 border-b border-[var(--line)] px-3 py-2">
            <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-2)]">Notifications</p>
            <button
              type="button"
              aria-label="Close notifications"
              onClick={() => setOpen(false)}
              className="min-h-11 min-w-11 flex items-center justify-center text-[var(--ink-2)] hover:text-[var(--ink)]"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </header>
          {error ? (
            <p role="alert" className="px-3 py-2 text-xs text-[var(--danger)]">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2 border-b border-[var(--line)] px-3 py-2">
            <button
              type="button"
              aria-pressed={needsYouOnly}
              onClick={() => setNeedsYouOnly((value) => !value)}
              className={`min-h-11 px-2 text-[10px] font-semibold uppercase ${needsYouOnly ? "text-[var(--ink)]" : "text-[var(--ink-2)]"}`}
            >
              Needs you
            </button>
          </div>
          <ul className="max-h-80 overflow-y-auto">
            {loading && items.length === 0 ? (
              <li className="px-3 py-4 text-xs text-[var(--ink-2)]">Loading…</li>
            ) : items.filter((item) => !needsYouOnly || item.kind === "needs_you" || item.kind === "approval" || item.kind === "ask_user").length === 0 ? (
              <li className="px-3 py-4 text-xs text-[var(--ink-2)]">No notifications yet.</li>
            ) : (
              items.filter((item) => !needsYouOnly || item.kind === "needs_you" || item.kind === "approval" || item.kind === "ask_user").map((item) => (
                <li key={item.notificationId} className="border-b border-[var(--line)] last:border-b-0">
                  <button
                    type="button"
                    onClick={() => void markRead(item.notificationId)}
                    className={`w-full px-3 py-3 text-left hover:bg-[var(--panel-2)] ${item.readAt == null ? "bg-[var(--panel-2)]/60" : ""}`}
                  >
                    <div className="flex items-start gap-2">
                      {item.readAt == null ? (
                        <span aria-hidden="true" className="mt-1 size-1.5 shrink-0 rounded-full bg-[var(--navy)]" />
                      ) : (
                        <span aria-hidden="true" className="mt-1 size-1.5 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-[var(--ink)]">{item.title}</p>
                        {item.body ? (
                          <p className="mt-0.5 line-clamp-2 text-xs text-[var(--ink-2)]">{item.body}</p>
                        ) : null}
                        <p className="mt-1 font-mono text-[9px] text-[var(--ink-2)]">
                          {new Date(item.createdAt).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}