import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleRuns, queueCollaborationRun } from "../src/runs-routes.js";

const seen = vi.hoisted(() => ({ name: "", body: null as Record<string, unknown> | null }));
vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: vi.fn(async () => true),
  resolveUserId: vi.fn(async () => "owner@example.test"),
}));
vi.mock("agents/routing", () => ({
  getAgentByName: vi.fn(async (namespace: { get(name: string): unknown }, name: string) => {
    seen.name = name;
    return namespace.get(name) as never;
  }),
}));

function fixture() {
  const env = {
    CodingOrchestrator: {
      get: () => ({
        fetch: async (request: Request) => {
          seen.body = (await request.json()) as Record<string, unknown>;
          return Response.json({ ok: true, approvalId: "approval-local" });
        },
      }),
    },
  } as unknown as Env;
  return env;
}

const sourceRequest = () =>
  new Request("https://worker.test/api/collaboration/rooms/room/handoffs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://worker.test",
      cookie: "session=local-test",
    },
    body: "{}",
  });

describe("collaboration queue profile pin", () => {
  it("uses the trusted membership version when creating a normal approval-gated run", async () => {
    seen.name = "";
    seen.body = null;
    const response = await queueCollaborationRun(sourceRequest(), fixture(), {
      task: "Inspect a repository",
      repoUrl: "https://github.com/example/repo",
      customAgentId: "cag-profile",
      profileVersion: 3,
      commandId: "room-handoff-123",
    });
    expect(response?.status).toBe(200);
    expect(seen.name).toBe("owner@example.test");
    expect(seen.body).toMatchObject({
      task: "Inspect a repository",
      repoUrl: "https://github.com/example/repo",
      customAgentId: "cag-profile",
      customAgentVersion: 3,
      commandId: "room-handoff-123",
      threadKey: "owner@example.test",
      orgId: "self-hosted",
    });
    expect(response && (await response.json())).toEqual({ ok: true, approvalId: "approval-local" });
  });

  it("drops a caller supplied profile version on the public run route", async () => {
    seen.name = "";
    seen.body = null;
    const request = new Request("https://worker.test/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://worker.test" },
      body: JSON.stringify({
        task: "Inspect a repository",
        repoUrl: "https://github.com/example/repo",
        customAgentId: "cag-profile",
        customAgentVersion: 999,
      }),
    });
    const response = await handleRuns(request, fixture());
    expect(response?.ok).toBe(true);
    expect(seen.body).not.toHaveProperty("customAgentVersion");
  });
});
