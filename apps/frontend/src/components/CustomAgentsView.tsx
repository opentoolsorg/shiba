import { useCallback, useEffect, useState, type JSX, type KeyboardEvent } from "react";
import { LoadErrorState } from "./LoadErrorState";
import { EmptyState, PageHeader, SkeletonLines, StatusNotice } from "./surface";

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
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
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
      setNotice({ tone: "err", text: "Slug, name, and instructions are required." });
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
      const body = (await response.json().catch(() => ({}))) as { error?: string; agent?: CustomAgentWire };
      if (!response.ok || !body.agent) {
        setNotice({ tone: "err", text: body.error ?? `Save failed (${response.status}).` });
      } else {
        const saved = body.agent;
        setAgents((current) => {
          const rest = (current ?? []).filter((agent) => agent.id !== saved.id);
          return [saved, ...rest];
        });
        setNotice({ tone: "ok", text: editingId ? "Agent updated." : "Agent created." });
        resetForm();
        refresh();
      }
    } catch {
      setNotice({ tone: "err", text: "Save failed: the backend could not be reached." });
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
        setNotice({ tone: "err", text: body.error ?? `Delete failed (${response.status}).` });
      } else {
        setAgents((current) => (current ?? []).filter((agent) => agent.id !== id));
        setConfirmDeleteId(null);
        if (editingId === id) resetForm();
        setNotice({ tone: "ok", text: "Agent deleted." });
        refresh();
      }
    } catch {
      setNotice({ tone: "err", text: "Delete failed: the backend could not be reached." });
    } finally {
      setBusy(false);
    }
  };

  const onFormKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void saveAgent();
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[var(--bg)] text-[var(--fg)]">
      <PageHeader
        title="Custom agents"
        detail="Profiles for this workspace: harness, sandbox, and the instructions prepended to every run."
      />

      <div className="flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="max-w-3xl mx-auto flex flex-col gap-4">
          {notice ? <StatusNotice tone={notice.tone}>{notice.text}</StatusNotice> : null}

          <form
            className="border border-[var(--border-2)] bg-[var(--card)] p-4 flex flex-col gap-3 shadow-[var(--sh-card)]"
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault();
              void saveAgent();
            }}
            onKeyDown={onFormKeyDown}
          >
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                Slug
                <input
                  type="text"
                  value={form.slug}
                  disabled={Boolean(editingId)}
                  onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                  placeholder="security-reviewer"
                  className={FIELD}
                />
              </label>
              <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                Name
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Security reviewer"
                  className={FIELD}
                />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
              Mark
              <input
                type="text"
                value={form.emoji}
                onChange={(e) => setForm((f) => ({ ...f, emoji: e.target.value }))}
                placeholder="Optional short mark"
                className={FIELD}
              />
            </label>
            <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
              Instructions
              <textarea
                value={form.instructions}
                onChange={(e) => setForm((f) => ({ ...f, instructions: e.target.value }))}
                placeholder="Standing instructions prepended to every run"
                rows={4}
                className={`${FIELD} resize-y min-h-[88px]`}
              />
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                Harness
                <input
                  type="text"
                  value={form.harness}
                  onChange={(e) => setForm((f) => ({ ...f, harness: e.target.value }))}
                  className={FIELD}
                />
              </label>
              <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                Sandbox
                <select
                  value={form.sandboxProvider}
                  onChange={(e) => setForm((f) => ({ ...f, sandboxProvider: e.target.value }))}
                  className={FIELD}
                >
                  <option value="">Org default</option>
                  {SANDBOX_PROVIDERS.map((id) => (
                    <option key={id} value={id}>{id}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
              Default repository
              <input
                type="url"
                value={form.defaultRepoUrl}
                onChange={(e) => setForm((f) => ({ ...f, defaultRepoUrl: e.target.value }))}
                placeholder="https://github.com/owner/repo"
                className={`${FIELD} font-mono`}
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="self-start text-[11px] bg-[var(--primary)] text-[var(--primary-text)] font-medium py-1.5 px-3 shadow-[var(--sh-plate)] transition-colors disabled:opacity-50"
            >
              {busy ? "Saving…" : editingId ? "Save changes" : "Create agent"}
            </button>
          </form>

          {loadError ? <LoadErrorState message={loadError} onRetry={refresh} /> : null}

          {agents === null && !loadError ? (
            <div role="status" aria-busy="true" aria-label="Loading agents">
              <SkeletonLines rows={4} />
            </div>
          ) : null}

          {agents && agents.length === 0 ? (
            <EmptyState
              title="No custom agents"
              detail="Create one above, then pick it in the task composer or on an automation."
            />
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
                      className="text-[11px] border border-[var(--border-1)] px-2 py-1"
                    >
                      Edit
                    </button>
                    {confirmDeleteId === agent.id ? (
                      <button
                        type="button"
                        onClick={() => void deleteAgent(agent.id)}
                        className="text-[11px] border border-[var(--destructive)]/40 text-[var(--destructive)] px-2 py-1"
                      >
                        Confirm delete
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(agent.id)}
                        className="text-[11px] border border-[var(--destructive)]/40 text-[var(--destructive)] px-2 py-1"
                      >
                        Delete
                      </button>
                    )}
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
