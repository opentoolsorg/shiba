import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleObservability } from "../src/observability-routes.js";

const env = {
  SHIBA_ERROR_REPORTING: "sentry", SENTRY_DSN: "https://publickey@errors.example.test/1",
  SHIBA_ANALYTICS: "posthog", POSTHOG_HOST: "https://analytics.example.test", POSTHOG_API_KEY: "never-public",
} as Env;
const req = (body: string, headers: HeadersInit = {}) => new Request("http://localhost/api/observability", {
  method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/json", ...headers }, body,
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("dashboard observability ingress", () => {
  it("requires authentication and discloses booleans only", async () => {
    const denied = await handleObservability(new Request("https://public.example/api/observability"), env);
    expect(denied?.status).toBe(401);
    const status = await handleObservability(new Request("http://localhost/api/observability"), env);
    expect(status?.headers.get("Cache-Control")).toBe("no-store");
    expect(await status?.json()).toEqual({ errors: true, analytics: true, metrics: false });
    expect(await handleObservability(new Request("http://localhost/api/other"), env)).toBeNull();
  });

  it("accepts fixed events, rejects arbitrary fields and streamed oversized bodies", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal("fetch", fetcher);
    const pending: Promise<unknown>[] = [];
    const response = await handleObservability(req('{"event":"dashboard.render_error"}'), env,
      { waitUntil: (job: Promise<unknown>) => pending.push(job) } as unknown as ExecutionContext);
    expect(response?.status).toBe(204);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const body of ['{"event":"dashboard.render_error","message":"private"}', '{"event":"private prompt"}', "[]", "bad"]) {
      expect((await handleObservability(req(body), env))?.status).toBe(400);
    }
    expect((await handleObservability(req(JSON.stringify({ event: "dashboard.opened", data: "x".repeat(257) })), env))?.status).toBe(413);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-origin events, form posts and unsupported methods", async () => {
    expect((await handleObservability(req("{}", { Origin: "https://evil.example" }), env))?.status).toBe(403);
    expect((await handleObservability(req("{}", { "Sec-Fetch-Site": "cross-site" }), env))?.status).toBe(403);
    expect((await handleObservability(req("{}", { "Content-Type": "text/plain" }), env))?.status).toBe(415);
    expect((await handleObservability(new Request("http://localhost/api/observability", { method: "DELETE" }), env))?.status).toBe(405);
  });

  it("rate limits accepted events and keeps disabled deployments silent", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const limited = { ...env, MCP_RATE_LIMIT: { limit: async () => ({ success: false }) } } as Env;
    expect((await handleObservability(req('{"event":"dashboard.opened"}'), limited))?.status).toBe(429);
    expect((await handleObservability(req('{"event":"dashboard.opened"}'), {} as Env))?.status).toBe(204);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
