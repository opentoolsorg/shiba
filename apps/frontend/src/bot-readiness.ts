import { useEffect, useState } from "react";
import { teamWorkspaceHeaders } from "./team-workspaces-client";

export type BotReadinessFixView = "providers" | "settings" | "custom-agents";

export interface BotReadinessProblem {
  id: string;
  severity: "error" | "warn";
  message: string;
  fix: { label: string; view: BotReadinessFixView };
}

export interface BotReadiness {
  ready: boolean;
  target: { kind: "repository"; repoUrl: string } | { kind: "artifact-workspace"; expectedDeliverables: string[] };
  harness: string;
  model: string;
  connectionId: string | null;
  synthetic: boolean;
  problems: BotReadinessProblem[];
}

export type BotReadinessState =
  | { status: "idle" | "loading" }
  | { status: "ready"; readiness: BotReadiness }
  | { status: "error"; error: string };

const FIX_VIEWS = new Set<BotReadinessFixView>(["providers", "settings", "custom-agents"]);

export class BotReadinessClient {
  constructor(private readonly workspaceId?: string) {}

  async load(agentId: string, signal?: AbortSignal): Promise<BotReadiness> {
    const response = await fetch(`/api/custom-agents/${encodeURIComponent(agentId)}/readiness`, {
      headers: teamWorkspaceHeaders(this.workspaceId),
      credentials: "same-origin",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`Bot readiness could not be checked (${response.status}).`);
    const body = (await response.json()) as { readiness?: unknown };
    const readiness = BotReadinessClient.parse(body.readiness);
    if (!readiness) throw new Error("The server returned an unreadable readiness report.");
    return readiness;
  }

  /** Untrusted wire data: drop fix links the dashboard cannot route to. */
  static parse(value: unknown): BotReadiness | null {
    if (typeof value !== "object" || value === null) return null;
    const record = value as Partial<BotReadiness>;
    const target = record.target;
    const validTarget = target?.kind === "repository"
      ? typeof target.repoUrl === "string"
      : target?.kind === "artifact-workspace" && Array.isArray(target.expectedDeliverables) &&
        target.expectedDeliverables.every((path) => typeof path === "string");
    if (typeof record.ready !== "boolean" || !target || !validTarget || !Array.isArray(record.problems)) return null;
    const problems = record.problems.filter((problem): problem is BotReadinessProblem =>
      typeof problem?.message === "string" && (problem.severity === "error" || problem.severity === "warn") &&
      typeof problem.fix?.label === "string" && FIX_VIEWS.has(problem.fix.view));
    return {
      ready: record.ready,
      target,
      harness: typeof record.harness === "string" ? record.harness : "",
      model: typeof record.model === "string" ? record.model : "",
      connectionId: typeof record.connectionId === "string" ? record.connectionId : null,
      synthetic: record.synthetic === true,
      problems,
    };
  }
}

/** Re-checks when the bot or its saved version changes, or when `refreshKey` bumps. */
export function useBotReadiness(agentId: string, version: number | undefined, workspaceId?: string, refreshKey = 0): BotReadinessState {
  const [state, setState] = useState<BotReadinessState>({ status: "idle" });
  // biome-ignore lint/correctness/useExhaustiveDependencies: version and refreshKey are deliberate re-check triggers.
  useEffect(() => {
    if (!agentId) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    new BotReadinessClient(workspaceId).load(agentId, controller.signal)
      .then((readiness) => { if (!controller.signal.aborted) setState({ status: "ready", readiness }); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", error: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, [agentId, version, workspaceId, refreshKey]);
  return state;
}
