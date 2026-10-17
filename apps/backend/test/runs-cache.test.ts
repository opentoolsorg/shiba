import { describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ ok: true }));
vi.mock("agents/routing", () => ({
  // Immutable headers, like a real stub.fetch response: set() throws.
  getAgentByName: async () => ({
    fetch: async () => {
      const res = Response.json({ runs: [{ runId: "r1" }] }, { status: 202 });
      const headers = new Headers(res.headers);
      headers.set = () => {
        throw new TypeError("Can't modify immutable headers.");
      };
      Object.defineProperty(res, "headers", { value: headers });
      return res;
    },
  }),
  routeAgentRequest: async () => null,
}));
vi.mock("../src/request-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/request-auth.js")>()),
  isAuthorizedRequest: async () => auth.ok,
  resolveUserId: async () => "devin",
}));

import type { Env } from "../src/env.js";
import { handleRuns } from "../src/runs-routes.js";

const env = { CodingOrchestrator: {} } as unknown as Env;

describe("handleRuns cache-control", () => {
  it.each(["/api/runs", "/api/spine"])("%s responses carry no-store with status and body unchanged", async (path) => {
    auth.ok = true;
    const res = await handleRuns(new Request(`https://shiba.test${path}`), env);
    expect(res?.headers.get("cache-control")).toBe("no-store");
    expect(res?.status).toBe(202);
    expect(await res?.json()).toEqual({ runs: [{ runId: "r1" }] });
  });

  it.each([
    ["401 auth gate", false, new Request("https://shiba.test/api/runs"), 401],
    ["405 method", true, new Request("https://shiba.test/api/runs", { method: "PUT" }), 405],
    ["400 invalid session", true, new Request("https://shiba.test/api/runs?session=not-a-uuid"), 400],
  ])("worker-generated %s carries no-store", async (_label, ok, request, status) => {
    auth.ok = ok;
    const res = await handleRuns(request, env);
    expect(res?.status).toBe(status);
    expect(res?.headers.get("cache-control")).toBe("no-store");
  });

  it("leaves unrelated paths to other handlers", async () => {
    expect(await handleRuns(new Request("https://shiba.test/api/other"), env)).toBeNull();
  });
});
