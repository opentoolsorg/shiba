import { describe, expect, it, vi } from "vitest";
import { timeAuth, withRequestTiming, withTimingDatabase } from "../src/platform/request-timing.js";

const request = () => new Request("https://example.test/api/test");

describe("request timing", () => {
  it("merges existing metrics and preserves a streaming body", async () => {
    const original = new Response("stream", { headers: { "Server-Timing": "cache;dur=2" } });
    const response = await withRequestTiming(request(), async () => {
      await timeAuth(async () => null);
      return original;
    });
    expect(response).toBe(original);
    expect(response.headers.get("Server-Timing")).toMatch(/^cache;dur=2, total;dur=\d+, auth;dur=\d+, db;dur=0;desc="n=0"$/);
    expect(await response.text()).toBe("stream");
  });

  it("copies immutable headers and preserves redirects", async () => {
    const response = await withRequestTiming(request(), async () => Response.redirect("https://example.test/next"));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://example.test/next");
    expect(response.headers.get("Server-Timing")).toContain("auth;dur=0");
  });

  it("retains the Worker socket when copying immutable response headers", async () => {
    const original = Response.redirect("https://example.test/next");
    const socket = {} as WebSocket;
    Object.defineProperty(original, "webSocket", { value: socket });
    const NativeResponse = Response;
    class WorkerResponse extends NativeResponse {
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        super(body, init);
        Object.defineProperty(this, "webSocket", { value: init?.webSocket });
      }
    }
    vi.stubGlobal("Response", WorkerResponse);
    try {
      const response = await withRequestTiming(request(), async () => original);
      expect(response.webSocket).toBe(socket);
      expect(response.headers.get("Server-Timing")).toContain("total;dur=");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not change non-API responses", async () => {
    const original = new Response("static");
    expect(await withRequestTiming(new Request("https://example.test/app/"), async () => original)).toBe(original);
    expect(original.headers.has("Server-Timing")).toBe(false);
  });

  it("keeps D1 and environment proxies stable, counts executions, and isolates concurrent requests", async () => {
    const executed: string[] = [];
    const statement = {
      bind() { expect(this).toBe(statement); return statement; },
      async first() { expect(this).toBe(statement); executed.push("first"); return { ok: true }; },
      async all() { executed.push("all"); return { results: [] }; },
      async run() { executed.push("run"); return { success: true }; },
    };
    const database = {
      prepare() { expect(this).toBe(database); return statement; },
      async batch(batch: unknown[]) { expect(this).toBe(database); expect(batch).toEqual([statement]); executed.push("batch"); return []; },
    } as unknown as D1Database;
    const env = { AGENT_AUDIT: database };
    const timed = withTimingDatabase(env);
    expect(withTimingDatabase(env)).toBe(timed);
    expect(timed.AGENT_AUDIT).toBe(timed.AGENT_AUDIT);
    const [busy, idle] = await Promise.all([
      withRequestTiming(request(), async () => {
        const prepared = timed.AGENT_AUDIT.prepare("SELECT 1").bind(1);
        await prepared.first();
        await prepared.all();
        await prepared.run();
        await timed.AGENT_AUDIT.batch([prepared]);
        return new Response("busy");
      }),
      withRequestTiming(request(), async () => new Response("idle")),
    ]);
    expect(busy.headers.get("Server-Timing")).toContain('desc="n=4"');
    expect(idle.headers.get("Server-Timing")).toContain('desc="n=0"');
    expect(executed).toEqual(["first", "all", "run", "batch"]);
  });
});
