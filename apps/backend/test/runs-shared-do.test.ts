import { describe, expect, it, vi } from "vitest";

// Per-DO run stores: the caller's own DO, another user's DO, and the shared
// "default" DO that automations / review / Sentry runs queue on (P7 #4).
const stores = vi.hoisted(() => ({
  runs: {} as Record<string, Array<{ runId: string; createdAt: number }>>,
  user: "op@example.com",
}));
vi.mock("agents/routing", () => ({
  getAgentByName: async (_ns: unknown, name: string) => ({
    fetch: async (input: Request | string) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      const runs = stores.runs[name] ?? [];
      const id = url.pathname.match(/^\/api\/runs\/([^/]+)$/)?.[1];
      if (id) {
        const run = runs.find((r) => r.runId === decodeURIComponent(id));
        return run ? Response.json({ run }) : Response.json({ error: "Run not found." }, { status: 404 });
      }
      const limit = url.searchParams.get("limit");
      return Response.json({ runs: limit ? runs.slice(-Number(limit)).reverse() : runs });
    },
  }),
  routeAgentRequest: async () => null,
}));
vi.mock("../src/request-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/request-auth.js")>()),
  isAuthorizedRequest: async () => true,
  resolveUserId: async () => stores.user,
}));

import type { Env } from "../src/env.js";
import { handleRuns } from "../src/runs-routes.js";

const env = (approvers?: string) =>
  ({ CodingOrchestrator: {}, DASHBOARD_APPROVERS: approvers }) as unknown as Env;

stores.runs = {
  "op@example.com": [{ runId: "mine", createdAt: 2 }],
  "other@example.com": [{ runId: "theirs", createdAt: 3 }],
  default: [
    { runId: "automation", createdAt: 1 },
    { runId: "review", createdAt: 4 },
  ],
};

async function list(path: string, e: Env): Promise<string[]> {
  const res = await handleRuns(new Request(`https://shiba.test${path}`), e);
  const body = (await res!.json()) as { runs: Array<{ runId: string }> };
  return body.runs.map((r) => r.runId);
}

describe("GET /api/runs reads the shared default DO", () => {
  it("merges default-DO runs for a dashboard approver, oldest first", async () => {
    stores.user = "op@example.com";
    expect(await list("/api/runs", env("op@example.com"))).toEqual(["automation", "mine", "review"]);
  });

  it("keeps the bounded listing newest-first and capped", async () => {
    stores.user = "op@example.com";
    expect(await list("/api/runs?limit=2", env("op@example.com"))).toEqual(["review", "mine"]);
  });

  it("falls back to the default DO for run detail", async () => {
    stores.user = "op@example.com";
    const res = await handleRuns(new Request("https://shiba.test/api/runs/automation"), env("op@example.com"));
    expect(res?.status).toBe(200);
    expect(((await res!.json()) as { run: { runId: string } }).run.runId).toBe("automation");
  });

  it("never shows shared or other users' runs to a non-approver", async () => {
    stores.user = "other@example.com";
    expect(await list("/api/runs", env("op@example.com"))).toEqual(["theirs"]);
    const res = await handleRuns(new Request("https://shiba.test/api/runs/automation"), env("op@example.com"));
    expect(res?.status).toBe(404);
  });

  it("does not merge into a session-scoped listing", async () => {
    stores.user = "op@example.com";
    const session = crypto.randomUUID();
    expect(await list(`/api/runs?session=${session}`, env("op@example.com"))).toEqual([]);
  });
});
