import { useCallback, useEffect, useState, type JSX } from "react";
import { LoadErrorState } from "./LoadErrorState";

const FIELD =
  "bg-[var(--panel)] border border-[var(--border-1)] rounded-[var(--radius-button)] text-[var(--fg)] px-2.5 py-1.5 text-xs focus:outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]/40 placeholder-[var(--muted-foreground-3)]/60 transition-colors w-full";

const SANDBOX_PROVIDERS = ["cloudflare", "docker-local", "computesdk", "e2b"] as const;

export interface CustomAgentWire {
  id: string;
  slug: string;
  version: number;
  config: {
    name: string;
    emoji?: string;
    instructions: string;
    harness: string;
    codingModel?: string;
    connectionId?: string;
    sandboxProvider?: string;
    defaultRepoUrl?: string;
    approvalPolicy?: string;
  };
}

const EMPTY_FORM = {
  slug: "",
  name: "",
  emoji: "",
  instructions: "",
  harness: "opencode",
  codingModel: "",
  connectionId: "",
  sandboxProvider: "",
  defaultRepoUrl: "",
};

export function CustomAgentsView(): JSX.Element {
  const [agents, setAgents] = useState<CustomAgentWire[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [expectedVersion, setExpectedVersion] = useState<number | undefined>(undefined);

  const refresh = useCallback(() => {
    setLoadError(null);
    fetch("/api/custom-agents")
      .then(async (r) => {
        if (!r.ok) throw new Error(`Custom agents could not be loaded (${r.status}).`);
        return (await r.json()) as { agents?: CustomAgentWire[] };
      })
      .then((body) => setAgents(body.agents ?? []))
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : "Custom agents could not be loaded.");
      });
  }, []);

  useEffect(refresh, [refresh]);

  const resetForm = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setExpectedVersion(undefined);
  };

  const startEdit = (agent: CustomAgentWire) => {
    setEditingId(agent.id);
    setExpectedVersion(agent.version);
    setForm({
      slug: agent.slug,
      name: agent.config.name,
      emoji: agent.config.emoji ?? "",
      instructions: agent.config.instructions,
      harness: agent.config.harness,
      codingModel: agent.config.codingModel ?? "",
      connectionId: agent.config.connectionId ?? "",
      sandboxProvider: agent.config.sandboxProvider ?? "",
      defaultRepoUrl: agent.config.defaultRepoUrl ?? "",
    });
  };

  const saveAgent = async () => {
    const slug = form.slug.trim().toLowerCase();
    const name = form.name.trim();
    const instructions = form.instructions.trim();
    if (!slug || !name || !instructions) {
      setNotice("Slug, name, and instructions are required.");
      return;
    }
    setBusy(true);
    setNotice(null);
    const config = {
      name,
      instructions,
      harness: form.harness.trim() || "opencode",
      ...(form.emoji.trim() ? { emoji: form.emoji.trim() } : {}),
      ...(form.codingModel.trim() ? { codingModel: form.codingModel.trim() } : {}),
      ...(form.connectionId.trim() ? { connectionId: form.connectionId.trim() } : {}),
      ...(form.sandboxProvider ? { sandboxProvider: form.sandboxProvider } : {}),
      ...(form.defaultRepoUrl.trim() ? { defaultRepoUrl: form.defaultRepoUrl.trim() } : {}),
    };
    try {
      const response = editingId
        ? await fetch(`/api/custom-agents/${encodeURIComponent(editingId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ config, expectedVersion }),
          })
        : await fetch("/api/custom-agents", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ slug, config }),
          });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setNotice(body.error ?? `Save failed (${response.status}).`);
      } else {
        setNotice(editingId ? "Agent updated." : "Agent created.");
        resetForm();
        refresh();
      }
    } catch {
      setNotice("Save failed: the backend could not be reached.");
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async (id: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/custom-agents/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setNotice(body.error ?? `Delete failed (${response.status}).`);
      } else {
        if (editingId === id) resetForm();
        refresh();
      }
    } catch {
      setNotice("Delete failed: the backend could not be reached.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[var(--bg)] text-[var(--fg)]">
      <div className="border-b border-[var(--border-1)] bg-[var(--panel)] px-4 lg:px-8 py-4 shrink-0">
        <h2 className="text-base font-semibold text-[var(--fg)]">Custom agents</h2>
        <p className="text-xs text-[var(--muted-foreground-2)]">
          Org-scoped agent profiles — harness, model, sandbox provider, and standing instructions. Pick one when you start a task or attach it to an automation.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="max-w-3xl mx-auto flex flex-col gap-4">
          {notice ? (
            <div className="text-xs font-mono text-[var(--warning-fg)] bg-[color-mix(in_oklch,var(--warning-fg)_10%,transparent)] border border-[color-mix(in_oklch,var(--warning-fg)_30%,transparent)] rounded-[var(--radius-button)] px-3 py-2">
              {notice}
            </div>
          ) : null}

          <div className="rounded-[var(--radius-button)] border border-[var(--border-2)] bg-[var(--card)] p-4 flex flex-col gap-2.5 shadow-[var(--sh-overlay)]">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold text-[var(--fg)]">
                {editingId ? "Edit agent" : "New agent"}
              </div>
              {editingId ? (
                <button type="button" onClick={resetForm} className="text-[11px] text-[var(--primary)]">
                  Cancel edit
                </button>
              ) : null}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                type="text"
                value={form.slug}
                disabled={Boolean(editingId)}
                onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                placeholder="slug — e.g. security-reviewer"
                aria-label="Agent slug"
                className={FIELD}
              />
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Display name"
                aria-label="Agent name"
                className={FIELD}
              />
            </div>
            <input
              type="text"
              value={form.emoji}
              onChange={(e) => setForm((f) => ({ ...f, emoji: e.target.value }))}
              placeholder="Emoji (optional)"
              aria-label="Agent emoji"
              className={FIELD}
            />
            <textarea
              value={form.instructions}
              onChange={(e) => setForm((f) => ({ ...f, instructions: e.target.value }))}
              placeholder="Standing instructions prepended to every run"
              aria-label="Agent instructions"
              rows={4}
              className={`${FIELD} resize-y min-h-[88px]`}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                type="text"
                value={form.harness}
                onChange={(e) => setForm((f) => ({ ...f, harness: e.target.value }))}
                placeholder="Harness — opencode"
                aria-label="Harness"
                className={FIELD}
              />
              <select
                value={form.sandboxProvider}
                onChange={(e) => setForm((f) => ({ ...f, sandboxProvider: e.target.value }))}
                aria-label="Sandbox provider"
                className={FIELD}
              >
                <option value="">Sandbox: org default</option>
                {SANDBOX_PROVIDERS.map((id) => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
            </div>
            <input
              type="url"
              value={form.defaultRepoUrl}
              onChange={(e) => setForm((f) => ({ ...f, defaultRepoUrl: e.target.value }))}
              placeholder="Default repo (optional)"
              aria-label="Default repository"
              className={`${FIELD} font-mono`}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void saveAgent()}
              className="self-start text-[11px] bg-[var(--primary-soft)] hover:bg-[var(--primary-soft)] border border-[var(--primary)]/15 text-[var(--primary)] font-medium py-1.5 px-3 rounded-[var(--radius-button)] transition-colors disabled:opacity-50"
            >
              {editingId ? "Save changes" : "Create agent"}
            </button>
          </div>

          {loadError ? <LoadErrorState message={loadError} onRetry={refresh} /> : null}

          {agents === null && !loadError ? (
            <div className="text-xs text-[var(--muted-foreground-2)]">Loading agents…</div>
          ) : null}

          {agents && agents.length === 0 ? (
            <div className="rounded-[var(--radius-button)] border border-dashed border-[var(--border-2)] bg-[var(--section)] p-6 text-center text-xs text-[var(--muted-foreground-2)]">
              No custom agents yet — create one above, then pick it in the task composer.
            </div>
          ) : null}

          {agents && agents.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {agents.map((agent) => (
                <li
                  key={agent.id}
                  className="rounded-[var(--radius-button)] border border-[var(--border-2)] bg-[var(--card)] px-4 py-3 flex items-start justify-between gap-3 shadow-[var(--sh-card)]"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[var(--fg)]">
                      {agent.config.emoji ? `${agent.config.emoji} ` : ""}
                      {agent.config.name}
                      <span className="text-[11px] font-mono text-[var(--muted-foreground-2)] ml-2">
                        {agent.slug}
                      </span>
                    </div>
                    <div className="text-[11px] text-[var(--muted-foreground-2)] mt-0.5 line-clamp-2">
                      {agent.config.instructions}
                    </div>
                    <div className="text-[10px] font-mono text-[var(--muted-foreground-3)] mt-1">
                      {agent.config.harness}
                      {agent.config.sandboxProvider ? ` · ${agent.config.sandboxProvider}` : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => startEdit(agent)}
                      className="text-[11px] border border-[var(--border-1)] px-2 py-1 rounded-[var(--radius-button)]"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteAgent(agent.id)}
                      className="text-[11px] border border-[var(--destructive)]/40 text-[var(--destructive)] px-2 py-1 rounded-[var(--radius-button)]"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Picker options for TaskComposer and automations. */
export function useCustomAgentOptions(): {
  agents: CustomAgentWire[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [agents, setAgents] = useState<CustomAgentWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    fetch("/api/custom-agents")
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return (await r.json()) as { agents?: CustomAgentWire[] };
      })
      .then((body) => {
        setAgents(body.agents ?? []);
        setError(null);
      })
      .catch(() => setError("unavailable"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  return { agents, loading, error, refresh };
}
