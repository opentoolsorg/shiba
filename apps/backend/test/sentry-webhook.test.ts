/**
 * `/api/sentry/webhook` — signature verification, event-id dedupe, and the
 * approval-gated queue handoff. Mirrors the GitHub webhook posture: verify
 * first, dedupe before queue, fail closed on a dedupe outage.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  proxyToSandbox: async () => null,
  getSandbox: () => ({ destroy: async () => {} }),
}));
vi.mock("agents/routing", () => ({
  getAgentByName: async () => ({ fetch: async () => new Response("{}", { status: 404 }) }),
  routeAgentRequest: async () => null,
}));
vi.mock("@cloudflare/think", () => ({ Think: class {
  onStart() {}
  getTools() { return {}; }
  onRequest() { return new Response(null, { status: 404 }); }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: vi.fn() }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

import worker from "../src/index.js";
import type { Env } from "../src/env.js";

const SECRET = "sentry-test-secret";

const ISSUE_ALERT = JSON.stringify({
  id: "evt-1",
  data: {
    issue: {
      id: "issue-9",
      title: "TypeError: undefined is not a function",
      shortId: "SHIBA-9",
      permalink: "https://sentry.io/organizations/acme/issues/9/",
    },
    event: {
      event_id: "evt-1",
      exception: {
        values: [
          {
            type: "TypeError",
            value: "undefined is not a function",
            stacktrace: {
              frames: [
                { function: "boot", filename: "src/boot.ts", lineno: 3 },
                { function: "main", filename: "src/main.ts", lineno: 42 },
              ],
            },
          },
        ],
      },
    },
  },
});

async function signSentry(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Harness {
  env: Env;
  stubFetch: ReturnType<typeof vi.fn>;
  queueBodies: () => Promise<{ repoUrl?: string; task?: string; eventId?: string }[]>;
}

function makeHarness(opts: { dedupeError?: boolean; queueStatus?: number } = {}): Harness {
  const seenKeys = new Set<string>();
  const stubFetch = vi.fn(async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/internal/dedupe") {
      if (opts.dedupeError) throw new Error("dedupe DO unreachable");
      const { key } = (await request.json()) as { key: string };
      const seen = seenKeys.has(key);
      seenKeys.add(key);
      return Response.json({ seen });
    }
    if (path === "/internal/sentry") {
      return Response.json({ ok: true, approvalId: "appr_1" }, { status: opts.queueStatus ?? 200 });
    }
    return new Response("{}", { status: 200 });
  });
  const env = {
    SENTRY_WEBHOOK_SECRET: SECRET,
    SENTRY_REPO_URL: "https://github.com/acme/widgets",
    Sandbox: {},
    Automations: {
      idFromName: () => "automations",
      get: () => ({ fetch: stubFetch }),
    },
  } as unknown as Env;
  return {
    env,
    stubFetch,
    queueBodies: async () =>
      Promise.all(
        stubFetch.mock.calls
          .map((call) => call[0] as Request)
          .filter((req) => new URL(req.url).pathname === "/internal/sentry")
          .map((req) => req.json() as Promise<{ repoUrl?: string; task?: string; eventId?: string }>),
      ),
  };
}

function sentryRequest(
  harness: Harness,
  opts: { payload?: string; signature?: string | null; token?: string | null; method?: string } = {},
) {
  const payload = opts.payload ?? ISSUE_ALERT;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const method = opts.method ?? "POST";
  const build = async () => {
    const sig = opts.signature === undefined ? await signSentry(payload) : opts.signature;
    if (sig) headers["sentry-hook-signature"] = sig;
    if (opts.token) headers["x-sentry-token"] = opts.token;
    return worker.fetch(
      new Request("https://worker/api/sentry/webhook", {
        method,
        headers,
        ...(method === "GET" || method === "HEAD" ? {} : { body: payload }),
      }),
      harness.env,
      { waitUntil: () => {} } as unknown as ExecutionContext,
    );
  };
  return build();
}

describe("sentry webhook intake", () => {
  it("queues an approval-gated fix run on a valid signature", async () => {
    const h = makeHarness();
    const res = await sentryRequest(h);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, approvalId: "appr_1" });
    const bodies = await h.queueBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.repoUrl).toBe("https://github.com/acme/widgets");
    expect(bodies[0]?.task).toContain("TypeError: undefined is not a function");
    expect(bodies[0]?.task).toContain("https://sentry.io/organizations/acme/issues/9/");
    expect(bodies[0]?.task).toContain("at main (src/main.ts:42)");
    expect(bodies[0]?.eventId).toBe("evt-1");
  });

  it("accepts the x-sentry-token shared-secret header", async () => {
    const h = makeHarness();
    const res = await sentryRequest(h, { signature: null, token: SECRET });
    expect(res.status).toBe(200);
    expect(await h.queueBodies()).toHaveLength(1);
  });

  it("rejects a bad signature and queues nothing", async () => {
    const h = makeHarness();
    const res = await sentryRequest(h, { signature: "deadbeef" });
    expect(res.status).toBe(401);
    expect(await h.queueBodies()).toHaveLength(0);
  });

  it("rejects a request with no signature and no token", async () => {
    const h = makeHarness();
    const res = await sentryRequest(h, { signature: null });
    expect(res.status).toBe(401);
    expect(await h.queueBodies()).toHaveLength(0);
  });

  it("dedupes a retried event id", async () => {
    const h = makeHarness();
    const first = await sentryRequest(h);
    expect(first.status).toBe(200);
    const second = await sentryRequest(h);
    expect(await second.json()).toEqual({ ok: true, deduped: true });
    expect(await h.queueBodies()).toHaveLength(1);
  });

  it("fails closed (503) when the dedupe endpoint errors", async () => {
    const h = makeHarness({ dedupeError: true });
    const res = await sentryRequest(h);
    expect(res.status).toBe(503);
    expect(await h.queueBodies()).toHaveLength(0);
  });

  it("503s when the webhook secret is unset", async () => {
    const h = makeHarness();
    (h.env as { SENTRY_WEBHOOK_SECRET?: string }).SENTRY_WEBHOOK_SECRET = "";
    const res = await sentryRequest(h);
    expect(res.status).toBe(503);
  });

  it("acknowledges non-issue payloads without queueing", async () => {
    const h = makeHarness();
    const res = await sentryRequest(h, { payload: JSON.stringify({ action: "created", data: {} }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(await h.queueBodies()).toHaveLength(0);
  });

  it("503s when no repository is configured or carried", async () => {
    const h = makeHarness();
    (h.env as { SENTRY_REPO_URL?: string }).SENTRY_REPO_URL = "";
    const res = await sentryRequest(h);
    expect(res.status).toBe(503);
    expect(await h.queueBodies()).toHaveLength(0);
  });

  it("rejects a non-POST method", async () => {
    const h = makeHarness();
    const res = await sentryRequest(h, { method: "GET" });
    expect([404, 405]).toContain(res.status);
  });
});
