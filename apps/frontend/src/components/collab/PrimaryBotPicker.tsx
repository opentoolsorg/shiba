import { useEffect, useRef, useState, type JSX } from "react";
import { teamWorkspaceHeaders, teamWorkspaceRequest } from "../../team-workspaces-client";

interface PrimaryBotResponse {
  actorId: string | null;
  source: "saved" | "default";
}

export function PrimaryBotPicker(props: {
  workspaceId: string;
  agents: { slug: string; name: string }[];
}): JSX.Element {
  return <WorkspacePrimaryBotPicker key={props.workspaceId} {...props} />;
}

function WorkspacePrimaryBotPicker({ workspaceId, agents }: {
  workspaceId: string;
  agents: { slug: string; name: string }[];
}): JSX.Element {
  const [actorId, setActorId] = useState("");
  const [source, setSource] = useState<"" | "saved" | "default">("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const pending = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/primary-bot`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt retries a failed load.
  useEffect(() => {
    const request = new AbortController();
    controller.current = request;
    void (async () => {
      try {
        const body = await teamWorkspaceRequest<PrimaryBotResponse>(path, {
          signal: request.signal,
          headers: teamWorkspaceHeaders(workspaceId),
        });
        if (request.signal.aborted) return;
        setActorId(body.actorId ?? "");
        setSource(body.source);
        setLoaded(true);
      } catch (cause) {
        if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load the primary bot.");
      } finally {
        if (!request.signal.aborted) {
          pending.current = false;
          setBusy(false);
        }
      }
    })();
    return () => controller.current?.abort();
  }, [path, workspaceId, attempt]);

  const save = async (next: string) => {
    if (!loaded || pending.current || !next || next === actorId || !agents.some((agent) => `agent:${agent.slug}` === next)) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const request = new AbortController();
    controller.current = request;
    try {
      const body = await teamWorkspaceRequest<PrimaryBotResponse>(path, {
        method: "PUT",
        signal: request.signal,
        headers: teamWorkspaceHeaders(workspaceId),
        body: JSON.stringify({ actorId: next }),
      });
      if (request.signal.aborted) return;
      setActorId(body.actorId ?? "");
      setSource(body.source);
    } catch (cause) {
      if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not save the primary bot.");
    } finally {
      if (!request.signal.aborted) {
        pending.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <section aria-label="Primary bot" className="border border-[var(--line)] bg-[var(--card)] p-4">
      <label className="flex max-w-md flex-col gap-1 text-xs text-[var(--ink-2)]">
        Primary bot
        <select
          aria-label="Primary bot"
          aria-busy={busy}
          disabled={!loaded || busy}
          value={actorId}
          onChange={(event) => void save(event.target.value)}
          className="min-h-11 border border-[var(--line)] bg-[var(--card)] px-2 text-sm text-[var(--ink)]"
        >
          <option value="" disabled>Choose a bot</option>
          {actorId && !agents.some((agent) => `agent:${agent.slug}` === actorId) ? (
            <option value={actorId} disabled>Current primary bot (unavailable)</option>
          ) : null}
          {agents.map((agent) => (
            <option key={agent.slug} value={`agent:${agent.slug}`}>
              {`Set ${agent.name} as primary`}
            </option>
          ))}
        </select>
      </label>
      {busy ? <p role="status" className="mt-2 text-xs">{loaded ? "Saving primary bot…" : "Loading primary bot…"}</p> : null}
      {source === "default" ? (
        <p className="mt-2 text-xs text-[var(--ink-2)]">Using the earliest saved bot until you choose one.</p>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-xs">{error}</p> : null}
      {error && !loaded && !busy ? (
        <button type="button" className="mt-2 min-h-11 text-sm underline" onClick={() => {
          pending.current = true;
          setBusy(true);
          setError("");
          setAttempt((value) => value + 1);
        }}>Retry loading primary bot</button>
      ) : null}
    </section>
  );
}
