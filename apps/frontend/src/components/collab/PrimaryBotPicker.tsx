import { useState, type JSX } from "react";
import { teamWorkspaceHeaders } from "../../team-workspaces-client";

interface PrimaryBotResponse {
  actorId?: string | null;
  source?: "saved" | "default";
  error?: string;
}

/** Settings → Bots control. Loads the current primary bot only after the picker is opened. */
export function PrimaryBotPicker({
  workspaceId,
  agents,
}: {
  workspaceId: string;
  agents: { slug: string; name: string }[];
}): JSX.Element {
  const [actorId, setActorId] = useState("");
  const [source, setSource] = useState<"" | "saved" | "default">("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = async () => {
    if (loaded) return;
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/primary-bot`, {
        headers: teamWorkspaceHeaders(workspaceId),
        credentials: "same-origin",
        cache: "no-store",
      });
      const body = (await response.json().catch(() => ({}))) as PrimaryBotResponse;
      if (!response.ok) {
        setError(typeof body.error === "string" ? body.error : "Could not load the primary bot.");
        return;
      }
      setActorId(typeof body.actorId === "string" ? body.actorId : "");
      setSource(body.source === "saved" || body.source === "default" ? body.source : "default");
      setLoaded(true);
    } catch {
      setError("Could not load the primary bot.");
    }
  };

  const save = async (next: string) => {
    setActorId(next);
    setError("");
    if (!next) return;
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/primary-bot`, {
        method: "PUT",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", ...teamWorkspaceHeaders(workspaceId) },
        body: JSON.stringify({ actorId: next }),
      });
      const body = (await response.json().catch(() => ({}))) as PrimaryBotResponse;
      if (!response.ok) {
        setError(typeof body.error === "string" ? body.error : "Could not save the primary bot.");
        return;
      }
      setSource(body.source === "saved" ? "saved" : "default");
    } catch {
      setError("Could not save the primary bot.");
    }
  };

  return (
    <section aria-label="Primary bot" className="border border-[var(--line)] bg-[var(--card)] p-4">
      <label className="flex max-w-md flex-col gap-1 text-xs text-[var(--ink-2)]">
        Primary bot
        <select
          aria-label="Primary bot"
          value={actorId}
          onFocus={() => void load()}
          onChange={(event) => void save(event.target.value)}
          className="min-h-11 border border-[var(--line)] bg-[var(--card)] px-2 text-sm text-[var(--ink)]"
        >
          <option value="">Choose a bot</option>
          {agents.map((agent) => (
            <option key={agent.slug} value={`agent:${agent.slug}`}>
              {`Set ${agent.name} as primary`}
            </option>
          ))}
        </select>
      </label>
      {source === "default" ? (
        <p className="mt-2 text-xs text-[var(--ink-2)]">Using the earliest saved bot until you choose one.</p>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-xs">{error}</p> : null}
    </section>
  );
}
