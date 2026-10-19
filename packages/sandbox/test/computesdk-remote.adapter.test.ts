import { describe, expect, it } from "vitest";
import { createComputesdkRemoteClient } from "../src/adapters/computesdk-remote.js";

describe("computesdk remote client", () => {
  it("proxies exec to runner HTTP API", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith("/v1/instances") && init?.method === "POST") {
        return new Response(JSON.stringify({ instanceId: "i-1", provider: "fake" }), { status: 200 });
      }
      if (url.includes("/exec")) {
        return new Response(JSON.stringify({ stdout: "ok", stderr: "", exitCode: 0 }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };
    const client = createComputesdkRemoteClient({
      baseUrl: "http://runner.test",
      token: "t",
      backendProvider: "e2b",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const instance = await client.instances.create();
    const result = await instance.runCommand("echo hi");
    expect(result.stdout).toBe("ok");
    expect(calls.some((c) => c.includes("/exec"))).toBe(true);
  });
});
