import type { DashboardObservation } from "@shiba/shared";
import type { Env } from "./env.js";

type ErrorSource = "worker" | "queue" | "scheduled" | "email";
type RunOutcome = "completed" | "failed" | "cancelled";
type Observation =
  | { event: "error"; source: ErrorSource; errorKind: string }
  | { event: `run.${RunOutcome}`; source: "run"; errorKind: "Error" }
  | { event: DashboardObservation["event"]; source: "dashboard"; errorKind: "Error" };

// Destinations are operator configuration, never taken from a request or event.
function httpsEndpoint(value: string | undefined): URL | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash ? url : null;
  } catch { return null; }
}

function sentryDestination(env: Env): { endpoint: URL; key: string } | null {
  if (env.SHIBA_ERROR_REPORTING !== "sentry" || !env.SENTRY_DSN) return null;
  try {
    const dsn = new URL(env.SENTRY_DSN.trim());
    if (dsn.protocol !== "https:" || !/^[a-zA-Z0-9]+$/.test(dsn.username) || dsn.password || dsn.search || dsn.hash ||
      !/^\/(?:[a-zA-Z0-9_-]+\/)*\d+$/.test(dsn.pathname)) return null;
    const key = dsn.username;
    dsn.username = "";
    const slash = dsn.pathname.lastIndexOf("/");
    dsn.pathname = `${dsn.pathname.slice(0, slash)}/api/${dsn.pathname.slice(slash + 1)}/envelope/`;
    return { endpoint: dsn, key };
  } catch { return null; }
}

function posthogDestination(env: Env): URL | null {
  if (env.SHIBA_ANALYTICS !== "posthog" || !env.POSTHOG_API_KEY?.trim()) return null;
  const host = httpsEndpoint(env.POSTHOG_HOST);
  if (!host) return null;
  host.pathname = `${host.pathname.replace(/\/$/, "")}/i/v0/e/`;
  return host;
}

function metricDestination(env: Env): URL | null {
  return env.SHIBA_OPEN_TELEMETRY === "1" ? httpsEndpoint(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) : null;
}

export function observabilityStatus(env: Env): { errors: boolean; analytics: boolean; metrics: boolean } {
  return { errors: sentryDestination(env) !== null, analytics: posthogDestination(env) !== null, metrics: metricDestination(env) !== null };
}

function otlpHeaders(value: string | undefined): Headers {
  const headers = new Headers();
  if (value?.trim()) {
    for (const entry of value.split(",")) {
      const separator = entry.indexOf("=");
      if (separator < 1) throw new Error("Invalid exporter headers");
      const key = entry.slice(0, separator).trim();
      if (!/^[a-zA-Z0-9_-]+$/.test(key) || /^(host|content-type|content-length)$/i.test(key)) throw new Error("Invalid exporter header");
      headers.set(key, decodeURIComponent(entry.slice(separator + 1).trim()));
    }
  }
  headers.set("Content-Type", "application/json");
  return headers;
}

async function deliver(provider: "sentry" | "posthog" | "otlp", endpoint: URL, body: string, headers: HeadersInit): Promise<void> {
  try {
    const response = await fetch(endpoint, {
      method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) console.warn(`Optional ${provider} delivery failed.`);
    await response.body?.cancel();
  } catch {
    // Never log collector responses, credentials, request data or error text.
    console.warn(`Optional ${provider} delivery failed.`);
  }
}

function attributes(values: Record<string, string>) {
  return Object.entries(values).map(([key, stringValue]) => ({ key, value: { stringValue } }));
}

async function emit(env: Env, observation: Observation): Promise<void> {
  try {
    const sentry = sentryDestination(env), posthog = posthogDestination(env), otlp = metricDestination(env);
    if (!sentry && !posthog && !otlp) return;
    const now = Date.now();
    const id = crypto.randomUUID();
    const tags = { source: observation.source, event: observation.event, schema: "1" };
    const release = env.CF_VERSION_METADATA?.id;
    const version = release && /^[a-f0-9-]{36}$/i.test(release) ? release : "unknown";
    const jobs: Promise<void>[] = [];
    const isError = observation.event === "error" || observation.event === "run.failed" || observation.event.startsWith("dashboard.") && observation.event !== "dashboard.opened";
    if (sentry && isError) {
      const eventId = id.replaceAll("-", "");
      const payload = JSON.stringify({
        event_id: eventId, timestamp: now / 1000, platform: "javascript", level: "error", release: version,
        environment: "self-hosted", tags,
        exception: { values: [{ type: observation.errorKind, value: `Shiba ${observation.source} failure (details withheld).` }] },
        fingerprint: ["shiba", observation.source, observation.event, observation.errorKind],
      });
      const envelope = `${JSON.stringify({ event_id: eventId, sent_at: new Date(now).toISOString() })}\n${JSON.stringify({ type: "event", length: new TextEncoder().encode(payload).byteLength })}\n${payload}\n`;
      jobs.push(deliver("sentry", sentry.endpoint, envelope, {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${sentry.key}, sentry_client=shiba/1`,
      }));
    }
    // Only explicit lifecycle events; never autocapture, profiles, URLs or stable user identifiers.
    if (posthog && (observation.source === "run" || observation.event === "dashboard.opened")) {
      jobs.push(deliver("posthog", posthog, JSON.stringify({
        api_key: env.POSTHOG_API_KEY, event: `shiba.${observation.event}`, timestamp: new Date(now).toISOString(),
        properties: { ...tags, release: version, distinct_id: id, $process_person_profile: false, $geoip_disable: true },
      }), { "Content-Type": "application/json" }));
    }
    if (otlp) {
      try {
        const headers = otlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS);
        jobs.push(deliver("otlp", otlp, JSON.stringify({ resourceMetrics: [{
          resource: { attributes: attributes({ "service.name": "shiba", "service.version": version }) },
          scopeMetrics: [{ scope: { name: "shiba.lifecycle", version: "1" }, metrics: [{
            name: "shiba.lifecycle.events", unit: "{event}",
            sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [{
              attributes: attributes(tags), asInt: "1",
              startTimeUnixNano: (BigInt(now - 1) * 1_000_000n).toString(), timeUnixNano: (BigInt(now) * 1_000_000n).toString(),
            }] },
          }] }],
        }] }), headers));
      } catch { console.warn("Optional otlp configuration is invalid."); }
    }
    await Promise.allSettled(jobs);
  } catch { console.warn("Optional observability delivery failed."); }
}

export function reportError(env: Env, source: ErrorSource, error: unknown): Promise<void> {
  const errorKind = error instanceof TypeError ? "TypeError" : error instanceof RangeError ? "RangeError" :
    error instanceof SyntaxError ? "SyntaxError" : "Error";
  return emit(env, { event: "error", source, errorKind });
}

export function recordRunOutcome(env: Env, outcome: RunOutcome): Promise<void> {
  return emit(env, { event: `run.${outcome}`, source: "run", errorKind: "Error" });
}

export function recordDashboardObservation(env: Env, observation: DashboardObservation): Promise<void> {
  return emit(env, { event: observation.event, source: "dashboard", errorKind: "Error" });
}
