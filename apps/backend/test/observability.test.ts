import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { observabilityStatus, recordDashboardObservation, recordRunOutcome, reportError } from "../src/observability.js";

const enabled: Partial<Env> = {
  SHIBA_ERROR_REPORTING: "sentry", SENTRY_DSN: "https://publickey@errors.example.test/team/42",
  SHIBA_ANALYTICS: "posthog", POSTHOG_HOST: "https://analytics.example.test", POSTHOG_API_KEY: "project-key",
  SHIBA_OPEN_TELEMETRY: "1", OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://metrics.example.test/v1/metrics",
  OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20collector-key",
};
const env = (settings: Partial<Env> = {}) => settings as Env;
const setup = () => {
  const fetcher = vi.fn().mockImplementation(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("optional outbound observability", () => {
  it("is silent by default and credentials alone do not enable outbound traffic", async () => {
    const fetcher = setup();
    const credentials = env({ ...enabled, SHIBA_ERROR_REPORTING: undefined, SHIBA_ANALYTICS: undefined, SHIBA_OPEN_TELEMETRY: undefined });
    expect(observabilityStatus(env())).toEqual({ errors: false, analytics: false, metrics: false });
    await reportError(credentials, "worker", new Error("private prompt"));
    await recordRunOutcome(credentials, "completed");
    await recordDashboardObservation(credentials, { event: "dashboard.opened" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects invalid, non-HTTPS and incomplete destinations", async () => {
    const fetcher = setup();
    for (const bad of ["bad", "http://private.test", "https://user:pass@private.test", "https://private.test/?token=secret"]) {
      const settings = env({ ...enabled, SENTRY_DSN: bad, POSTHOG_HOST: bad, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: bad });
      expect(observabilityStatus(settings)).toEqual({ errors: false, analytics: false, metrics: false });
      await reportError(settings, "worker", new Error());
    }
    expect(observabilityStatus(env({ SHIBA_ANALYTICS: "posthog", SHIBA_ERROR_REPORTING: "sentry", SHIBA_OPEN_TELEMETRY: "1" })))
      .toEqual({ errors: false, analytics: false, metrics: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends a Sentry envelope with only fixed fields, not secrets, code or error context", async () => {
    const fetcher = setup();
    const privateError = Object.assign(new TypeError("alice@example.test prompt=private-code secret-value"), {
      name: "secret-name", cause: { authorization: "Bearer private-key" }, user: "alice",
    });
    privateError.stack = "at privateCustomerFunction (/repo/customer.ts:1:1)";
    await reportError(env(enabled), "worker", privateError);
    expect(fetcher).toHaveBeenCalledTimes(2); // Sentry error and OTLP counter, no analytics error autocapture.
    const sentry = fetcher.mock.calls.find(([url]) => String(url).includes("/envelope/"));
    expect(sentry).toBeDefined();
    if (!sentry) throw new Error("Missing Sentry envelope");
    const [url, request] = sentry;
    expect(String(url)).toBe("https://errors.example.test/team/api/42/envelope/");
    expect(request.headers["X-Sentry-Auth"]).toContain("sentry_key=publickey");
    const [header, item, payload] = request.body.split("\n").map((line: string) => line ? JSON.parse(line) : null);
    expect(header.event_id).toMatch(/^[a-f0-9]{32}$/);
    expect(item).toEqual({ type: "event", length: new TextEncoder().encode(request.body.split("\n")[2]).byteLength });
    expect(payload.exception.values).toEqual([{ type: "TypeError", value: "Shiba worker failure (details withheld)." }]);
    expect(payload.fingerprint).toEqual(["shiba", "worker", "error", "TypeError"]);
    const serialized = JSON.stringify(fetcher.mock.calls);
    for (const secret of ["alice", "private-code", "secret-value", "secret-name", "private-key", "customer.ts", "privateCustomerFunction"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("exports OTLP/HTTP delta lifecycle counters and anonymous PostHog events", async () => {
    const fetcher = setup();
    await recordRunOutcome(env(enabled), "completed");
    expect(fetcher).toHaveBeenCalledTimes(2);
    const posthog = fetcher.mock.calls.find(([url]) => String(url).includes("analytics"));
    if (!posthog) throw new Error("Missing PostHog event");
    expect(String(posthog[0])).toBe("https://analytics.example.test/i/v0/e/");
    const product = JSON.parse(posthog[1].body);
    expect(product).toMatchObject({ api_key: "project-key", event: "shiba.run.completed", properties: {
      source: "run", event: "run.completed", $process_person_profile: false, $geoip_disable: true,
    } });
    expect(product.properties.distinct_id).toMatch(/^[a-f0-9-]{36}$/);
    const otlp = fetcher.mock.calls.find(([url]) => String(url).includes("metrics"));
    if (!otlp) throw new Error("Missing OTLP metric");
    expect(otlp[1].headers.get("Authorization")).toBe("Bearer collector-key");
    const metric = JSON.parse(otlp[1].body).resourceMetrics[0].scopeMetrics[0].metrics[0];
    expect(metric).toMatchObject({ name: "shiba.lifecycle.events", sum: { aggregationTemporality: 1, isMonotonic: true } });
    expect(metric.sum.dataPoints[0]).toMatchObject({ asInt: "1", timeUnixNano: expect.stringMatching(/^\d{19}$/) });
    await recordRunOutcome(env(enabled), "completed");
    const products = fetcher.mock.calls.filter(([url]) => String(url).includes("analytics")).map(([, req]) => JSON.parse(req.body));
    expect(products[0].properties.distinct_id).not.toBe(products[1].properties.distinct_id);
  });

  it("reports run failures and dashboard failures but not normal outcomes to Sentry", async () => {
    const fetcher = setup();
    await recordRunOutcome(env(enabled), "failed");
    await recordRunOutcome(env(enabled), "cancelled");
    await recordDashboardObservation(env(enabled), { event: "dashboard.render_error" });
    await recordDashboardObservation(env(enabled), { event: "dashboard.opened" });
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("envelope"))).toHaveLength(2);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("analytics"))).toHaveLength(3);
  });

  it("bounds deliveries, refuses redirects, and never logs sensitive provider failures", async () => {
    const fetcher = setup().mockRejectedValue(new Error("collector-secret"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(reportError(env(enabled), "queue", "private exception")).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, request] of fetcher.mock.calls) {
      expect(request.redirect).toBe("error");
      expect(request.signal).toBeInstanceOf(AbortSignal);
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain("collector-secret");
    fetcher.mockResolvedValue(new Response("private collector response", { status: 429 }));
    await recordRunOutcome(env(enabled), "completed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private collector response");
  });

  it("isolates malformed exporter auth configuration from other adapters", async () => {
    const fetcher = setup();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await recordRunOutcome(env({ ...enabled, OTEL_EXPORTER_OTLP_HEADERS: "Authorization=%invalid" }), "completed");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("analytics");
  });

  it("does not reuse configuration across deployments in one isolate", async () => {
    const fetcher = setup();
    await recordRunOutcome(env(enabled), "completed");
    fetcher.mockClear();
    await recordRunOutcome(env(), "completed");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
