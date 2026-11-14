import { useCallback, useEffect, useState, type JSX } from "react";
import type { WorkspaceNotificationPrefs } from "@shiba/shared";
import { LoadErrorState } from "../LoadErrorState";
import { Card } from "../settings-ui";

const PREFS: Array<{ key: keyof WorkspaceNotificationPrefs; label: string; blurb: string }> = [
  { key: "mentions", label: "Mentions", blurb: "When someone @-mentions you in a channel or DM." },
  { key: "threadReplies", label: "Thread replies", blurb: "Replies on threads you follow." },
  { key: "agentApprovals", label: "Agent approvals", blurb: "When an employee needs human approval." },
];

export function NotificationPrefsSection(): JSX.Element {
  const [prefs, setPrefs] = useState<WorkspaceNotificationPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  const reload = useCallback(() => {
    setError(null);
    void fetch("/api/workspace-notifications/prefs", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Prefs unavailable (${response.status}).`);
        const body = (await response.json()) as { prefs?: WorkspaceNotificationPrefs };
        setPrefs(body.prefs ?? { mentions: true, threadReplies: true, agentApprovals: true });
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const toggle = async (key: keyof WorkspaceNotificationPrefs) => {
    if (!prefs) return;
    const next = { ...prefs, [key]: !prefs[key] };
    setSaving(true);
    setNotice("");
    try {
      const response = await fetch("/api/workspace-notifications/prefs", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: next[key] }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Save failed (${response.status}).`);
      }
      const body = (await response.json()) as { prefs: WorkspaceNotificationPrefs };
      setPrefs(body.prefs);
      setNotice("Preferences saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  if (error && !prefs) {
    return <LoadErrorState message={error} onRetry={reload} />;
  }

  if (!prefs) {
    return (
      <Card>
        <div role="status" className="px-4 py-6 text-center text-xs text-[var(--muted-foreground-2)]">
          Reading notification preferences…
        </div>
      </Card>
    );
  }

  return (
    <Card>
      {PREFS.map((row) => (
        <label
          key={row.key}
          className="flex cursor-pointer items-start gap-3 border-b border-[var(--border-1)] px-4 py-3 last:border-b-0"
        >
          <input
            type="checkbox"
            checked={prefs[row.key]}
            disabled={saving}
            onChange={() => void toggle(row.key)}
            className="mt-1"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-[var(--fg)]">{row.label}</span>
            <span className="mt-0.5 block text-xs text-[var(--muted-foreground-2)]">{row.blurb}</span>
          </span>
        </label>
      ))}
      {notice ? (
        <p role="status" className="border-t border-[var(--border-1)] px-4 py-2 text-xs text-[var(--success)]">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="border-t border-[var(--border-1)] px-4 py-2 text-xs text-[var(--destructive)]">
          {error}
        </p>
      ) : null}
    </Card>
  );
}