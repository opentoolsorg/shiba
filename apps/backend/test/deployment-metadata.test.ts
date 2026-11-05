import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";

vi.mock("@cloudflare/sandbox", () => ({ Sandbox: class {}, ContainerProxy: class {}, proxyToSandbox: async () => null, getSandbox: vi.fn() }));
vi.mock("agents/routing", () => ({ routeAgentRequest: async () => null }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/agents/orchestrator.js", () => ({ CodingOrchestrator: class {} }));

import worker from "../src/index.js";

const versionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const revision = "a".repeat(40);
const metadata = { id: versionId, tag: revision, timestamp: "2026-11-05T00:00:00.000Z" };
const fixture = (value: Env["CF_VERSION_METADATA"] = metadata) => ({ CF_VERSION_METADATA: value }) as Env;

describe("authenticated deployment revision metadata", () => {
  it("reports only the platform version and exact Git tag", async () => {
    const response = await worker.fetch(new Request("http://localhost/api/setup/deployment", {
      headers: { "X-Git-Revision": "b".repeat(40), "X-Worker-Version": "forged" },
    }), fixture());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ versionId, revision });
  });

  it.each([undefined, { ...metadata, tag: "preview" }, { ...metadata, tag: "A".repeat(40) }, { ...metadata, id: "unverified" }])(
    "fails closed without an exact platform revision (%s)", async (value) => {
      const env = fixture();
      env.CF_VERSION_METADATA = value;
      const response = await worker.fetch(new Request("http://localhost/api/setup/deployment"), env);
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ code: "deployment_revision_unavailable" });
    },
  );

  it("does not expose revision metadata through an anonymous or forged public identity", async () => {
    for (const forged of [false, true]) {
      const headers = new Headers();
      if (forged) headers.set("CF-Access-Authenticated-User-Email", "owner@example.test");
      const response = await worker.fetch(new Request("https://preview.example.test/api/setup/deployment", { headers }), fixture());
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(revision);
    }
  });

  it("rejects methods that could be mistaken for deployment mutation", async () => {
    const response = await worker.fetch(new Request("http://localhost/api/setup/deployment", { method: "POST" }), fixture());
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
  });
});
