import { describe, expect, it, beforeEach } from "vitest";
import {
  handleDevOAuthLoopback,
  resetDevOAuthLoopbackForTests,
} from "../src/dev-oauth-loopback-routes.js";
import type { Env } from "../src/env.js";

const env = {} as Env;

function req(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

beforeEach(() => {
  resetDevOAuthLoopbackForTests();
});

describe("handleDevOAuthLoopback", () => {
  it("accepts loopback POST on localhost and returns callbacks on GET", async () => {
    const callback = "http://127.0.0.1:51121/callback?code=abc&state=xyz";
    const post = await handleDevOAuthLoopback(
      req("http://127.0.0.1:8788/api/dev/oauth-loopback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: callback }),
      }),
      env,
    );
    expect(post?.status).toBe(200);
    const get = await handleDevOAuthLoopback(req("http://127.0.0.1:8788/api/dev/oauth-loopback?since=0"), env);
    expect(get?.status).toBe(200);
    const body = (await get?.json()) as { callbacks: { id: number; url: string }[] };
    expect(body.callbacks).toHaveLength(1);
    expect(body.callbacks[0]?.url).toBe(callback);
  });

  it("is hidden off loopback hosts", async () => {
    const res = await handleDevOAuthLoopback(
      req("https://shiba.example/api/dev/oauth-loopback", { method: "POST", body: "{}" }),
      env,
    );
    expect(res?.status).toBe(404);
  });

  it("rejects invalid callback URLs", async () => {
    const res = await handleDevOAuthLoopback(
      req("http://127.0.0.1:8788/api/dev/oauth-loopback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://evil.example/callback" }),
      }),
      env,
    );
    expect(res?.status).toBe(400);
  });
});
