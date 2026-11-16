import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { checkAnthropicCredential } from "../src/provider-credential-check.js";

const env = {} as Env;
const token = "synthetic-credential-for-tests";

beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => {}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Anthropic credential check", () => {
  it.each([200, 401, 403, 503, "network", "timeout"] as const)(
    "uses the Worker fetch redirect policy for %s",
    async (outcome) => {
      const workerFetch = vi.fn<typeof fetch>(async (_url, init) => {
        if (init?.redirect !== "follow" && init?.redirect !== "manual") {
          throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
        }
        if (outcome === "network") return Promise.reject(new Error(token));
        if (outcome === "timeout") return Promise.reject(new DOMException(token, "TimeoutError"));
        return Promise.resolve(new Response("{}", { status: outcome }));
      });
      vi.stubGlobal("fetch", workerFetch);
      const result = await checkAnthropicCredential(env, token, "setup-token");
      expect(workerFetch).toHaveBeenCalledOnce();
      expect(workerFetch.mock.calls[0]?.[1]?.redirect).toBe("manual");
      if (outcome === 200) {
        expect(result).toEqual({ ok: true });
      } else {
        expect(result).toMatchObject({
          ok: false,
          reason: outcome === 401 || outcome === 403 ? "rejected" : "unreachable",
        });
      }
      expect(JSON.stringify(result)).not.toContain(token);
      expect(console.info).toHaveBeenCalledTimes(typeof outcome === "number" ? 1 : 0);
      if (typeof outcome === "number") {
        expect(console.info).toHaveBeenCalledWith("Anthropic credential check", `${Math.floor(outcome / 100)}xx`);
      }
    },
  );

  it.each(["setup-token", "api-key"] as const)("uses the right headers for %s", async (kind) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}"));
    expect(await checkAnthropicCredential(env, token, kind, fetchImpl)).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.anthropic.com/v1/models?limit=1");
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    const headers = new Headers(init?.headers);
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("authorization")).toBe(kind === "setup-token" ? `Bearer ${token}` : null);
    expect(headers.get("anthropic-beta")).toBe(kind === "setup-token" ? "oauth-2025-04-20" : null);
    expect(headers.get("x-api-key")).toBe(kind === "api-key" ? token : null);
  });

  it.each([401, 403, 429, 500, 503, 302, 400])("handles HTTP %s without exposing credentials", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(token, { status }));
    const result = await checkAnthropicCredential(env, token, "setup-token", fetchImpl);
    expect(result).toEqual({
      ok: false,
      reason: status === 401 || status === 403 ? "rejected" : "unreachable",
      message: status === 401 || status === 403
        ? "Anthropic rejected this token. Run claude setup-token again and paste the new token."
        : "Couldn't reach Anthropic to check the token. Try again in a minute.",
    });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it.each(["authentication_error", "permission_error"])("recognizes a JSON %s on HTTP 400", async (type) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({
      type: "error", error: { type, message: token },
    }, { status: 400 }));
    expect(await checkAnthropicCredential(env, token, "setup-token", fetchImpl)).toEqual({
      ok: false,
      reason: "rejected",
      message: "Anthropic rejected this token. Run claude setup-token again and paste the new token.",
    });
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(token);
  });

  it.each([429, 500, 503])("keeps HTTP %s retryable even with a JSON auth error", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({
      type: "error", error: { type: "authentication_error", message: token },
    }, { status }));
    expect(await checkAnthropicCredential(env, token, "setup-token", fetchImpl)).toMatchObject({
      ok: false, reason: "unreachable",
    });
  });

  it("does not expose a network error containing the token", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error(token); });
    const result = await checkAnthropicCredential(env, token, "setup-token", fetchImpl);
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("aborts after five seconds and returns an unreachable result", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    try {
      const fetchImpl = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error("Expected an abort signal");
        signal.addEventListener("abort", () => reject(signal.reason));
      }));
      const checking = checkAnthropicCredential(env, token, "setup-token", fetchImpl);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(timeout).toHaveBeenCalledWith(5_000);
      expect(await checking).toMatchObject({ ok: false, reason: "unreachable" });
    } finally {
      timeout.mockRestore();
    }
  });
});
