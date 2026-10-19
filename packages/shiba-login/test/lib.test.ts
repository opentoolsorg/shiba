import { describe, expect, it } from "vitest";
import { completeRequestBody, parseListenTarget } from "../src/lib.js";

describe("parseListenTarget", () => {
  it("accepts 127.0.0.1 loopback redirect URIs", () => {
    const target = parseListenTarget("http://127.0.0.1:52841/auth/callback");
    expect(target).toEqual({ host: "127.0.0.1", port: 52841, pathname: "/auth/callback" });
  });

  it("rejects localhost", () => {
    expect(() => parseListenTarget("http://localhost:1/auth/callback")).toThrow(/127\.0\.0\.1/);
  });
});

describe("completeRequestBody", () => {
  it("matches the dashboard wire shape", () => {
    expect(JSON.parse(completeRequestBody("http://127.0.0.1:1/auth/callback?code=x"))).toEqual({
      callbackUrl: "http://127.0.0.1:1/auth/callback?code=x",
    });
  });
});
