/**
 * Live deployment status reads shared by the Integrations, Settings, and
 * Analytics surfaces. Every hook settles to an explicit state — data, an
 * error, or "route dark" — so a panel reports what the deployment proves
 * and never renders optimistic state.
 */

import type { AuthSnapshot, OutboxEntry, SpineEvent } from "@shiba/shared";
import { MAX_SPINE_EVENTS } from "@shiba/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentPrincipal, InboxMailbox } from "./types";

/** Wire shape of `GET /api/setup/status` (backend `setup-status.ts`). Booleans only. */
export interface SetupStatus {
  slack: { signingSecret: boolean; botToken: boolean; approvers: number; channelRepos: boolean };
  github: { token: boolean; app: boolean; publish: boolean; webhookSecret: boolean };
  linear: { webhookSecret: boolean; apiToken: boolean; defaultRepo: boolean };
  slackVerification: { signingSecret: boolean };
  gateway: { id: string; token: boolean; reachable: "yes" | "unauthorized" | "error" | "unknown" };
  access: { required: boolean };
  betterAuth: { configured: boolean };
  models: { orchestrator: string; coding: string; harness: string; roles: RoleModelWire[] };
  automations: { enabled: boolean; typeSafe: boolean };
  mailbox: { addressOverride: boolean; sendEnabled: boolean };
  doctor: SetupDoctorWire;
}

export interface SetupDoctorWire {
  ok: boolean;
  checkedAt: number;
  findings: { id: string; severity: "ok" | "warn" | "error"; message: string; fix?: string }[];
  roles: {
    role: string;
    harness: string;
    model: string;
    connectionId: string | null;
    ok: boolean;
    message?: string;
    fix?: string;
  }[];
}

/**
 * One `models.roles[]` entry — the backend's RoleModelStatus
 * (agents/roles.ts) served verbatim. `source` says which env layer the
 * resolved pair came from; `error` marks a broken pin.
 */
export interface RoleModelWire {
  role: string;
  source: "dashboard" | "role-map" | "role-env" | "connection-default" | "default";
  connectionId?: string;
  harness: string;
  model: string;
  error?: string;
}

/**
 * Wire shape of one `agents[]` entry from `GET /api/agents` — the backend's
 * AgentCliInfo (harness/catalog.ts) served verbatim. Projected locally: the
 * dashboard must not import `apps/backend` sources.
 */
export interface AgentCliEntry {
  id: string;
  label: string;
  binary: string;
  version: string;
  defaultModel: string;
  credential: {
    kind: "ai-gateway-byok" | "worker-secret" | "oauth-signin";
    label: string;
    /** true = secret present, false = missing, null = not introspectable. */
    configured: boolean | null;
    setupHint: string | null;
  };
  docsUrl: string;
}

export interface AgentsDirectory {
  agents: AgentCliEntry[];
  principals: AgentPrincipal[];
}

/** One fetch's settled state: still in flight, failed, or carrying data. */
export type LoadState<T> =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "data"; data: T };

function useApiJson<T>(path: string, enabled = true): {
  state: LoadState<T>;
  reload: () => void;
  /** True while a fetch is in flight — pollers must wait for it to settle. */
  inFlight: boolean;
} {
  const [state, setState] = useState<LoadState<T>>({ kind: "loading" });
  const [inFlight, setInFlight] = useState(enabled);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setInFlight(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 12_000);
    let cancelled = false;
    setInFlight(true);
    void fetch(path, { credentials: "same-origin", signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`GET ${path} failed: ${response.status}`);
        const body = (await response.json()) as T;
        if (body === null || typeof body !== "object") {
          throw new Error(`GET ${path} did not return a JSON object.`);
        }
        if (!cancelled) setState({ kind: "data", data: body });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const aborted = error instanceof DOMException && error.name === "AbortError";
        setState({
          kind: "error",
          message: aborted
            ? `GET ${path} timed out. Retry.`
            : error instanceof Error
              ? error.message
              : String(error),
        });
      })
      .finally(() => {
        window.clearTimeout(timer);
        if (!cancelled) setInFlight(false);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [path, attempt, enabled]);
  const reload = useCallback(() => {
    setInFlight(true);
    setAttempt((n) => n + 1);
  }, []);
  return { state, reload, inFlight };
}

export function useSetupStatus(): {
  state: LoadState<SetupStatus>;
  reload: () => void;
  inFlight: boolean;
} {
  return useApiJson<SetupStatus>("/api/setup/status");
}

export function useAgentsDirectory(): {
  state: LoadState<AgentsDirectory>;
  reload: () => void;
  inFlight: boolean;
} {
  return useApiJson<AgentsDirectory>("/api/agents");
}

