import { useEffect, useState } from "react";

export interface FirstRunSeedResult {
  workspaceId: string | null;
  createdWorkspace: boolean;
  createdAgents: string[];
}

const doneKey = (actorId: string) => `shiba:first-run-seed:${encodeURIComponent(actorId)}`;
const inFlight = new Map<string, Promise<FirstRunSeedResult | null>>();

function seededThisSession(actorId: string): boolean {
  try {
    return sessionStorage.getItem(doneKey(actorId)) === "1";
  } catch {
    return false;
  }
}

/** Resolves null when the server declines (e.g. invited/read-only member): nothing to seed, not an error. */
export function ensureFirstRunSeed(actorId: string): Promise<FirstRunSeedResult | null> {
  const pending = inFlight.get(actorId);
  if (pending) return pending;
  const request = (async () => {
    const response = await fetch("/api/first-run-seed", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
    });
    const body = (await response.json().catch(() => ({}))) as Partial<FirstRunSeedResult> & {
      error?: unknown;
    };
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok)
      throw new Error(
        typeof body.error === "string"
          ? body.error
          : `First-run setup failed (${response.status}).`,
      );
    try {
      sessionStorage.setItem(doneKey(actorId), "1");
    } catch {
      /* Storage is optional. */
    }
    return {
      workspaceId: body.workspaceId ?? null,
      createdWorkspace: body.createdWorkspace === true,
      createdAgents: body.createdAgents ?? [],
    };
  })().finally(() => inFlight.delete(actorId));
  inFlight.set(actorId, request);
  return request;
}

/** Runs the idempotent seed once per browser session per actor; pass enabled=false for read-only or signed-out users. */
export function useFirstRunSeed({
  actorId,
  enabled,
}: {
  actorId: string | null;
  enabled: boolean;
}) {
  const scope = enabled && actorId ? actorId.trim().toLowerCase() : "";
  const [state, setState] = useState<{
    scope: string;
    seeding: boolean;
    error: string | null;
    result: FirstRunSeedResult | null;
  }>({ scope: "", seeding: false, error: null, result: null });
  useEffect(() => {
    if (!scope || seededThisSession(scope)) return;
    let current = true;
    setState({ scope, seeding: true, error: null, result: null });
    ensureFirstRunSeed(scope).then(
      (result) => {
        if (current) setState({ scope, seeding: false, error: null, result });
      },
      (cause: unknown) => {
        if (current)
          setState({
            scope,
            seeding: false,
            error: cause instanceof Error ? cause.message : "First-run setup failed.",
            result: null,
          });
      },
    );
    return () => {
      current = false;
    };
  }, [scope]);
  return state.scope === scope && scope
    ? { seeding: state.seeding, error: state.error, result: state.result }
    : { seeding: false, error: null, result: null };
}