/** GET /api/whoami — the dashboard's signed-in identity and which auth lane proved it. */
export interface WhoamiWire {
  agent: string;
  auth?: "better-auth" | "access" | "none";
}

export function useWhoami(): {
  state: LoadState<WhoamiWire>;
  reload: () => void;
  inFlight: boolean;
} {
  return useApiJson<WhoamiWire>("/api/whoami");
}

export function useMailboxes(): {
  state: LoadState<{ mailboxes: InboxMailbox[] }>;
  reload: () => void;
} {
  return useApiJson<{ mailboxes: InboxMailbox[] }>("/api/mailboxes");
}

/**
 * Wire shape of `GET /api/usage` — daily aggregates over the retained run
 * store plus the deployment's optional daily budget. Every token/cost field
 * is optional: the backend only reports what harnesses emitted, so an
 * absent field means "not reported", not zero.
 */
export interface UsageGroupWire {
  harness: string | null;
  provider: string | null;
  role: string | null;
  runs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface UsageDayWire {
  date: string;
  runs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  groups: UsageGroupWire[];
}

export interface UsageReportWire {
  generatedAt: number;
  timezone: string;
  budgetUsd: number | null;
  days: UsageDayWire[];
}

export function useUsageReport(
  sessionId: string,
  sessionApiAvailable: boolean,
): { state: LoadState<UsageReportWire>; reload: () => void; inFlight: boolean } {
  const path = sessionApiAvailable
    ? `/api/usage?session=${encodeURIComponent(sessionId)}`
    : "/api/usage";
  return useApiJson<UsageReportWire>(path);
}

// ---------------------------------------------------------------------------
// Activity report (GET /api/activity)
// ---------------------------------------------------------------------------

/** One KPI's current-vs-previous window; null = the backend has no data for it. */
export interface ActivityMetricWire {
  now: number | null;
  last: number | null;
}

/** Wire shape of `GET /api/activity` — workspace activity aggregates. */
export interface ActivityReportWire {
  generatedAt: number;
  period: { from: number; to: number };
  previous: { from: number; to: number };
  projects: string[];
  members: string[];
  metrics: {
    contribution: ActivityMetricWire;
    issuesDetected: ActivityMetricWire;
    prsContributed: ActivityMetricWire;
    prsMerged: ActivityMetricWire;
    feedbackLoops: ActivityMetricWire;
    agentHours: ActivityMetricWire;
  };
  /** UTC days oldest-first across the trailing 52-week window. */
  contribution: { date: string; count: number }[];
  pullRequests: {
    total: { date: string; count: number }[];
    byMember: { member: string; count: number }[];
  };
}

/** Filters for the activity report; `project`/`member` are omitted when unset. */
export interface ActivityReportQuery {
  days?: number;
  from?: number;
  to?: number;
  runtime: "all" | "cloud" | "local";
  project?: string;
  member?: string;
}

export function useActivityReport(
  sessionId: string,
  sessionApiAvailable: boolean,
  query: ActivityReportQuery,
): { state: LoadState<ActivityReportWire>; reload: () => void; inFlight: boolean } {
  const params = new URLSearchParams();
  if (query.from !== undefined && query.to !== undefined) {
    params.set("from", String(query.from));
    params.set("to", String(query.to));
  } else {
    params.set("days", String(query.days ?? 30));
  }
  params.set("runtime", query.runtime);
  if (query.project) params.set("project", query.project);
  if (query.member) params.set("member", query.member);
  if (sessionApiAvailable) params.set("session", sessionId);
  return useApiJson<ActivityReportWire>(`/api/activity?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Model config (Project 4 — purpose-aware model routing) + spine (P9)
// ---------------------------------------------------------------------------

/** Wire shape of one `connections[]` entry — the ModelConfig DO's record. */
export interface ModelConnectionWire {
  id: string;
  service: string;
  displayName: string;
  status: "unconfigured" | "ready" | "invalid" | "disabled";
  credentialRef: string | null;
  lastCheckedAt?: number | null;
}

/** Wire shape of the purpose policy — purpose → Workers AI model id. */
export interface PurposePolicyWire {
  version: number;
  models: Partial<Record<string, string>>;
  rolePins?: Partial<Record<string, { harness: string; model?: string }>>;
  updatedAt: number;
}

export interface ModelConfigWire {
  connections: ModelConnectionWire[];
  connectionOrder: string[];
  policy: PurposePolicyWire;
  purposes: string[];
  effectiveRoles?: RoleModelWire[];
}

export function useModelConfig(): {
  state: LoadState<ModelConfigWire>;
  reload: () => void;
  inFlight: boolean;
} {
  return useApiJson<ModelConfigWire>("/api/model-config");
}

/** One ready connection as the coding-model picker lists it (app.tsx). */
export interface ConnectionOption {
  id: string;
  label: string;
  service: string;
  status: ModelConnectionWire["status"];
}

/**
 * Only `ready` connections feed the coding pickers — an unverified or
 * disabled credential path must not offer models the run can't pay for.
 */
export function readyConnectionOptions(connections: ModelConnectionWire[]): ConnectionOption[] {
  return connections
    .filter((c) => c.status === "ready")
    .map((c) => ({
      id: c.id,
      label: `${c.displayName} · ${c.service}`,
      service: c.service,
      status: c.status,
    }));
}

/**
 * Offer only models the backend would accept: the provider namespace must
 * have a ready connection — and match the selected one when one is picked.
 * No ready connection means no filter (the catalog is still informative).
 */
export function codingModelOptions(
  models: string[],
  connections: ConnectionOption[],
  connectionId: string,
): string[] {
  const selected = connections.find((c) => c.id === connectionId);
  const allowedProviders = new Set((selected ? [selected] : connections).map((c) => c.service));
  return [
    ...new Set(
      allowedProviders.size === 0
        ? models
        : models.filter((m) => allowedProviders.has(m.slice(0, m.indexOf("/")))),
    ),
  ];
}

/** One spine event — the orchestrator's durable decision record (P9). */
export type SpineEventWire = Omit<SpineEvent, "kind" | "payload"> & {
  /** Loose on purpose: the renderer must tolerate kinds newer than this build. */
  kind: string;
  payload?: Record<string, unknown>;
};

/** One outbox row — a side effect the orchestrator owes. */
export type OutboxEntryWire = OutboxEntry;

export interface SpineWire {
  events: SpineEventWire[];
  outbox: OutboxEntryWire[];
  /** Log-window markers the since-parameterized route adds. */
  earliestSeq?: number;
  latestSeq?: number;
  totalEvents?: number;
}

/**
 * Spine poller with an incremental cursor: after the first snapshot it
 * asks for `?since=<last seen seq>` and merges by seq — the route used
 * to resend the whole retained log every 5s. The accumulated buffer
 * lives outside render state so an error-then-recover poll keeps the
 * history it already had; a rotated log (earliestSeq past the cursor)
 * forces a full resync.
 */
export function useSpine(
  sessionId: string,
  sessionApiAvailable: boolean,
): { state: LoadState<SpineWire>; reload: () => void; inFlight: boolean } {
  const base = sessionApiAvailable
    ? `/api/spine?session=${encodeURIComponent(sessionId)}`
    : "/api/spine";
  const [state, setState] = useState<LoadState<SpineWire>>({ kind: "loading" });
  const [inFlight, setInFlight] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const buffer = useRef<{ base: string; seq: number | null; events: SpineEventWire[] }>({
    base,
    seq: null,
    events: [],
  });
  useEffect(() => {
    // A new session target owns a different log — the cursor can't cross it.
    if (buffer.current.base !== base) buffer.current = { base, seq: null, events: [] };
    const since = buffer.current.seq;
    const path = since === null ? base : `${base}${base.includes("?") ? "&" : "?"}since=${since}`;
    let cancelled = false;
    setInFlight(true);
    void fetch(path)
      .then(async (response) => {
        if (!response.ok) throw new Error(`GET ${path} failed: ${response.status}`);
        return (await response.json()) as SpineWire;
      })
      .then((body) => {
        if (cancelled) return;
        if (since !== null && body.earliestSeq !== undefined && body.earliestSeq > since + 1) {
          // The server pruned past the cursor — merging would leave a
          // gap; drop it and let the next fetch resync from the tail.
          buffer.current = { base, seq: null, events: [] };
          setAttempt((n) => n + 1);
          return;
        }
        const latest =
          body.latestSeq ??
          (body.events.length > 0 ? body.events[body.events.length - 1]!.seq : (since ?? 0));
        const seen = new Set(buffer.current.events.map((event) => event.seq));
        buffer.current = {
          base,
          seq: latest,
          events: [
            ...buffer.current.events,
            ...body.events.filter((event) => !seen.has(event.seq)),
          ].slice(-MAX_SPINE_EVENTS),
        };
        setState({ kind: "data", data: { ...body, events: buffer.current.events } });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setInFlight(false);
      });
    return () => {
      cancelled = true;
    };
  }, [base, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload, inFlight };
}
